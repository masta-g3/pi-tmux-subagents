import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyState } from "../src/migration.js";
import { loadJobs } from "../src/state.js";
import type { TmuxExecutor } from "../src/tmux.js";
import type { TmuxSubagentJob } from "../src/types.js";

function agentRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-tmux-migration-test-"));
}

function job(id: string, root: string, tmuxSession = `pi-tmux-subagent-${id}`): TmuxSubagentJob {
  return {
    id,
    agentName: "scout",
    taskPreview: "Task",
    cwd: root,
    tmuxSession,
    status: "starting",
    resultPath: join(root, "jobs", id, "result.md"),
    createdAt: 1,
    updatedAt: 1,
  };
}

async function writeRegistry(root: string, jobs: TmuxSubagentJob[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "jobs.json"), `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, "utf8");
}

test("migrateLegacyState moves default root, rewrites jobs and renames live tmux sessions", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const newRoot = join(agent, "pi-tmux-subagents");
  const oldJob = job("abcdef123456", oldRoot);
  await writeRegistry(oldRoot, [oldJob]);
  await mkdir(join(oldRoot, "jobs", oldJob.id), { recursive: true });
  await writeFile(join(oldRoot, "jobs", oldJob.id, "metadata.json"), `${JSON.stringify({ job: oldJob, agent: { name: "scout" } }, null, 2)}\n`, "utf8");

  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "has-session" && args[2] === `pi-tmux-subagents-${oldJob.id}`) {
      throw Object.assign(new Error("missing"), { stderr: "can't find session" });
    }
    return { stdout: "", stderr: "" };
  };

  const summary = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent }, tmux });

  assert.deepEqual(summary.migratedRoot, { from: oldRoot, to: newRoot });
  assert.equal(existsSync(newRoot), true);
  assert.equal(lstatSync(oldRoot).isSymbolicLink(), true);
  const migrated = (await loadJobs(newRoot)).jobs[0]!;
  assert.equal(migrated.resultPath, join(newRoot, "jobs", oldJob.id, "result.md"));
  assert.equal(migrated.tmuxSession, `pi-tmux-subagents-${oldJob.id}`);
  const metadata = JSON.parse(await readFile(join(newRoot, "jobs", oldJob.id, "metadata.json"), "utf8"));
  assert.equal(metadata.job.resultPath, migrated.resultPath);
  assert.equal(metadata.job.tmuxSession, migrated.tmuxSession);
  assert.ok(calls.some((args) => args[0] === "rename-session" && args[2] === oldJob.tmuxSession && args[3] === migrated.tmuxSession));
});

test("migrateLegacyState skips default migration for explicit state roots", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const explicitRoot = join(agent, "custom-state");
  await writeRegistry(oldRoot, [job("legacy", oldRoot)]);
  await writeRegistry(explicitRoot, [job("explicit", explicitRoot)]);

  const summary = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent, PI_TMUX_SUBAGENTS_DIR: explicitRoot }, tmux: async () => ({ stdout: "", stderr: "" }) });

  assert.equal(summary.migratedRoot, undefined);
  assert.equal(existsSync(oldRoot), true);
  assert.equal((await loadJobs(explicitRoot)).jobs[0]?.id, "explicit");
});

test("migrateLegacyState is idempotent and does not overwrite when both roots exist", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const newRoot = join(agent, "pi-tmux-subagents");
  await writeRegistry(oldRoot, [job("legacy", oldRoot)]);
  await writeRegistry(newRoot, [job("current", newRoot)]);

  const first = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent }, tmux: async () => ({ stdout: "", stderr: "" }) });
  const second = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent }, tmux: async () => ({ stdout: "", stderr: "" }) });

  assert.equal((await loadJobs(newRoot)).jobs[0]?.id, "current");
  assert.equal(lstatSync(oldRoot).isDirectory(), true);
  assert.ok(first.warnings.some((warning) => warning.includes("legacy state root still exists")));
  assert.ok(second.warnings.some((warning) => warning.includes("legacy state root still exists")));
});

test("migrateLegacyState keeps conflicted live tmux session names", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const newRoot = join(agent, "pi-tmux-subagents");
  const oldJob = job("conflict123", oldRoot);
  await writeRegistry(oldRoot, [oldJob]);

  const summary = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent }, tmux: async () => ({ stdout: "", stderr: "" }) });

  const migrated = (await loadJobs(newRoot)).jobs[0]!;
  assert.equal(migrated.tmuxSession, oldJob.tmuxSession);
  assert.ok(summary.warnings.some((warning) => warning.includes("new-exists")));
});

test("migrateLegacyState keeps legacy tmux session when tmux lookup fails", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const newRoot = join(agent, "pi-tmux-subagents");
  const oldJob = job("lookupfail", oldRoot);
  await writeRegistry(oldRoot, [oldJob]);

  const summary = await migrateLegacyState({
    env: { PI_CODING_AGENT_DIR: agent },
    tmux: async (args) => {
      if (args[0] === "has-session") throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      return { stdout: "", stderr: "" };
    },
  });

  const migrated = (await loadJobs(newRoot)).jobs[0]!;
  assert.equal(migrated.resultPath, join(newRoot, "jobs", oldJob.id, "result.md"));
  assert.equal(migrated.tmuxSession, oldJob.tmuxSession);
  assert.ok(summary.warnings.some((warning) => warning.includes("spawn tmux ENOENT")));
});

test("migrateLegacyState keeps mirrored tmux names and rewrites mirror result paths", async () => {
  const agent = agentRoot();
  const oldRoot = join(agent, "tmux-subagents");
  const newRoot = join(agent, "pi-tmux-subagents");
  const sessionsDir = join(agent, "pi-sessions");
  const mirrored = job("mirror123456", oldRoot, "pi-sessions-mirror123456");
  await writeRegistry(oldRoot, [mirrored]);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "registry.json"), `${JSON.stringify({
    version: 1,
    sessions: [
      { id: mirrored.id, title: "scout", cwd: oldRoot, group: "default", tmuxSession: mirrored.tmuxSession, status: "running", resultPath: mirrored.resultPath, createdAt: 1, updatedAt: 1 },
    ],
  }, null, 2)}\n`, "utf8");

  const summary = await migrateLegacyState({ env: { PI_CODING_AGENT_DIR: agent, PI_SESSIONS_DIR: sessionsDir }, tmux: async () => ({ stdout: "", stderr: "" }) });

  const migrated = (await loadJobs(newRoot)).jobs[0]!;
  assert.equal(migrated.tmuxSession, mirrored.tmuxSession);
  assert.equal(migrated.resultPath, join(newRoot, "jobs", mirrored.id, "result.md"));
  const registry = JSON.parse(await readFile(join(sessionsDir, "registry.json"), "utf8"));
  assert.equal(registry.sessions[0].tmuxSession, mirrored.tmuxSession);
  assert.equal(registry.sessions[0].resultPath, migrated.resultPath);
  assert.equal(summary.rewrittenMirrorRows, 1);
});
