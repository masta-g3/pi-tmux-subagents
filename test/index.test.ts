import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { resolveAutoStopOnComplete } from "../src/index.js";

function isolatePiStateEnv(agentDir: string): () => void {
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldStateEnv = process.env.PI_TMUX_SUBAGENTS_DIR;
  const oldHubDir = process.env.PI_AGENT_HUB_DIR;
  const oldHubId = process.env.PI_AGENT_HUB_SESSION_ID;
  const oldNestedAllowlist = process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST;
  const oldNestedDepth = process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH;
  const oldSubagentDepth = process.env.PI_SUBAGENT_DEPTH;
  const oldTmuxJobId = process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_TMUX_SUBAGENTS_DIR;
  delete process.env.PI_AGENT_HUB_DIR;
  delete process.env.PI_AGENT_HUB_SESSION_ID;
  delete process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST;
  delete process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH;
  delete process.env.PI_SUBAGENT_DEPTH;
  delete process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  return () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldStateEnv === undefined) delete process.env.PI_TMUX_SUBAGENTS_DIR;
    else process.env.PI_TMUX_SUBAGENTS_DIR = oldStateEnv;
    if (oldHubDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = oldHubDir;
    if (oldHubId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = oldHubId;
    if (oldNestedAllowlist === undefined) delete process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST;
    else process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST = oldNestedAllowlist;
    if (oldNestedDepth === undefined) delete process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH;
    else process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH = oldNestedDepth;
    if (oldSubagentDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldSubagentDepth;
    if (oldTmuxJobId === undefined) delete process.env.PI_TMUX_SUBAGENTS_JOB_ID;
    else process.env.PI_TMUX_SUBAGENTS_JOB_ID = oldTmuxJobId;
  };
}

test("tmux_subagent uses canonical parent status key", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-status-test-"));
  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  try {
    const handlers = new Map<string, Function>();
    const statuses: Array<[string, string | undefined]> = [];
    extension({
      registerTool() {},
      on(name: string, handler: Function) { handlers.set(name, handler); },
    } as any);

    await handlers.get("session_start")?.({}, { cwd: process.cwd(), ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) } });

    assert.deepEqual(statuses, [["pi-tmux-subagents", undefined]]);
  } finally {
    restorePiEnv();
  }
});

test("tmux_subagent status reads jobs from canonical default root and sweeps missing sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-status-root-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id: "child-1", agentName: "scout", displayName: "scout-auth", taskPreview: "Inspect", cwd: root, tmuxSession: "pi-agent-hub-child-1", status: "starting", resultPath: join(state, "jobs", "child-1", "result.md"), createdAt: 1, updatedAt: 1 }],
  }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { action: "status" }, undefined, undefined, { cwd: root });

    assert.match(result.content[0].text, /child-1 stopped scout-auth: Inspect/);
  } finally {
    restorePiEnv();
  }
});

test("tmux_subagent exposes stop as a shutdown alias", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.ok(tool.parameters.properties.action.enum.includes("stop"));
});

test("tmux_subagent exposes persistent send and wait actions", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.ok(tool.parameters.properties.action.enum.includes("send"));
  assert.ok(tool.parameters.properties.action.enum.includes("wait"));
  assert.equal(tool.parameters.properties.message.type, "string");
  assert.equal(tool.parameters.properties.label.type, "string");
  assert.match(tool.parameters.properties.label.description, /worker-auth/);
  assert.equal(tool.parameters.properties.timeoutMs.type, "number");
  assert.match(tool.description, /Prefer background launches/);
  assert.match(tool.parameters.properties.wait.description, /Prefer false/);
  assert.match(tool.parameters.properties.childId.description, /omit to return when any active child completes/);
});

test("tmux_subagent exposes nested launch controls", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.equal(tool.parameters.properties.allowNestedSubagents.type, "boolean");
  assert.equal(tool.parameters.properties.allowNestedSubagents.default, false);
  assert.equal(tool.parameters.properties.nestedAgentAllowlist.type, "array");
  assert.equal(tool.parameters.properties.maxNestedDepth.default, 2);
});

test("tmux_subagent exposes runtime auto-stop option enabled by default", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.equal(tool.parameters.properties.autoStopOnComplete.type, "boolean");
  assert.equal(tool.parameters.properties.autoStopOnComplete.default, true);
  assert.match(tool.parameters.properties.autoStopOnComplete.description, /Default true/);
  assert.equal(resolveAutoStopOnComplete(undefined), true);
  assert.equal(resolveAutoStopOnComplete(true), true);
  assert.equal(resolveAutoStopOnComplete(false), false);
});

test("tmux_subagent renders status with active theme tokens", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);
  const theme = {
    bold: (text: string) => `<b>${text}</b>`,
    fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  };

  const rendered = tool.renderResult({
    content: [{ type: "text", text: "plain fallback" }],
    details: {
      status: "running",
      job: {
        id: "child-123",
        agentName: "plan-critic",
        taskPreview: "Review plan",
        cwd: "/repo",
        tmuxSession: "pi-agent-hub-child-123",
        status: "running",
        resultPath: "/tmp/result.md",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      heartbeat: { jobId: "child-123", cwd: "/repo", state: "running", stateSince: 1_500, updatedAt: 2_000 },
      preview: "## Scope",
    },
  }, { expanded: false, isPartial: true }, theme, {}).render(120).join("\n");

  assert.match(rendered, /^<muted>tmux subagent plan-critic<\/muted>/);
  assert.match(rendered, /<warning>⟳<\/warning> <toolTitle><b>plan-critic<\/b><\/toolTitle>/);
  assert.match(rendered, /<muted>Pane preview:<\/muted>/);
  assert.match(rendered, /<toolOutput>## Scope<\/toolOutput>/);
  assert.match(rendered, /<dim>tmux:<\/dim> <muted>pi-agent-hub-child-123<\/muted>/);
  assert.match(rendered, /<dim>attach:<\/dim> <mdCode>tmux attach-session -t pi-agent-hub-child-123<\/mdCode>/);
  assert.match(rendered, /<dim>output:<\/dim> <mdCode>\/tmp\/result\.md<\/mdCode>/);
  assert.match(rendered, /<dim>stop:<\/dim> <muted>tmux_subagent/);
});

test("tmux_subagent rejects disallowed nested agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-nested-allowlist-test-"));
  const agentDir = join(root, "agent", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "scout.md"), `---
name: scout
description: Scout
tools: none
---
Scout prompt.
`);

  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST = "code-critic";
  process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH = "1";
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { agent: "scout", task: "try nested" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Nested agent scout is not allowed/);
  } finally {
    restorePiEnv();
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldDepth;
  }
});

test("tmux_subagent rejects nested launches beyond max depth", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-nested-depth-test-"));
  const agentDir = join(root, "agent", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "code-critic.md"), `---
name: code-critic
description: Critic
tools: none
---
Critic prompt.
`);

  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_TMUX_SUBAGENTS_JOB_ID = "child-1";
  process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST = "code-critic";
  process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH = "1";
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { agent: "code-critic", task: "review" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /subagent depth 2/);
  } finally {
    restorePiEnv();
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldDepth;
  }
});

test("tmux_subagent rejects nested child management for jobs it did not launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-nested-manage-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id: "parent-job", agentName: "scout", taskPreview: "Parent job", cwd: root, tmuxSession: "pi-agent-hub-parent", status: "running", resultPath: join(state, "jobs", "parent-job", "result.md"), createdAt: 1, updatedAt: 1 }],
  }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_TMUX_SUBAGENTS_JOB_ID = "child-1";
  process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST = "code-critic";
  process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH = "2";
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { action: "status", childId: "parent-job" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /only manage jobs they launched/);
  } finally {
    restorePiEnv();
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldDepth;
  }
});

test("tmux_subagent rejects nested launches when not enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-test-"));
  const agentDir = join(root, "agent", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "scout.md"), `---
name: scout
description: Scout
maxDepth: 0
tools: none
---
Scout prompt.
`);

  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { agent: "scout", task: "try nested" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Nested tmux_subagent launches are not enabled/);
  } finally {
    restorePiEnv();
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldDepth;
  }
});
