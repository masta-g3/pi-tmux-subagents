import assert from "node:assert/strict";
import test from "node:test";
import { compactGroupCountSummary, groupCountSummary, sortSubagentRows, toSubagentViewRows } from "../src/view-model.js";
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
  const error = status({ status: "error", job: { ...status().job, id: "error-child", displayName: "worker-error", status: "error", error: "Tests failed" }, heartbeat: { ...status().heartbeat!, jobId: "error-child", attention: { kind: "question", message: "Stale question", updatedAt: 9_000 } } });
  const attention = status({ job: { ...status().job, id: "attention-child", displayName: "scout-question" }, heartbeat: { ...status().heartbeat!, jobId: "attention-child", attention: { kind: "question", message: "Choose an auth path", updatedAt: 9_500, toolCallId: "tool-1" } } });

  const rows = sortSubagentRows(toSubagentViewRows([running, idle, done, error, attention], { now: 10_000 }));

  assert.deepEqual(rows.map((row) => [row.id, row.group]), [
    ["attention-child", "needsInput"],
    ["error-child", "error"],
    ["child-1234567890", "running"],
    ["idle-child", "idle"],
    ["done-child", "done"],
  ]);
  assert.equal(rows[0]?.activity, "Choose an auth path");
  assert.equal(rows[0]?.detailKind, "question");
  assert.equal(rows[0]?.primaryAction, "reply");
  assert.equal(rows.find((row) => row.id === "error-child")?.activity, "Tests failed");
  assert.equal(rows.find((row) => row.id === "error-child")?.detailKind, "error");
  assert.equal(rows.find((row) => row.id === "error-child")?.primaryAction, "details");
  assert.equal(rows.find((row) => row.id === "done-child")?.group, "done");
  assert.equal(rows.find((row) => row.id === "done-child")?.activity, "Should we proceed?");
  assert.equal(rows.find((row) => row.id === "done-child")?.resultFile, "001-result.md");
  assert.equal(rows.find((row) => row.id === "done-child")?.primaryAction, "result");
  assert.equal(rows.find((row) => row.id === "done-child")?.canReply, false);
  assert.equal(rows.find((row) => row.id === "idle-child")?.canReply, true);
  assert.equal(rows.find((row) => row.id === "idle-child")?.primaryAction, "reply");
  assert.equal(rows.find((row) => row.id === "error-child")?.canReply, false);
  assert.equal(rows[0]?.canAttach, true);
  assert.equal(groupCountSummary(rows), "1 needs input · 1 error · 1 running · 1 idle · 1 done");
  assert.equal(compactGroupCountSummary(rows), "5 jobs · 1 input · 1 error");
});

test("view model prefixes fresh stage without overriding attention", () => {
  const running = status();
  const attention = status({ job: { ...status().job, id: "attention-child", displayName: "scout-question" }, heartbeat: { ...status().heartbeat!, jobId: "attention-child", attention: { kind: "question", message: "Choose path", updatedAt: 9_500 } } });

  const rows = toSubagentViewRows([running, attention], {
    now: 10_000,
    summaries: new Map([[running.job.id, { stage: "testing", status: "Running widget tests", updatedAt: 9_900 }], [attention.job.id, { stage: "testing", status: "Should not win", updatedAt: 9_900 }]]),
  });

  assert.equal(rows.find((row) => row.id === running.job.id)?.activity, "testing · Running widget tests");
  assert.equal(rows.find((row) => row.id === running.job.id)?.detailKind, "progress");
  assert.equal(rows.find((row) => row.id === attention.job.id)?.activity, "Choose path");
  assert.equal(rows.find((row) => row.id === attention.job.id)?.detailKind, "question");
});

test("view model keeps nested parent metadata", () => {
  const row = toSubagentViewRows([status({ job: { ...status().job, parentId: "parent-abcdef123456" } })])[0]!;

  assert.equal(row.parentId, "parent-abcdef123456");
});
