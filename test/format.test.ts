import assert from "node:assert/strict";
import test from "node:test";
import { formatStatus } from "../src/format.js";
import type { SubagentStatusResult } from "../src/types.js";

function status(overrides: Partial<SubagentStatusResult> = {}): SubagentStatusResult {
  return {
    status: "waiting",
    job: {
      id: "child-123",
      agentName: "scout",
      taskPreview: "Inspect auth",
      cwd: "/repo",
      tmuxSession: "pi-agent-hub-child-123",
      status: "waiting",
      resultPath: "/tmp/jobs/child-123/result.md",
      createdAt: 1_000,
      updatedAt: 160_000,
    },
    heartbeat: {
      jobId: "child-123",
      cwd: "/repo",
      state: "waiting",
      stateSince: 150_000,
      updatedAt: 160_000,
      seenRunning: true,
    },
    result: "Done\nChanged src/index.ts\nValidated with npm test",
    ...overrides,
  };
}

test("formatStatus renders compact done summary with attach and output paths", () => {
  const output = formatStatus(status());

  assert.match(output, /^tmux subagent scout\n ✓ scout · done · 2m39s/m);
  assert.match(output, /   ⎿  Done/);
  assert.match(output, /      Changed src\/index\.ts/);
  assert.match(output, /   tmux: pi-agent-hub-child-123/);
  assert.match(output, /   attach: tmux attach-session -t pi-agent-hub-child-123/);
  assert.match(output, /   output: \/tmp\/jobs\/child-123\/result\.md/);
  assert.match(output, /   stop: tmux_subagent\({ action: "stop", childId: "child-123" }\)/);
});

test("formatStatus shows auto-stopped completion without manual stop hint", () => {
  const output = formatStatus(status({ autoStopped: true }));

  assert.match(output, /   auto-stopped after completion/);
  assert.doesNotMatch(output, /tmux_subagent\({ action: "stop"/);
});

test("formatStatus shows auto-stop failure with manual stop hint", () => {
  const output = formatStatus(status({ autoStopError: "tmux session disappeared" }));

  assert.match(output, /   auto-stop failed: tmux session disappeared/);
  assert.match(output, /   stop: tmux_subagent\({ action: "stop", childId: "child-123" }\)/);
});

test("formatStatus prefers result and truncates long snippets", () => {
  const output = formatStatus(status({
    result: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
    preview: "pane preview",
  }));

  assert.match(output, /      line 1/);
  assert.match(output, /      line 8/);
  assert.match(output, /      …/);
  assert.doesNotMatch(output, /line 9/);
  assert.doesNotMatch(output, /Pane preview/);
});

test("formatStatus shows pane preview when result is empty", () => {
  const output = formatStatus(status({ status: "running", result: "", preview: "working\nreading files" }));

  assert.match(output, /^tmux subagent scout\n ⟳ scout · running · 2m39s/m);
  assert.match(output, /   ⎿  Running/);
  assert.match(output, /      Pane preview:/);
  assert.match(output, /      working/);
});
