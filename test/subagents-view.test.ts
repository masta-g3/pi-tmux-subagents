import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentsView } from "../src/subagents-view.js";
import { toSubagentViewRows } from "../src/view-model.js";
import type { SubagentStatusResult } from "../src/types.js";

function status(id: string, overrides: Partial<SubagentStatusResult> = {}): SubagentStatusResult {
  return {
    status: "running",
    job: { id, agentName: "scout", displayName: id, taskPreview: `Task for ${id}`, cwd: "/repo", tmuxSession: `tmux-${id}`, status: "running", resultPath: `/tmp/${id}/result.md`, createdAt: 1, updatedAt: 2, parentId: overrides.job?.parentId },
    heartbeat: { jobId: id, cwd: "/repo", state: "running", stateSince: 1, updatedAt: 9, seenRunning: true },
    ...overrides,
  };
}

test("subagents view renders groups, peek, lineage, and actions", () => {
  const rows = toSubagentViewRows([
    status("run-child"),
    status("question-child", { heartbeat: { jobId: "question-child", cwd: "/repo", state: "running", stateSince: 1, updatedAt: 10, seenRunning: true, attention: { kind: "question", message: "Choose path", updatedAt: 10 } } }),
    status("nested-child", { status: "waiting", job: { ...status("nested-child").job, status: "waiting", autoStopOnComplete: false, parentId: "parent-child-123" } }),
  ], { now: 20_000 });
  const actions: unknown[] = [];
  const component = createSubagentsView(rows, {}, (action) => actions.push(action));

  const output = component.render(90).join("\n");
  assert.match(output, /Needs input \(1\)/);
  assert.match(output, /Running \(1\)/);
  assert.match(output, /Idle \(1\)/);
  assert.match(output, /question: Choose path/);
  assert.doesNotMatch(output, /attach: tmux attach-session/);
  assert.match(output, /p peek • r reply • s stop • a attach/);

  component.handleInput("r");
  assert.deepEqual(actions.at(-1), { type: "reply", id: "question-child" });
  component.handleInput("a");
  assert.deepEqual(actions.at(-1), { type: "attach", id: "question-child" });
  component.handleInput("\r");
  assert.deepEqual(actions.at(-1), { type: "attach", id: "question-child" });
});

test("subagents view carries summary cost and result usage into idle rows", () => {
  const idle = status("idle-child", {
    status: "waiting",
    job: { ...status("idle-child").job, status: "waiting", autoStopOnComplete: false },
    latestTurn: {
      index: 1,
      status: "waiting",
      startedAt: 1,
      completedAt: 2,
      resultPath: "/tmp/idle-child/turns/001-result.md",
      usage: { input: 10, output: 727, cacheRead: 0, cacheWrite: 0, totalTokens: 737, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    },
    usage: { input: 10, output: 727, cacheRead: 0, cacheWrite: 0, totalTokens: 737, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  const component = createSubagentsView(toSubagentViewRows([idle], { now: 20_000 }), {}, () => undefined);
  const output = component.render(120).join("\n");

  assert.match(output, /subagents view · 1 idle · \$0\.01/);
  assert.match(output, /result 001-result\.md · 727 out · \$0\.01/);
});

test("subagents view toggles peek and confirms stop for running rows", () => {
  const rows = toSubagentViewRows([status("run-child")], { now: 20_000 });
  const actions: unknown[] = [];
  const component = createSubagentsView(rows, {}, (action) => actions.push(action));

  assert.match(component.render(90).join("\n"), /Peek:/);
  component.handleInput("p");
  assert.doesNotMatch(component.render(90).join("\n"), /Peek:/);
  component.handleInput("p");
  component.handleInput("s");
  assert.deepEqual(actions, []);
  assert.match(component.render(90).join("\n"), /Stop it and nested children\? y confirm/);
  component.handleInput("n");
  assert.deepEqual(actions, []);
  component.handleInput("s");
  component.handleInput("y");
  assert.deepEqual(actions.at(-1), { type: "stop", id: "run-child", confirmed: true });
});

test("subagents view sanitizes peek task paths", () => {
  const rows = toSubagentViewRows([status("path-child", { job: { ...status("path-child").job, taskPreview: "Inspect /Users/manager/Code/app/src/auth.ts before replying" } })], { now: 20_000 });
  const component = createSubagentsView(rows, {}, () => undefined);
  const output = component.render(90).join("\n");

  assert.match(output, /task: Inspect auth\.ts before replying/);
  assert.doesNotMatch(output, /\/Users\/manager/);
});

test("subagents view bounds done rows", () => {
  const doneStatuses = Array.from({ length: 7 }, (_, index) => status(`done-${index}`, {
    status: "stopped",
    job: { ...status(`done-${index}`).job, status: "stopped" },
    latestTurn: { index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: `/tmp/done-${index}/turns/001-result.md` },
  }));
  const component = createSubagentsView(toSubagentViewRows(doneStatuses, { now: 20_000 }), {}, () => undefined);
  const output = component.render(100).join("\n");

  assert.match(output, /Done \(5\)/);
  assert.match(output, /\+2 more done/);
  assert.doesNotMatch(output, /done-6/);
});

test("subagents view handles empty and narrow renders", () => {
  const component = createSubagentsView([], {}, () => undefined);
  const lines = component.render(24);

  assert.match(lines.join("\n"), /subagents view/);
  assert.match(lines.join("\n"), /No tmux subagent jobs/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.doesNotThrow(() => component.handleInput("\r"));
});
