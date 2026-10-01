import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJobs, resolveJob, upsertJob, updateJob, withStateLock } from "../src/state.js";
import type { TmuxSubagentJob } from "../src/types.js";

function makeJob(id: string, root: string): TmuxSubagentJob {
  return {
    id,
    agentName: "scout",
    taskPreview: "Task",
    cwd: root,
    tmuxSession: `pi-tmux-subagents-${id}`,
    status: "starting",
    resultPath: join(root, "jobs", id, "result.md"),
    createdAt: 1,
    updatedAt: 1,
  };
}

test("upsertJob and updateJob persist jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-test-"));
  await upsertJob(root, makeJob("abcdef", root));
  await updateJob(root, "abcdef", (job) => ({ ...job, status: "running", updatedAt: 2 }));

  const jobs = await loadJobs(root);
  assert.equal(jobs.version, 1);
  assert.equal(jobs.jobs[0]?.status, "running");
});

test("state lock recovers an abandoned empty directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "jobs.lock");
  await mkdir(lock);
  await utimes(lock, new Date(0), new Date(0));
  await withStateLock(root, async () => {
    assert.equal((await readdir(lock)).length, 1);
  });
  await assert.rejects(() => readdir(lock), { code: "ENOENT" });
});

test("state lock recovers a crashed process owner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { withStateLock } from ${JSON.stringify(new URL("../src/state.js", import.meta.url).href)};
    await withStateLock(${JSON.stringify(root)}, async () => process.exit(0));
  `], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const ownerFiles = await readdir(join(root, "jobs.lock"));
  assert.equal(ownerFiles.length, 1);
  await Promise.all(Array.from({ length: 8 }, () => withStateLock(root, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
  })));
  await assert.rejects(() => readdir(join(root, "jobs.lock")), { code: "ENOENT" });
});

test("state lock preserves a live owner even when its directory is old", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  let entered!: () => void;
  const holding = withStateLock(root, async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
  });
  // Wait for publication before trying another writer.
  const ready = new Promise<void>(resolve => { entered = resolve; });
  await ready;
  const lock = join(root, "jobs.lock");
  await utimes(lock, new Date(0), new Date(0));
  const owners = await readdir(lock);
  let secondEntered = false;
  const waiting = withStateLock(root, async () => { secondEntered = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondEntered, false);
    assert.deepEqual(await readdir(lock), owners);
  } finally {
    release();
    await Promise.all([holding, waiting]);
  }
  assert.equal(secondEntered, true);
});

test("state lock serializes competing writers recovering an abandoned lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "jobs.lock"));
  await utimes(join(root, "jobs.lock"), new Date(0), new Date(0));
  await Promise.all(Array.from({ length: 20 }, (_, i) => upsertJob(root, makeJob(`job-${i}`, root))));
  assert.equal((await loadJobs(root)).jobs.length, 20);
});

test("state lock serializes writers in separate processes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "jobs.lock"));
  await utimes(join(root, "jobs.lock"), new Date(0), new Date(0));
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { withStateLock, loadJobs, saveJobs } from ${JSON.stringify(new URL("../src/state.js", import.meta.url).href)};
      await withStateLock(${JSON.stringify(root)}, async () => {
        const registry = await loadJobs(${JSON.stringify(root)});
        await new Promise(resolve => setTimeout(resolve, 10));
        registry.jobs.push(${JSON.stringify(makeJob(`process-${i}`, root))});
        await saveJobs(${JSON.stringify(root)}, registry);
      });
    `], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
  }));
  assert.equal((await loadJobs(root)).jobs.length, 8);
  assert.deepEqual(await readdir(root), ["jobs.json"]);
});

test("state lock refuses unknown lock contents and cleans up its candidate", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "jobs.lock");
  await mkdir(lock);
  await writeFile(join(lock, "unknown-owner"), "keep");
  await utimes(lock, new Date(0), new Date(0));
  await assert.rejects(() => withStateLock(root, async () => assert.fail("must not acquire")), /Timed out waiting for state lock/);
  assert.deepEqual(await readdir(lock), ["unknown-owner"]);
  assert.deepEqual(await readdir(root), ["jobs.lock"]);
});

test("state lock releases after a failed mutation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => withStateLock(root, async () => { throw new Error("mutation failed"); }), /mutation failed/);
  await withStateLock(root, async () => {});
});

test("resolveJob accepts exact ids and unique prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-test-"));
  await upsertJob(root, makeJob("abcdef", root));
  assert.equal((await resolveJob(root, "abc")).id, "abcdef");
  await upsertJob(root, makeJob("abc999", root));
  await assert.rejects(() => resolveJob(root, "abc"), /Ambiguous job/);
});
