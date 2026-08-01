import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentsWidget } from "../src/subagents-widget.js";
import { toSubagentViewRows } from "../src/view-model.js";
import type { SubagentStatusResult } from "../src/types.js";

function status(id: string, overrides: Partial<SubagentStatusResult> = {}): SubagentStatusResult {
  return {
    status: "running",
    job: {
      id,
      agentName: "scout",
      displayName: id,
      taskPreview: `Task for ${id}`,
      cwd: "/repo",
      tmuxSession: `tmux-${id}`,
      status: "running",
      resultPath: `/tmp/${id}/result.md`,
      createdAt: 1_000,
      updatedAt: 9_000,
    },
    heartbeat: { jobId: id, cwd: "/repo", state: "running", stateSince: 1_000, updatedAt: 9_000, seenRunning: true },
    ...overrides,
  };
}

const plainTheme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

test("ambient widget renders one compact routine row without mode chrome", () => {
  const running = status("scout-auth", {
    heartbeat: { ...status("scout-auth").heartbeat!, updatedAt: 9_000 },
  });
  const rows = toSubagentViewRows([running], {
    now: 10_000,
    summaries: new Map([[running.job.id, { stage: "implementing", status: "Updating widget tests", updatedAt: 9_900 }]]),
  });
  const widget = createSubagentsWidget(rows, plainTheme, () => 10_000);
  const output = widget.render(100).join("\n");

  assert.match(output, /^subagents · 1 running/m);
  assert.match(output, /scout-auth\s+implementing · Updating widget tests\s+1s/);
  assert.doesNotMatch(output, /background|tree|details|peek|╰─|⎿/);
});

test("ambient widget prioritizes exceptions, caps rows, and sanitizes paths", () => {
  const attention = status("scout-question", {
    heartbeat: { ...status("scout-question").heartbeat!, attention: { kind: "question", message: "Read /Users/manager/Code/app/src/auth.ts or skip?", updatedAt: 9_500 } },
  });
  const error = status("worker-error", {
    status: "error",
    job: { ...status("worker-error").job, status: "error", error: "Tests failed in /tmp/jobs/worker-error/test.log" },
  });
  const running = status("worker-running");
  const idle = status("scout-idle", {
    status: "waiting",
    job: { ...status("scout-idle").job, status: "waiting", autoStopOnComplete: false },
  });
  const rows = toSubagentViewRows([running, idle, error, attention], { now: 10_000 });
  const output = createSubagentsWidget(rows, plainTheme, () => 10_000).render(100).join("\n");

  assert.ok(output.indexOf("scout-question") < output.indexOf("worker-error"));
  assert.match(output, /auth\.ts or skip\?/);
  assert.match(output, /Tests failed in test\.log/);
  assert.match(output, /\+1 more · \/subagents/);
  assert.doesNotMatch(output, /scout-idle|\/Users\/manager|\/tmp\/jobs/);
});

test("ambient widget keeps every line within narrow and wide widths", () => {
  const rows = toSubagentViewRows([
    status("a-very-long-subagent-display-name", { job: { ...status("long").job, id: "long", displayName: "a-very-long-subagent-display-name", taskPreview: "A very long activity description that must yield before the age rail" } }),
    status("second-running"),
  ], { now: 10_000 });
  const widget = createSubagentsWidget(rows, plainTheme, () => 10_000);

  for (const width of [20, 44, 88, 120]) {
    assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width), `line exceeded ${width} columns`);
  }
  assert.match(widget.render(44)[0] ?? "", /subagents · 2 jobs · 2 running/);
  assert.match(widget.render(120).join("\n"), /\s1s$/m);
});

test("ambient widget derives age at render time and reserves color for exceptions", () => {
  let now = 10_000;
  const attention = status("question", {
    heartbeat: { ...status("question").heartbeat!, attention: { kind: "question", message: "Choose path", updatedAt: 9_500 } },
  });
  const idle = status("idle", {
    status: "waiting",
    job: { ...status("idle").job, status: "waiting", autoStopOnComplete: false },
  });
  const tokens: string[] = [];
  const theme = {
    fg: (token: string, text: string) => { tokens.push(token); return text; },
    bg: (token: string, text: string) => { tokens.push(token); return text; },
    bold: (text: string) => text,
  };
  const widget = createSubagentsWidget(toSubagentViewRows([idle, attention], { now }), theme, () => now);

  assert.match(widget.render(100).join("\n"), /idle\s+1s/);
  now = 71_000;
  assert.match(widget.render(100).join("\n"), /idle\s+1m/);
  assert.ok(tokens.includes("warning"));
  assert.ok(!tokens.includes("accent"));
  assert.ok(!tokens.includes("success"));
});
