import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childBootstrap from "../src/child-bootstrap.js";

test("child bootstrap writes final assistant text to latest and turn result paths on agent_end", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-result-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "LGTM" }] },
    ] } as any, { cwd: root });

    assert.equal(await readFile(resultPath, "utf8"), "LGTM\n");
    assert.equal(await readFile(join(root, "jobs", "child-1", "turns", "001-result.md"), "utf8"), "LGTM\n");
    assert.match(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"), /"state": "waiting"/);

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("child bootstrap records assistant usage on completed turns and heartbeats", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-usage-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 40, totalTokens: 1540, cost: { input: 0.003, output: 0.003, cacheRead: 0.0003, cacheWrite: 0.00012, total: 0.00642 } } },
      { role: "assistant", content: [{ type: "text", text: "done again" }], usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { input: 0.0015, output: 0.0015, cacheRead: 0, cacheWrite: 0, total: 0.003 } } },
    ] } as any, { cwd: root });

    const turns = JSON.parse(await readFile(join(root, "jobs", "child-1", "turns", "turns.json"), "utf8"));
    assert.equal(turns.turns[0].messagePreview, "done again");
    assert.deepEqual(turns.turns[0].usage, { input: 1500, output: 300, cacheRead: 300, cacheWrite: 40, totalTokens: 2140, cost: { input: 0.0045, output: 0.0045, cacheRead: 0.0003, cacheWrite: 0.00012, total: 0.00942 } });

    const heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.usage.totalTokens, 2140);
    assert.equal(heartbeat.usage.cost.total, 0.00942);

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("child bootstrap records each completed turn and updates the latest result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-existing-result-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  await mkdir(join(root, "jobs", "child-1"), { recursive: true });
  await writeFile(resultPath, "previous result\n", "utf8");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "first result" }] },
    ] } as any, { cwd: root });
    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "second result" }] },
    ] } as any, { cwd: root });

    assert.equal(await readFile(resultPath, "utf8"), "second result\n");
    assert.equal(await readFile(join(root, "jobs", "child-1", "turns", "001-result.md"), "utf8"), "first result\n");
    assert.equal(await readFile(join(root, "jobs", "child-1", "turns", "002-result.md"), "utf8"), "second result\n");

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("child bootstrap records and clears ask_question attention", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-attention-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();
    await handlers.session_start?.({ type: "session_start" } as any, { cwd: root });
    await handlers.tool_call?.({ toolName: "ask_question", toolCallId: "ask-1", input: { question: "Choose auth path?" } } as any, { cwd: root });

    let heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
    assert.deepEqual(heartbeat.attention, { kind: "question", message: "Choose auth path?", updatedAt: heartbeat.attention.updatedAt, toolCallId: "ask-1" });

    await handlers.tool_result?.({ toolCallId: "ask-1" } as any, { cwd: root });
    heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.attention, undefined);

    await handlers.tool_call?.({ toolName: "read", toolCallId: "read-1", input: { path: "README.md" } } as any, { cwd: root });
    heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.attention, undefined);

    await handlers.tool_call?.({ toolName: "ask_question", toolCallId: "ask-2", input: { question: "Still proceed?" } } as any, { cwd: root });
    await handlers.agent_start?.({ type: "agent_start" } as any, { cwd: root });
    heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
    assert.equal(heartbeat.attention, undefined);

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("child bootstrap never exposes partial control JSON during overlapping writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-atomic-json-test-"));
  const hubDir = join(root, "hub");
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const heartbeatPath = join(root, "jobs", "child-1", "heartbeat.json");
  const turnsPath = join(root, "jobs", "child-1", "turns", "turns.json");
  const hubHeartbeatPath = join(hubDir, "heartbeats", "child-1.json");
  await mkdir(join(root, "jobs", "child-1", "turns"), { recursive: true });
  await mkdir(join(hubDir, "heartbeats"), { recursive: true });
  await writeFile(heartbeatPath, JSON.stringify({ state: "waiting" }), "utf8");
  await writeFile(turnsPath, JSON.stringify({ version: 1, turns: Array.from({ length: 4_000 }, (_, index) => ({ index: index + 1, status: "waiting", resultPath: `/tmp/${index}`, messagePreview: "x".repeat(120) })) }), "utf8");
  await writeFile(hubHeartbeatPath, JSON.stringify({ state: "waiting" }), "utf8");

  await withChildEnv(root, resultPath, async () => {
    process.env.PI_AGENT_HUB_DIR = hubDir;
    process.env.PI_AGENT_HUB_SESSION_ID = "child-1";
    process.env.PI_SUBAGENT_TASK_PREVIEW = "task".repeat(250_000);
    const handlers = loadBootstrapHandlers();
    const watching = { active: true };
    const parseErrors: Error[] = [];
    let observations = 0;
    const watch = async (path: string) => {
      while (watching.active) {
        try {
          JSON.parse(await readFile(path, "utf8"));
          observations += 1;
        } catch (error) {
          parseErrors.push(error as Error);
        }
        await waitImmediate();
      }
    };
    const readers = [heartbeatPath, turnsPath, hubHeartbeatPath].map(watch);
    try {
      await waitImmediate();
      const largeCwd = `/tmp/${"cwd".repeat(250_000)}`;
      await handlers.session_start?.({ type: "session_start" } as any, { cwd: largeCwd });
      await Promise.all([
        ...Array.from({ length: 12 }, () => handlers.agent_start?.({ type: "agent_start" } as any, { cwd: `${largeCwd}-running` })),
        ...Array.from({ length: 4 }, (_, index) => handlers.agent_end?.({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: `result ${index}` }] }] } as any, { cwd: `${largeCwd}-done` })),
      ]);
      watching.active = false;
      await Promise.all(readers);

      assert.ok(observations > 0);
      assert.deepEqual(parseErrors, []);
      for (const path of [heartbeatPath, turnsPath, hubHeartbeatPath]) JSON.parse(await readFile(path, "utf8"));
      const temporaryFiles = [
        ...readdirSync(join(root, "jobs", "child-1")),
        ...readdirSync(join(root, "jobs", "child-1", "turns")),
        ...readdirSync(join(hubDir, "heartbeats")),
      ].filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(temporaryFiles, []);
    } finally {
      watching.active = false;
      await Promise.all(readers);
      await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
    }
  });
});

test("child bootstrap mirrors heartbeats to pi-agent-hub when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-hub-heartbeat-test-"));
  const hubDir = join(root, "hub");
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    process.env.PI_AGENT_HUB_DIR = hubDir;
    process.env.PI_AGENT_HUB_SESSION_ID = "child-1";
    process.env.PI_AGENT_HUB_PARENT_ID = "parent-1";
    process.env.PI_AGENT_HUB_KIND = "subagent";
    process.env.PI_SUBAGENT_AGENT = "scout";
    process.env.PI_SUBAGENT_TASK_PREVIEW = "Inspect auth";

    const handlers = loadBootstrapHandlers();
    await handlers.session_start?.({ type: "session_start" } as any, { cwd: root });

    const heartbeat = JSON.parse(await readFile(join(hubDir, "heartbeats", "child-1.json"), "utf8"));
    assert.equal(heartbeat.kind, "subagent");
    assert.equal(heartbeat.parentId, "parent-1");
    assert.equal(heartbeat.agentName, "scout");
    assert.equal(heartbeat.taskPreview, "Inspect auth");

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

function loadBootstrapHandlers(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  childBootstrap({
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
  } as any);
  return handlers;
}

async function withChildEnv(root: string, resultPath: string, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  const keys = [
    "PI_TMUX_SUBAGENTS_JOB_ID",
    "PI_TMUX_SUBAGENTS_DIR",
    "PI_SUBAGENT_RESULT_PATH",
    "PI_AGENT_HUB_DIR",
    "PI_AGENT_HUB_SESSION_ID",
    "PI_AGENT_HUB_PARENT_ID",
    "PI_AGENT_HUB_KIND",
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_DISPLAY_NAME",
    "PI_SUBAGENT_TASK_PREVIEW",
  ];
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PI_TMUX_SUBAGENTS_JOB_ID = "child-1";
  process.env.PI_TMUX_SUBAGENTS_DIR = root;
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
