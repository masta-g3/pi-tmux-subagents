import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentStatus, formatStatus, formatSubagentFooterStatus, formatSubagentWidget, formatUserStatus } from "../src/format.js";
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

test("agent status offers explicit resume only for a stopped child with saved identity", () => {
  const child = status({ status: "stopped" });
  assert.doesNotMatch(formatAgentStatus(child), /follow-up:.*resume/);
  child.job = { ...child.job, sessionFile: "/saved/session.jsonl", sessionId: "saved", resolvedModel: "openai/model", resolvedThinking: "off" };
  assert.match(formatAgentStatus(child), /follow-up:.*resume.*message/);
  child.status = "waiting";
  assert.doesNotMatch(formatAgentStatus(child), /follow-up:.*resume/);
});

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

test("formatUserStatus renders lean active card without operational commands or previews", () => {
  const output = formatUserStatus(status({
    status: "running",
    result: "",
    preview: "working\nreading files",
    job: { ...status().job, displayName: "scout-auth", createdAt: Date.now() - 159_000 },
    heartbeat: {
      ...status().heartbeat!,
      updatedAt: Date.now(),
      usage: { input: 18_200, output: 1_400, cacheRead: 0, cacheWrite: 0, totalTokens: 19_600, cost: { input: 0.05, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.08 } },
    },
  }));

  assert.match(output, /^tmux subagent scout-auth \(scout\)\n ⟳ running · 2m39s · activity 0s ago · 1\.4k out · \$0\.08 · latest run/m);
  assert.doesNotMatch(output, /model:/);
  assert.doesNotMatch(output, /cleanup:/);
  assert.doesNotMatch(output, /18\.2k in/);
  assert.doesNotMatch(output, /attach:/);
  assert.doesNotMatch(output, /stop:/);
  assert.doesNotMatch(output, /Pane preview/);
  assert.doesNotMatch(output, /working/);
});

test("formatUserStatus renders lean terminal card with result basename", () => {
  const output = formatUserStatus(status({
    latestTurn: { index: 1, status: "waiting", startedAt: 100_000, completedAt: 160_000, resultPath: "/tmp/jobs/child-123/turns/001-result.md", usage: { input: 5, output: 3_500, cacheRead: 0, cacheWrite: 0, totalTokens: 3_505, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    usage: { input: 5, output: 3_500, cacheRead: 0, cacheWrite: 0, totalTokens: 3_505, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }));

  assert.equal(output, [
    "tmux subagent scout",
    " ✓ done · 2m39s · 3.5k out · $0 · latest run",
    "   ✓ result ready → 001-result.md",
  ].join("\n"));
  assert.doesNotMatch(output, /\/tmp\/jobs/);
});

test("formatAgentStatus uses a lightweight confirmed result path", () => {
  const output = formatAgentStatus(status({
    result: undefined,
    resultPath: "/tmp/jobs/child-123/turns/002-result.md",
  }));

  assert.match(output, /result ready → 002-result\.md/);
  assert.match(output, /read: \/tmp\/jobs\/child-123\/turns\/002-result\.md/);
});

test("formatAgentStatus adds model-visible result read hints", () => {
  const output = formatAgentStatus(status({
    latestTurn: { index: 1, status: "waiting", startedAt: 100_000, completedAt: 160_000, resultPath: "/tmp/jobs/child-123/turns/001-result.md" },
  }));

  assert.match(output, /   ✓ result ready → 001-result\.md/);
  assert.match(output, /   read: \/tmp\/jobs\/child-123\/turns\/001-result\.md/);
  assert.match(output, /   next: read\(\{ path: "\/tmp\/jobs\/child-123\/turns\/001-result\.md", limit: 2000 \}\)/);
});

test("formatAgentStatus only reminds indefinite idle children to stop", () => {
  for (const idleTimeoutMs of [undefined, 0, 900_000]) {
    const output = formatAgentStatus(status({
      job: { ...status().job, autoStopOnComplete: false, idleTimeoutMs },
    }));
    if (idleTimeoutMs) assert.doesNotMatch(output, /cleanup:|   stop:/);
    else assert.match(output, /   stop: tmux_subagent\(\{ action: "stop", childId: "child-123" \}\)/);
  }
});

test("formatSubagentFooterStatus and widget render live observability summary", () => {
  const running = status({
    status: "running",
    job: { ...status().job, displayName: "scout-render", status: "running", autoStopOnComplete: false, createdAt: Date.now() - 159_000 },
    heartbeat: { ...status().heartbeat!, state: "running", updatedAt: Date.now(), usage: { input: 9_200, output: 1_100, cacheRead: 0, cacheWrite: 0, totalTokens: 10_300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } },
  });
  const idle = status({
    job: { ...status().job, id: "child-456", displayName: "scout-cost", autoStopOnComplete: false },
    usage: { input: 16_700, output: 912, cacheRead: 0, cacheWrite: 0, totalTokens: 17_612, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
  });

  assert.equal(formatSubagentFooterStatus([running, idle]), "subagents: 1 running · 1 idle · $0.03 latest-run usage");
  assert.deepEqual(formatSubagentWidget([running, idle]), [
    "tmux subagents",
    "⟳ scout-render  running  2m39s  0s ago  9.2k/1.1k  $0.01 · latest run",
    "✓ scout-cost    idle     2m39s  —       16.7k/912  $0.02 · latest run",
  ]);
});

test("usage output distinguishes lifetime, latest-run, and mixed totals", () => {
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
  const lifetime = status({ usage, usageScope: "lifetime" });
  const latest = status({ job: { ...status().job, id: "latest" }, usage });

  assert.match(formatUserStatus(lifetime), /20 out · \$0\.03 · lifetime/);
  assert.match(formatUserStatus(latest), /20 out · \$0\.03 · latest run/);
  assert.match(formatSubagentFooterStatus([lifetime, latest]) ?? "", /\$0\.06 mixed usage/);
  assert.match(formatSubagentFooterStatus([lifetime, status({ job: { ...status().job, id: "missing" }, result: "", usage: undefined })]) ?? "", /\$0\.03 partial lifetime usage/);
});

test("formatStatus shows auto-stopped completion without manual stop hint", () => {
  const output = formatStatus(status({ autoStopped: true }));

  assert.match(output, /   auto-stopped after completion/);
  assert.doesNotMatch(output, /tmux_subagent\({ action: "stop"/);
});

test("formatAgentStatus renders child-owned automatic stops as done with result access", () => {
  const output = formatAgentStatus(status({ status: "stopped", autoStopped: true }));
  assert.match(output, /✓ done/);
  assert.match(output, /result ready/);
  assert.match(output, /next: read\(/);
  assert.doesNotMatch(output, /   stop:/);
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
