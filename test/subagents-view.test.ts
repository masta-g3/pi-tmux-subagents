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

function harness(statuses: SubagentStatusResult[], selectedId?: string) {
  const actions: unknown[] = [];
  let renders = 0;
  let refreshes = 0;
  const rows = toSubagentViewRows(statuses, { now: 20_000 });
  const component = createSubagentsView(rows, {}, {
    finish: (action) => actions.push(action),
    requestRender: () => { renders += 1; },
    refreshNow: async () => { refreshes += 1; },
  }, { selectedId });
  return { component, actions, get renders() { return renders; }, get refreshes() { return refreshes; } };
}

test("manager renders one list with explicit states and discoverable actions", () => {
  const question = status("question-child", { heartbeat: { ...status("question-child").heartbeat!, attention: { kind: "question", message: "Choose path", updatedAt: 10 } } });
  const idle = status("idle-child", {
    status: "waiting",
    job: { ...status("idle-child").job, status: "waiting", autoStopOnComplete: false },
    latestTurn: { index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: "/tmp/idle-child/turns/001-result.md" },
  });
  const { component } = harness([status("run-child"), question, idle]);
  const output = component.render(120).join("\n");

  assert.match(output, /Subagents · 1 needs input · 1 running · 1 idle/);
  assert.doesNotMatch(output, /Needs input  1|Running  1|Idle  1|19s/);
  assert.match(output, /Agent\s+Status\s+Activity/);
  assert.match(output, /question-child\s+Needs input\s+Choose path/);
  assert.match(output, /↑↓ select/);
  assert.match(output, /enter answer question/);
  assert.equal(output.split("question-child").length - 1, 1);
  assert.doesNotMatch(output, /p peek|• r reply|enter result\/attach/);
  const narrowLines = component.render(44);
  assert.match(narrowLines.slice(0, 2).join("\n"), /^Subagents\n3 jobs · 1 input/m);
  const narrowFooter = narrowLines.slice(-3).join("\n");
  assert.match(narrowFooter, /enter answer question/);
  assert.match(narrowLines.join("\n"), /Choose path/);
  assert.match(narrowFooter, /esc close/);
  assert.doesNotMatch(narrowFooter, /a attach|R refresh/);
});

test("Enter performs the selected row primary action and local disclosures request renders", () => {
  const question = status("question", { heartbeat: { ...status("question").heartbeat!, attention: { kind: "question", message: "Choose", updatedAt: 10 } } });
  const attentionHarness = harness([question]);
  attentionHarness.component.handleInput("\r");
  assert.deepEqual(attentionHarness.actions, [{ type: "reply", id: "question" }]);

  const runningHarness = harness([status("running")]);
  runningHarness.component.handleInput("\r");
  assert.equal(runningHarness.actions.length, 0);
  assert.match(runningHarness.component.render(100).join("\n"), /task  Task for running/);
  assert.ok(runningHarness.renders > 0);

  const done = status("done", {
    status: "stopped",
    job: { ...status("done").job, status: "stopped" },
    latestTurn: { index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: "/tmp/done/turns/001-result.md" },
    latestResult: "Delivered the requested result.",
  });
  const doneHarness = harness([done]);
  doneHarness.component.handleInput("\r");
  assert.equal(doneHarness.actions.length, 0);
  assert.match(doneHarness.component.render(100).join("\n"), /Delivered the requested result/);
  assert.match(doneHarness.component.render(100).join("\n"), /enter hide result/);
});

test("manager result excerpt is bounded, wrapped, and sanitized", () => {
  const result = [
    "Changed /Users/manager/Code/app/src/auth.ts",
    "\u001b[31mterminal color\u001b[0m",
    ...Array.from({ length: 12 }, (_, index) => `line ${index + 1} with enough text to wrap across the panel width`),
  ].join("\n");
  const done = status("done", {
    status: "stopped",
    job: { ...status("done").job, status: "stopped" },
    latestTurn: { index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: "/tmp/done/turns/001-result.md" },
    latestResult: result,
  });
  const { component } = harness([done]);
  component.handleInput("\r");
  const output = component.render(44).join("\n");
  const resultLines = output.split("\n").filter((line) => /^  /.test(line));

  assert.match(output, /auth\.ts/);
  assert.doesNotMatch(output, /\/Users\/manager|\u001b\[31m/);
  assert.match(output, /…/);
  assert.ok(resultLines.length <= 8);
});

test("manager updateRows preserves selected job ID across reorder and falls back when removed", () => {
  const { component } = harness([status("run-a"), status("run-b")], "run-b");
  assert.match(component.render(100).join("\n"), /> .*run-b/);

  const attentionB = status("run-b", { heartbeat: { ...status("run-b").heartbeat!, updatedAt: 30, attention: { kind: "question", message: "Now urgent", updatedAt: 30 } } });
  component.updateRows(toSubagentViewRows([attentionB, status("run-a")], { now: 40_000 }));
  assert.match(component.render(100).join("\n"), /> .*run-b/);

  component.updateRows(toSubagentViewRows([status("run-a"), status("run-c")], { now: 40_000 }));
  assert.match(component.render(100).join("\n"), /> .*run-a/);
});

test("manager refresh stays mounted and running stop remains guarded", async () => {
  const view = harness([status("run-child")]);
  view.component.handleInput("R");
  await Promise.resolve();
  assert.equal(view.refreshes, 1);
  assert.equal(view.actions.length, 0);

  view.component.handleInput("s");
  assert.match(view.component.render(90).join("\n"), /Stop it and nested children\? y confirm/);
  view.component.handleInput("n");
  assert.equal(view.actions.length, 0);
  view.component.handleInput("s");
  view.component.handleInput("y");
  assert.deepEqual(view.actions.at(-1), { type: "stop", id: "run-child", confirmed: true });
});

test("manager bounds history and every line at representative widths", () => {
  const doneStatuses = Array.from({ length: 7 }, (_, index) => status(`done-${index}`, {
    status: "stopped",
    job: { ...status(`done-${index}`).job, status: "stopped" },
    latestTurn: { index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: `/tmp/done-${index}/turns/001-result.md` },
  }));
  const { component } = harness(doneStatuses);

  for (const width of [20, 44, 88, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeded ${width} columns`);
    assert.match(lines.slice(-2).join("\n"), /esc close/);
  }
  const output = component.render(100).join("\n");
  assert.match(output, /Status/);
  assert.match(output, /\+2 more done/);
  assert.doesNotMatch(output, /done-6/);
});

test("idle agents offer a new task rather than a reply", () => {
  const idle = status("idle", { status: "waiting", job: { ...status("idle").job, status: "waiting", autoStopOnComplete: false } });
  const { component, actions } = harness([idle]);
  assert.match(component.render(100).join("\n"), /enter send task/);
  assert.doesNotMatch(component.render(100).join("\n"), /prepare attach/);
  component.handleInput("d");
  assert.match(component.render(100).join("\n"), /a prepare attach command/);
  assert.match(component.render(100).join("\n"), /updated 19s ago/);
  component.handleInput("d");
  assert.doesNotMatch(component.render(100).join("\n"), /updated 19s ago/);
  component.handleInput("\r");
  assert.deepEqual(actions, [{ type: "reply", id: "idle" }]);
});

test("manager separates local launches from other jobs and selection follows displayed order", () => {
  const local = status("local-idle", { status: "waiting", job: { ...status("local-idle").job, autoStopOnComplete: false } });
  const rows = toSubagentViewRows([status("foreign-running"), local], { now: 20_000 });
  const actions: unknown[] = [];
  const component = createSubagentsView(rows, {}, { finish: (action) => actions.push(action), requestRender() {}, async refreshNow() {} }, { sessionJobIds: new Set([local.job.id]) });
  const output = component.render(100).join("\n");
  assert.ok(output.indexOf("This session") < output.indexOf("local-idle"));
  assert.ok(output.indexOf("local-idle") < output.indexOf("Other sessions"));
  assert.ok(output.indexOf("Other sessions") < output.indexOf("foreign-running"));
  component.handleInput("\r");
  assert.deepEqual(actions, [{ type: "reply", id: "local-idle" }]);
  component.handleInput("\u001b[B");
  component.handleInput("s");
  component.handleInput("y");
  assert.deepEqual(actions.at(-1), { type: "stop", id: "foreign-running", confirmed: true });
});

test("manager handles empty state", () => {
  const { component } = harness([]);
  const lines = component.render(24);

  assert.match(lines.join("\n"), /Subagents/);
  assert.match(lines.join("\n"), /No tmux subagent jobs/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.doesNotThrow(() => component.handleInput("\r"));
});
