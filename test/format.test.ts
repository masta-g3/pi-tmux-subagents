import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentStatus, formatStatus, formatSubagentFooterStatus, formatSubagentPeekWidget, formatSubagentSummaryWidget, formatSubagentWidget, formatUserStatus } from "../src/format.js";
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
    hygieneNote: "1 idle persistent child needs stop when no longer needed.",
  }));

  assert.match(output, /^tmux subagent scout-auth \(scout\)\n ⟳ running · 2m39s · activity 0s ago · 1\.4k out · \$0\.08/m);
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
    " ✓ done · 2m39s · 3.5k out · $0",
    "   ✓ result ready → 001-result.md",
  ].join("\n"));
  assert.doesNotMatch(output, /\/tmp\/jobs/);
});

test("formatAgentStatus adds model-visible result read hints", () => {
  const output = formatAgentStatus(status({
    latestTurn: { index: 1, status: "waiting", startedAt: 100_000, completedAt: 160_000, resultPath: "/tmp/jobs/child-123/turns/001-result.md" },
  }));

  assert.match(output, /   ✓ result ready → 001-result\.md/);
  assert.match(output, /   read: \/tmp\/jobs\/child-123\/turns\/001-result\.md/);
  assert.match(output, /   next: read\(\{ path: "\/tmp\/jobs\/child-123\/turns\/001-result\.md", limit: 2000 \}\)/);
});

test("formatAgentStatus reminds idle persistent children to stop", () => {
  const output = formatAgentStatus(status({
    latestTurn: { index: 1, status: "waiting", startedAt: 100_000, completedAt: 160_000, resultPath: "/tmp/jobs/child-123/turns/001-result.md" },
    job: { ...status().job, autoStopOnComplete: false },
  }));

  assert.match(output, /   cleanup: persistent child is idle; stop when done/);
  assert.match(output, /   stop: tmux_subagent\(\{ action: "stop", childId: "child-123" \}\)/);
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

  assert.equal(formatSubagentFooterStatus([running, idle]), "subagents: 1 running · 1 idle · $0.03");
  assert.deepEqual(formatSubagentWidget([running, idle]), [
    "tmux subagents",
    "⟳ scout-render  running  2m39s  0s ago  9.2k/1.1k  $0.01",
    "✓ scout-cost    idle     2m39s  —       16.7k/912  $0.02",
  ]);
});

test("formatSubagentSummaryWidget renders adaptive single child card with task and fresh summary", () => {
  const running = status({
    status: "running",
    job: { ...status().job, displayName: "scout-auth", status: "running", taskPreview: "Inspect auth flow in /Users/manager/Code/app/src/auth.ts", createdAt: 1_000, updatedAt: 58_000 },
    heartbeat: { ...status().heartbeat!, state: "running", updatedAt: 58_000, usage: { input: 18_200, output: 1_400, cacheRead: 0, cacheWrite: 0, totalTokens: 19_600, cost: { input: 0.05, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.08 } } },
    result: "",
  });

  const output = formatSubagentSummaryWidget([running], {
    now: 62_000,
    summaries: new Map([[running.job.id, { goal: "Inspect auth flow", status: "Reviewing /Users/manager/Code/app/src/session.ts and middleware.", nextStep: "Run auth tests", stage: "implementing", updatedAt: 61_000 }]]),
  });

  assert.deepEqual(output, [
    "tmux subagent · background",
    "⟳ scout-auth · running · active 4s ago · 1.4k out · $0.08",
    "  ⎿ goal: Inspect auth flow",
    "  ⎿ status: Reviewing session.ts and middleware.",
    "  ⎿ next: Run auth tests",
    "╰─ /subagents view · /subagents details · /subagents peek",
  ]);
  assert.doesNotMatch(output!.join("\n"), /\/Users\/manager|model:|attach:|stop:|Pane preview/);
});

test("formatSubagentSummaryWidget renders capped multi child list ordered by severity", () => {
  const error = status({
    status: "error",
    job: { ...status().job, id: "child-error", displayName: "worker-ui", status: "error", taskPreview: "Fix UI", resultPath: "/tmp/jobs/child-error/turns/001-result.md" },
    latestTurn: { index: 1, status: "error", startedAt: 1_000, completedAt: 2_000, resultPath: "/tmp/jobs/child-error/turns/001-result.md" },
  });
  const running = status({
    status: "running",
    job: { ...status().job, id: "child-running", displayName: "scout-auth", status: "running", taskPreview: "Inspect auth", createdAt: 1_000 },
    heartbeat: { ...status().heartbeat!, jobId: "child-running", state: "running", updatedAt: 58_000, usage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1_200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } } },
    result: "",
  });
  const idle = status({
    job: { ...status().job, id: "child-idle", displayName: "worker-docs", autoStopOnComplete: false, taskPreview: "Update docs" },
    usage: { input: 2_000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 2_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } },
  });
  const extra = status({
    status: "running",
    job: { ...status().job, id: "child-extra", displayName: "scout-extra", status: "running", taskPreview: "Extra work" },
    heartbeat: { ...status().heartbeat!, jobId: "child-extra", state: "running", updatedAt: 57_000 },
    result: "",
  });

  const output = formatSubagentSummaryWidget([idle, running, extra, error], { now: 62_000, maxRows: 3 });

  assert.deepEqual(output, [
    "tmux subagents · 2 running · 1 idle · 1 error · $0.03",
    "├─ ✗ worker-ui · error · result 001-result.md",
    "│  ⎿ task: Fix UI",
    "├─ ⟳ scout-auth · running · active 4s ago · 200 out · $0.01",
    "│  ⎿ task: Inspect auth",
    "└─ ⟳ scout-extra · running · active 5s ago",
    "   ⎿ task: Extra work",
    "+1 more · /subagents for details",
    "╰─ /subagents view · /subagents details · /subagents peek",
  ]);
});

test("formatSubagentSummaryWidget suppresses stale summaries", () => {
  const output = formatSubagentSummaryWidget([status({ result: "" })], {
    now: 120_000,
    summaries: new Map([["child-123", { status: "Stale activity", updatedAt: 1 }]]),
  });

  assert.deepEqual(output, [
    "tmux subagent · background",
    "✓ scout · done",
    "  ⎿ task: Inspect auth",
    "╰─ /subagents view · /subagents details · /subagents peek",
  ]);
});

test("formatSubagentSummaryWidget prioritizes explicit attention", () => {
  const running = status({
    status: "running",
    job: { ...status().job, id: "child-running", displayName: "scout-running", status: "running", taskPreview: "Keep working" },
    heartbeat: { ...status().heartbeat!, jobId: "child-running", state: "running" },
    result: "",
  });
  const attention = status({
    status: "running",
    job: { ...status().job, id: "child-attention", displayName: "scout-question", status: "running", taskPreview: "Ask parent" },
    heartbeat: { ...status().heartbeat!, jobId: "child-attention", state: "running", attention: { kind: "question", message: "Pick one", updatedAt: 160_000 } },
    result: "",
  });

  const output = formatSubagentSummaryWidget([running, attention], { now: 162_000 });

  assert.equal(formatSubagentFooterStatus([running, attention]), "subagents: 1 needs input · 1 running");
  assert.match(output?.join("\n") ?? "", /^tmux subagents · 1 needs input · 1 running\n├─ ✸ scout-question · needs input/m);
});

test("formatSubagentPeekWidget renders task, summary, and result basename", () => {
  const running = status({
    status: "running",
    job: { ...status().job, displayName: "scout-auth", status: "running", taskPreview: "Inspect auth flow and report risks", createdAt: Date.now() - 159_000 },
    heartbeat: { ...status().heartbeat!, state: "running", updatedAt: Date.now() },
    result: "",
  });
  const idle = status({
    job: { ...status().job, id: "child-456", displayName: "scout-docs", autoStopOnComplete: false, taskPreview: "Check docs coverage" },
    latestTurn: { index: 1, status: "waiting", startedAt: 100_000, completedAt: 160_000, resultPath: "/tmp/jobs/child-456/turns/001-result.md" },
  });

  const output = formatSubagentPeekWidget([running, idle], new Map([[running.job.id, { goal: "Inspect auth flow", status: "Reviewing session handling and auth middleware.", nextStep: "Check token refresh", updatedAt: Date.now() }]]));

  assert.deepEqual(output, [
    "tmux subagents · peek",
    "⟳ scout-auth  running  2m39s  0s ago  —",
    "   goal: Inspect auth flow",
    "   status: Reviewing session handling and auth middleware.",
    "   next: Check token refresh",
    "✓ scout-docs  idle     2m39s  —       —",
    "   task: Check docs coverage",
    "   result: 001-result.md",
  ]);
  assert.doesNotMatch(output!.join("\n"), /\/tmp\/jobs|model:|attach:|stop:|cleanup:|Pane preview/);
});

test("formatSubagentPeekWidget shows task only when summaries are absent or stale", () => {
  const freshOutput = formatSubagentPeekWidget([status({ result: "" })]);
  const staleOutput = formatSubagentPeekWidget([status({ result: "" })], new Map([["child-123", { status: "Stale activity", updatedAt: 1 }]]));
  const expected = [
    "tmux subagents · peek",
    "✓ scout  done  2m39s  —  —",
    "   task: Inspect auth",
  ];

  assert.deepEqual(freshOutput, expected);
  assert.deepEqual(staleOutput, expected);
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
