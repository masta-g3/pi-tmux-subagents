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
      model: "openai/gpt-5",
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
  assert.match(output, /   model: openai\/gpt-5/);
  assert.match(output, /   attach: tmux attach-session -t pi-agent-hub-child-123/);
  assert.match(output, /   output: \/tmp\/jobs\/child-123\/result\.md/);
  assert.match(output, /   stop: tmux_subagent\({ action: "stop", childId: "child-123" }\)/);
});

test("formatStatus renders persistent waiting sessions as idle", () => {
  const output = formatStatus(status({ job: { ...status().job, autoStopOnComplete: false } }));

  assert.match(output, /^tmux subagent scout\n ✓ scout · idle · 2m39s/m);
  assert.match(output, /   ⎿  Ready/);
});

test("formatStatus prefers displayName when present", () => {
  const output = formatStatus(status({ job: { ...status().job, displayName: "scout-auth" } }));

  assert.match(output, /^tmux subagent scout-auth\n ✓ scout-auth · done · 2m39s/m);
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

test("formatStatus shows subagent hygiene notes", () => {
  const output = formatStatus(status({ hygieneNote: "2 idle persistent children need stop when no longer needed." }));

  assert.match(output, /   cleanup: 2 idle persistent children need stop when no longer needed\./);
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

test("formatStatus shows task and useful pane preview when result is empty", () => {
  const output = formatStatus(status({ status: "running", result: "", preview: "working\nreading files" }));

  assert.match(output, /^tmux subagent scout\n ⟳ scout · running · 2m39s/m);
  assert.match(output, /   ⎿  Running/);
  assert.match(output, /      Task:\n      Inspect auth/);
  assert.match(output, /      Pane preview:/);
  assert.match(output, /      working/);
});

test("formatStatus suppresses generic Pi startup pane preview", () => {
  const output = formatStatus(status({
    status: "running",
    result: "",
    preview: `pi v0.75.4
 escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.

 Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.`,
  }));

  assert.match(output, /      Task:\n      Inspect auth/);
  assert.doesNotMatch(output, /Pane preview/);
  assert.doesNotMatch(output, /Pi can explain/);
});
