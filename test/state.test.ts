import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJobs, resolveJob, upsertJob, updateJob } from "../src/state.js";
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

test("resolveJob accepts exact ids and unique prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-state-test-"));
  await upsertJob(root, makeJob("abcdef", root));
  assert.equal((await resolveJob(root, "abc")).id, "abcdef");
  await upsertJob(root, makeJob("abc999", root));
  await assert.rejects(() => resolveJob(root, "abc"), /Ambiguous job/);
});
