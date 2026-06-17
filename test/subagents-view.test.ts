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
  assert.match(output, /Needs input/);
  assert.match(output, /Running/);
  assert.match(output, /Idle/);
  assert.match(output, /Choose path/);
  assert.match(output, /attach: tmux attach-session -t tmux-question-child/);

  component.handleInput("\r");
  assert.deepEqual(actions.at(-1), { type: "attach", id: "question-child" });
});

test("subagents view handles empty and narrow renders", () => {
  const component = createSubagentsView([], {}, () => undefined);
  const lines = component.render(24);

  assert.match(lines.join("\n"), /subagents view/);
  assert.match(lines.join("\n"), /No tmux subagent jobs/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.doesNotThrow(() => component.handleInput("\r"));
});
