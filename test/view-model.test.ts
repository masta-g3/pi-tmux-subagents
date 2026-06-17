import assert from "node:assert/strict";
import test from "node:test";
import { groupCountSummary, sortSubagentRows, toSubagentViewRows } from "../src/view-model.js";
import type { SubagentStatusResult } from "../src/types.js";

function status(overrides: Partial<SubagentStatusResult> = {}): SubagentStatusResult {
  return {
    status: "running",
    job: {
      id: "child-1234567890",
      agentName: "scout",
      displayName: "scout-auth",
      taskPreview: "Inspect auth",
      cwd: "/repo",
      tmuxSession: "pi-tmux-subagents-child",
      status: "running",
      resultPath: "/tmp/jobs/child-123/result.md",
      createdAt: 1_000,
      updatedAt: 2_000,
    },
    heartbeat: { jobId: "child-1234567890", cwd: "/repo", state: "running", stateSince: 1_000, updatedAt: 9_000, seenRunning: true },
    ...overrides,
  };
}

test("view model groups statuses without heuristic needs-input", () => {
  const running = status();
  const idle = status({ status: "waiting", job: { ...status().job, id: "idle-child", displayName: "worker-idle", status: "waiting", autoStopOnComplete: false } });
  const done = status({ status: "stopped", job: { ...status().job, id: "done-child", displayName: "scout-done", status: "stopped" }, latestTurn: { index: 1, status: "waiting", startedAt: 2, completedAt: 8_000, resultPath: "/tmp/jobs/done-child/turns/001-result.md", messagePreview: "Should we proceed?" } });
  const error = status({ status: "error", job: { ...status().job, id: "error-child", displayName: "worker-error", status: "error" } });
  const attention = status({ job: { ...status().job, id: "attention-child", displayName: "scout-question" }, heartbeat: { ...status().heartbeat!, jobId: "attention-child", attention: { kind: "question", message: "Choose an auth path", updatedAt: 9_500, toolCallId: "tool-1" } } });

  const rows = sortSubagentRows(toSubagentViewRows([running, idle, done, error, attention], { now: 10_000 }));

  assert.deepEqual(rows.map((row) => [row.id, row.group]), [
    ["attention-child", "needsInput"],
    ["child-1234567890", "running"],
    ["idle-child", "idle"],
    ["done-child", "done"],
    ["error-child", "error"],
  ]);
  assert.equal(rows[0]?.activity, "Choose an auth path");
  assert.equal(rows.find((row) => row.id === "done-child")?.group, "done");
  assert.equal(rows.find((row) => row.id === "done-child")?.activity, "Should we proceed?");
  assert.equal(rows.find((row) => row.id === "done-child")?.resultFile, "001-result.md");
  assert.equal(rows[0]?.attachCommand, "tmux attach-session -t pi-tmux-subagents-child");
  assert.equal(groupCountSummary(rows), "1 needs input · 1 running · 1 idle · 1 done · 1 error");
});

test("view model keeps nested parent metadata", () => {
  const row = toSubagentViewRows([status({ job: { ...status().job, parentId: "parent-abcdef123456" } })])[0]!;

  assert.equal(row.parentId, "parent-abcdef123456");
});
