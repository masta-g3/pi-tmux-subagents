import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { parseSubagentsCommand, resolveAutoStopOnComplete, shouldSkipNpmPackageForLocalDev } from "../src/index.js";

function killTmuxSession(name: string) {
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
  } catch {
    // Session may already be gone.
  }
}

function createTmuxSession(name: string) {
  killTmuxSession(name);
  execFileSync("tmux", ["new-session", "-d", "-s", name, "sleep 100"], { stdio: "ignore" });
}

type WidgetContent = string[] | ((tui: { requestRender(): void }, theme: any) => { render(width: number): string[] }) | undefined;
type WidgetCall = [string, WidgetContent, { placement?: string } | undefined];

function renderWidget(content: WidgetContent, width = 120, requestRender: () => void = () => {}): string[] | undefined {
  if (!content || Array.isArray(content)) return content;
  return content({ requestRender }, { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text }).render(width);
}

async function waitForWidget(widgets: WidgetCall[], matcher: (content: string[] | undefined) => boolean) {
  for (let index = 0; index < 10; index += 1) {
    const latest = renderWidget(widgets.at(-1)?.[1]);
    if (matcher(latest)) return latest;
    await waitImmediate();
  }
  return renderWidget(widgets.at(-1)?.[1]);
}

async function handlersShutdown(handlers: Map<string, Function>) {
  await handlers.get("session_shutdown")?.();
}

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

test("tmux_subagent uses canonical parent status and widget keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-status-test-"));
  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  try {
    const handlers = new Map<string, Function>();
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: WidgetCall[] = [];
    extension({
      registerTool() {},
      on(name: string, handler: Function) { handlers.set(name, handler); },
    } as any);

    await handlers.get("session_start")?.({}, {
      cwd: process.cwd(),
      ui: {
        theme: {
          colors: { muted: true },
          fg(this: { colors: Record<string, boolean> }, token: string, text: string) {
            assert.ok(this.colors);
            return `<${token}>${text}</${token}>`;
          },
        },
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
        setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => widgets.push([key, content, options]),
      },
    });

    assert.deepEqual(statuses, [["pi-tmux-subagents", undefined]]);
    assert.deepEqual(widgets, [["pi-tmux-subagents", undefined, undefined]]);
  } finally {
    restorePiEnv();
  }
});

test("tmux_subagent retains auto-stopped completions briefly and then clears", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-retention-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "retained-child";
  const tmuxSession = `pi-tmux-retention-${process.pid}`;
  mkdirSync(join(state, "jobs", id), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "scout", displayName: "scout-retained", taskPreview: "Finish retained child", cwd: root, tmuxSession, status: "running", resultPath: join(state, "jobs", id, "result.md"), createdAt: 90_000, updatedAt: 90_000, autoStopOnComplete: true }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "heartbeat.json"), `${JSON.stringify({ jobId: id, cwd: root, state: "waiting", stateSince: 99_000, updatedAt: 99_000, seenRunning: true }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "result.md"), "Done\n");

  const restorePiEnv = isolatePiStateEnv(agentDir);
  const handlers = new Map<string, Function>();
  const widgets: WidgetCall[] = [];
  let tool: any;
  createTmuxSession(tmuxSession);
  try {
    extension({
      registerTool(def: any) { tool = def; },
      on(name: string, handler: Function) { handlers.set(name, handler); },
    } as any);
    await handlers.get("session_start")?.({}, { cwd: root, ui: { setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => widgets.push([key, content, options]) } });

    await tool.execute("call", { action: "status", childId: id }, undefined, undefined, { cwd: root });

    assert.match(renderWidget(widgets.at(-1)?.[1])?.join("\n") ?? "", /scout-retained/);
    t.mock.timers.tick(10_001);
    assert.equal(widgets.at(-1)?.[1], undefined);
  } finally {
    await handlersShutdown(handlers);
    killTmuxSession(tmuxSession);
    restorePiEnv();
  }
});

test("tmux_subagent summary widget expires stale summaries while idle", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 200_000 });
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-summary-expiry-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const hub = join(root, "hub");
  const id = "summary-child";
  const tmuxSession = `pi-tmux-summary-${process.pid}`;
  mkdirSync(join(state, "jobs", id), { recursive: true });
  mkdirSync(join(hub, "session-metadata"), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "scout", displayName: "scout-summary", taskPreview: "Keep summary fallback", cwd: root, tmuxSession, status: "running", resultPath: join(state, "jobs", id, "result.md"), createdAt: 100_000, updatedAt: 100_000, autoStopOnComplete: false }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "heartbeat.json"), `${JSON.stringify({ jobId: id, cwd: root, state: "waiting", stateSince: 199_000, updatedAt: 199_000, seenRunning: true }, null, 2)}\n`);
  writeFileSync(join(hub, "session-metadata", `${id}.json`), `${JSON.stringify({ source: "pi-session-summary", status: "Fresh summary detail", stage: "waiting", updatedAt: 200_000 }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  process.env.PI_AGENT_HUB_DIR = hub;
  const handlers = new Map<string, Function>();
  const widgets: WidgetCall[] = [];
  let tool: any;
  createTmuxSession(tmuxSession);
  try {
    extension({
      registerTool(def: any) { tool = def; },
      on(name: string, handler: Function) { handlers.set(name, handler); },
    } as any);
    await handlers.get("session_start")?.({}, { cwd: root, ui: { setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => widgets.push([key, content, options]) } });

    await tool.execute("call", { action: "status", childId: id }, undefined, undefined, { cwd: root });
    const fresh = await waitForWidget(widgets, (content) => /Fresh summary detail/.test(content?.join("\n") ?? ""));
    assert.match(fresh?.join("\n") ?? "", /Fresh summary detail/);
    let ageRenders = 0;
    renderWidget(widgets.at(-1)?.[1], 120, () => { ageRenders += 1; });

    t.mock.timers.tick(60_002);
    assert.ok(ageRenders > 0);
    assert.doesNotMatch(renderWidget(widgets.at(-1)?.[1])?.join("\n") ?? "", /Fresh summary detail/);
    assert.match(renderWidget(widgets.at(-1)?.[1])?.join("\n") ?? "", /Keep summary fallback/);
    await handlersShutdown(handlers);
    const rendersAfterShutdown = ageRenders;
    t.mock.timers.tick(60_000);
    assert.equal(ageRenders, rendersAfterShutdown);
  } finally {
    await handlersShutdown(handlers);
    killTmuxSession(tmuxSession);
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

test("tmux_subagent global status hides old stopped jobs unless requested", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-status-filter-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  mkdirSync(state, { recursive: true });
  const stoppedJobs = Array.from({ length: 7 }, (_, index) => ({
    id: `stopped-${index + 1}`,
    agentName: "scout",
    taskPreview: `Stopped ${index + 1}`,
    cwd: root,
    tmuxSession: `pi-agent-hub-stopped-${index + 1}`,
    status: "stopped",
    resultPath: join(state, "jobs", `stopped-${index + 1}`, "result.md"),
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [
      ...stoppedJobs,
      { id: "error-1", agentName: "scout", taskPreview: "Needs review", cwd: root, tmuxSession: "pi-agent-hub-error-1", status: "error", resultPath: join(state, "jobs", "error-1", "result.md"), createdAt: 20, updatedAt: 20 },
    ],
  }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const filtered = await tool.execute("call", { action: "status" }, undefined, undefined, { cwd: root });
    assert.match(filtered.content[0].text, /error-1 error scout: Needs review/);
    assert.match(filtered.content[0].text, /stopped-7 stopped scout: Stopped 7/);
    assert.doesNotMatch(filtered.content[0].text, /stopped-1 stopped scout: Stopped 1/);
    assert.match(filtered.content[0].text, /2 older stopped children hidden/);
    assert.match(filtered.content[0].text, /includeStopped: true/);
    assert.equal(filtered.details.jobs.length, 6);

    const full = await tool.execute("call", { action: "status", includeStopped: true }, undefined, undefined, { cwd: root });
    assert.match(full.content[0].text, /stopped-1 stopped scout: Stopped 1/);
    assert.doesNotMatch(full.content[0].text, /older stopped child hidden/);
    assert.equal(full.details.jobs.length, 8);
  } finally {
    restorePiEnv();
  }
});

test("tmux_subagent exposes stop as a shutdown alias", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.ok(tool.parameters.properties.action.enum.includes("stop"));
});

test("tmux_subagent registers subagent manager command and shortcuts", () => {
  let command: any;
  const shortcuts: any[] = [];
  extension({
    registerTool() {},
    on() {},
    registerCommand(name: string, def: any) { command = { name, ...def }; },
    registerShortcut(key: string, def: any) { shortcuts.push({ key, ...def }); },
  } as any);

  assert.equal(command.name, "subagents");
  assert.match(command.description, /manager/);
  assert.doesNotMatch(command.description, /details\s+widget|peek\s+mode/);
  assert.deepEqual(shortcuts.map((shortcut) => shortcut.key), ["alt+s", "ctrl+alt+s"]);
  assert.match(shortcuts[0].description, /Open.*manager/i);
});

test("subagents command rejects removed widget mode verbs", async () => {
  let command: any;
  const notifications: string[] = [];
  extension({
    registerTool() {},
    on() {},
    registerCommand(name: string, def: any) { command = { name, ...def }; },
  } as any);
  const ctx = { cwd: process.cwd(), ui: { notify: (message: string) => notifications.push(message) } };

  for (const verb of ["peek", "details", "show", "hide", "on", "off"]) await command.handler(verb, ctx);

  assert.equal(notifications.length, 6);
  assert.ok(notifications.every((message) => /Unknown subagents command/.test(message)));
});

test("subagents command parser preserves reply message casing", () => {
  assert.deepEqual(parseSubagentsCommand("reply child-123 Mixed CASE text"), { verb: "reply", id: "child-123", message: "Mixed CASE text" });
  assert.deepEqual(parseSubagentsCommand("VIEW"), { verb: "view" });
});

test("subagents command and shortcuts open the manager while library stays separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-command-ui-test-"));
  const restorePiEnv = isolatePiStateEnv(join(root, "agent"));
  try {
    let command: any;
    const shortcuts: any[] = [];
    const customCalls: unknown[] = [];
    extension({
      registerTool() {},
      on() {},
      registerCommand(name: string, def: any) { if (name === "subagents") command = def; },
      registerShortcut(key: string, def: any) { shortcuts.push({ key, ...def }); },
    } as any);
    const ctx = { cwd: root, ui: { custom: async (factory: Function) => { customCalls.push(factory({ requestRender() {} }, {}, {}, () => undefined)); } } };

    await command.handler("", ctx);
    await command.handler("view", ctx);
    await command.handler("library", ctx);
    await shortcuts[0].handler(ctx);
    await shortcuts[1].handler(ctx);

    assert.equal(customCalls.length, 5);
  } finally {
    restorePiEnv();
  }
});

test("subagents manager hides the ambient widget until the manager closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-manager-widget-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "visible-child";
  const tmuxSession = `pi-tmux-manager-widget-${process.pid}`;
  mkdirSync(join(state, "jobs", id), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "scout", displayName: "scout-visible", taskPreview: "Stay visible", cwd: root, tmuxSession, status: "running", resultPath: join(state, "jobs", id, "result.md"), createdAt: Date.now() - 1_000, updatedAt: Date.now(), autoStopOnComplete: false }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "heartbeat.json"), `${JSON.stringify({ jobId: id, cwd: root, state: "running", stateSince: Date.now() - 1_000, updatedAt: Date.now(), seenRunning: true }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  const handlers = new Map<string, Function>();
  const widgets: WidgetCall[] = [];
  createTmuxSession(tmuxSession);
  try {
    let command: any;
    let tool: any;
    extension({
      registerTool(def: any) { tool = def; },
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerCommand(name: string, def: any) { if (name === "subagents") command = def; },
    } as any);
    const ui = {
      setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => widgets.push([key, content, options]),
      custom: async (factory: Function) => {
        assert.equal(widgets.at(-1)?.[1], undefined);
        const component = factory({ requestRender() {} }, {}, {}, () => undefined);
        assert.match(component.render(100).join("\n"), /scout-visible/);
        return { type: "close" };
      },
      notify() {},
    };
    await handlers.get("session_start")?.({}, { cwd: root, ui });
    await tool.execute("call", { action: "status", childId: id }, undefined, undefined, { cwd: root });
    assert.match(renderWidget(widgets.at(-1)?.[1])?.join("\n") ?? "", /scout-visible/);

    await command.handler("view", { cwd: root, ui });

    assert.match(renderWidget(widgets.at(-1)?.[1])?.join("\n") ?? "", /scout-visible/);
  } finally {
    await handlersShutdown(handlers);
    killTmuxSession(tmuxSession);
    restorePiEnv();
  }
});

test("subagents manager reopens after dialog actions but attach exits to the editor", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-manager-action-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "idle-child";
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "scout", displayName: "scout-idle", taskPreview: "Wait for follow-up", cwd: root, tmuxSession: "missing-idle-child", status: "waiting", resultPath: join(state, "jobs", id, "result.md"), createdAt: 1, updatedAt: 2, autoStopOnComplete: false }],
  }, null, 2)}\n`);
  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let command: any;
    extension({ registerTool() {}, on() {}, registerCommand(name: string, def: any) { if (name === "subagents") command = def; } } as any);

    const replyActions = [{ type: "reply", id }, { type: "close" }];
    let replyViews = 0;
    const replyNotices: string[] = [];
    await command.handler("view", { cwd: root, ui: {
      custom: async () => { replyViews += 1; return replyActions.shift(); },
      input: async () => undefined,
      notify: (message: string) => replyNotices.push(message),
    } });
    assert.equal(replyViews, 2);
    assert.deepEqual(replyNotices, []);

    const resultActions = [{ type: "result", id }, { type: "close" }];
    let resultViews = 0;
    const resultNotices: string[] = [];
    await command.handler("view", { cwd: root, ui: {
      custom: async () => { resultViews += 1; return resultActions.shift(); },
      notify: (message: string) => resultNotices.push(message),
    } });
    assert.equal(resultViews, 2);
    assert.match(resultNotices[0] ?? "", /Result:/);

    let attachViews = 0;
    let editorText = "";
    await command.handler("view", { cwd: root, ui: {
      custom: async () => { attachViews += 1; return { type: "attach", id }; },
      setEditorText: (text: string) => { editorText = text; },
      notify() {},
    } });
    assert.equal(attachViews, 1);
    assert.match(editorText, /^!tmux attach-session/);
  } finally {
    restorePiEnv();
  }
});

test("open manager refreshes live metadata in place and disposes its timer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-manager-live-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const hub = join(root, "hub");
  const id = "live-child";
  const tmuxSession = `pi-tmux-manager-live-${process.pid}`;
  mkdirSync(state, { recursive: true });
  mkdirSync(join(hub, "session-metadata"), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({ version: 1, jobs: [] }, null, 2)}\n`);
  const metadataPath = join(hub, "session-metadata", `${id}.json`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  process.env.PI_AGENT_HUB_DIR = hub;
  try {
    let command: any;
    let component: any;
    let renders = 0;
    const handlers = new Map<string, Function>();
    extension({ registerTool() {}, on(name: string, handler: Function) { handlers.set(name, handler); }, registerCommand(name: string, def: any) { if (name === "subagents") command = def; } } as any);
    const commandPromise = command.handler("view", { cwd: root, ui: {
      custom: async (factory: Function) => new Promise((resolve) => {
        component = factory({ requestRender: () => { renders += 1; } }, {}, {}, resolve);
      }),
      notify() {},
    } });
    for (let index = 0; index < 100 && !component; index += 1) await waitImmediate();
    assert.ok(component, "manager component did not mount");
    assert.match(component.render(100).join("\n"), /No tmux subagent jobs/);

    mkdirSync(join(state, "jobs", id), { recursive: true });
    writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
      version: 1,
      jobs: [{ id, agentName: "scout", displayName: "scout-live", taskPreview: "Fallback task", cwd: root, tmuxSession, status: "running", resultPath: join(state, "jobs", id, "result.md"), createdAt: Date.now() - 10_000, updatedAt: Date.now() - 1_000, autoStopOnComplete: false }],
    }, null, 2)}\n`);
    writeFileSync(join(state, "jobs", id, "heartbeat.json"), `${JSON.stringify({ jobId: id, cwd: root, state: "running", stateSince: Date.now() - 10_000, updatedAt: Date.now() - 1_000, seenRunning: true }, null, 2)}\n`);
    writeFileSync(metadataPath, `${JSON.stringify({ source: "pi-session-summary", status: "Manual status", stage: "testing", updatedAt: Date.now() }, null, 2)}\n`);
    createTmuxSession(tmuxSession);
    component.handleInput("R");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(component.render(100).join("\n"), /testing · Manual status/);

    writeFileSync(metadataPath, `${JSON.stringify({ source: "pi-session-summary", status: "Updated status", stage: "reviewing", updatedAt: Date.now() }, null, 2)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    for (let index = 0; index < 20; index += 1) await waitImmediate();
    assert.match(component.render(100).join("\n"), /reviewing · Updated status/);

    await handlersShutdown(handlers);
    const rendersBeforeClose = renders;
    component.handleInput("\u001b");
    await commandPromise;
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    assert.equal(renders, rendersBeforeClose);
  } finally {
    killTmuxSession(tmuxSession);
    restorePiEnv();
  }
});

test("manager observation applies auto-stop before rendering completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-manager-autostop-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "completed-child";
  const tmuxSession = `pi-tmux-manager-autostop-${process.pid}`;
  mkdirSync(join(state, "jobs", id), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "scout", displayName: "scout-complete", taskPreview: "Finish", cwd: root, tmuxSession, status: "running", resultPath: join(state, "jobs", id, "result.md"), createdAt: 1, updatedAt: 2, autoStopOnComplete: true }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "heartbeat.json"), `${JSON.stringify({ jobId: id, cwd: root, state: "waiting", stateSince: 2, updatedAt: 3, seenRunning: true }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "result.md"), "Completed result\n");
  const restorePiEnv = isolatePiStateEnv(agentDir);
  createTmuxSession(tmuxSession);
  try {
    let command: any;
    let rendered = "";
    extension({ registerTool() {}, on() {}, registerCommand(name: string, def: any) { if (name === "subagents") command = def; } } as any);
    await command.handler("view", { cwd: root, ui: {
      custom: async (factory: Function) => {
        const component = factory({ requestRender() {} }, {}, {}, () => undefined);
        rendered = component.render(100).join("\n");
        return { type: "close" };
      },
      notify() {},
    } });

    assert.match(rendered, /Done  1/);
    assert.match(rendered, /scout-complete/);
    assert.doesNotMatch(rendered, /s stop|a attach/);
    assert.throws(() => execFileSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "ignore" }));
  } finally {
    killTmuxSession(tmuxSession);
    restorePiEnv();
  }
});

test("subagents view limits historical stopped rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-view-history-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  mkdirSync(state, { recursive: true });
  const jobs = Array.from({ length: 20 }, (_, index) => ({
    id: `stopped-${String(index + 1).padStart(2, "0")}`,
    agentName: "scout",
    displayName: `stopped-${String(index + 1).padStart(2, "0")}`,
    taskPreview: `Stopped ${index + 1}`,
    cwd: root,
    tmuxSession: `missing-stopped-${index + 1}`,
    status: "stopped",
    resultPath: join(state, "jobs", `stopped-${index + 1}`, "result.md"),
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let command: any;
    let rendered = "";
    extension({
      registerTool() {},
      on() {},
      registerCommand(name: string, def: any) { if (name === "subagents") command = def; },
    } as any);

    await command.handler("view", { cwd: root, ui: { custom: async (factory: Function) => { rendered = factory({}, {}, {}, () => undefined).render(120).join("\n"); } } });

    assert.match(rendered, /stopped-20/);
    assert.match(rendered, /stopped-16/);
    assert.doesNotMatch(rendered, /stopped-15/);
    assert.doesNotMatch(rendered, /stopped-01/);
  } finally {
    restorePiEnv();
  }
});

test("npm install self-disables when an enabled local dev package is configured", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-package-skip-test-"));
  const npmRoot = join(root, "agent", "npm", "node_modules", "pi-tmux-subagents");
  const localRoot = join(root, "checkout");
  const settingsPath = join(root, "agent", "settings.json");
  mkdirSync(npmRoot, { recursive: true });
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "pi-tmux-subagents" }));
  writeFileSync(join(localRoot, "package.json"), JSON.stringify({ name: "pi-tmux-subagents" }));
  writeFileSync(settingsPath, JSON.stringify({ packages: [localRoot] }));

  assert.equal(shouldSkipNpmPackageForLocalDev({ currentRoot: npmRoot, settingsFiles: [settingsPath] }), true);
});

test("npm install does not self-disable for filtered or non-local packages", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-package-noskip-test-"));
  const npmRoot = join(root, "agent", "npm", "node_modules", "pi-tmux-subagents");
  const localRoot = join(root, "checkout");
  const settingsPath = join(root, "agent", "settings.json");
  mkdirSync(npmRoot, { recursive: true });
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(npmRoot, "package.json"), JSON.stringify({ name: "pi-tmux-subagents" }));
  writeFileSync(join(localRoot, "package.json"), JSON.stringify({ name: "pi-tmux-subagents" }));
  writeFileSync(settingsPath, JSON.stringify({ packages: [
    { source: localRoot, extensions: [] },
    "npm:pi-tmux-subagents",
  ] }));

  assert.equal(shouldSkipNpmPackageForLocalDev({ currentRoot: npmRoot, settingsFiles: [settingsPath] }), false);
  assert.equal(shouldSkipNpmPackageForLocalDev({ currentRoot: localRoot, settingsFiles: [settingsPath] }), false);
});

test("tmux_subagent exposes persistent send and wait actions", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.ok(tool.parameters.properties.action.enum.includes("send"));
  assert.ok(tool.parameters.properties.action.enum.includes("wait"));
  assert.equal(tool.parameters.properties.message.type, "string");
  assert.equal(tool.parameters.properties.label.type, "string");
  assert.match(tool.parameters.properties.label.description, /worker-auth/);
  assert.equal(tool.parameters.properties.model.type, "string");
  assert.match(tool.parameters.properties.model.description, /Override/);
  assert.equal(tool.parameters.properties.includeStopped.type, "boolean");
  assert.match(tool.parameters.properties.includeStopped.description, /historical/);
  assert.equal(tool.parameters.properties.timeoutMs.type, "number");
  assert.match(tool.description, /Prefer background launches/);
  assert.match(tool.parameters.properties.wait.description, /Prefer false/);
  assert.match(tool.parameters.properties.childId.description, /omit to return when any active child completes/);
});

test("tmux_subagent launch applies one-shot model override", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-model-test-"));
  const agentDir = join(root, "agent");
  const binDir = join(root, "bin");
  const logPath = join(root, "tmux.log");
  mkdirSync(binDir, { recursive: true });
  const tmuxPath = join(binDir, "tmux");
  writeFileSync(tmuxPath, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$TMUX_LOG\"\nexit 0\n");
  chmodSync(tmuxPath, 0o755);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  const oldPath = process.env.PATH;
  const oldTmuxLog = process.env.TMUX_LOG;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  process.env.TMUX_LOG = logPath;
  const handlers = new Map<string, Function>();
  let tool: any;
  try {
    extension({
      registerTool(def: any) { tool = def; },
      on(name: string, handler: Function) { handlers.set(name, handler); },
    } as any);
    const result = await tool.execute("call", { agent: "scout", task: "Inspect auth", model: " openai-codex/gpt-5.6-sol ", background: true }, undefined, undefined, { cwd: root });

    assert.equal(result.details.model, "openai-codex/gpt-5.6-sol");
    assert.match(readFileSync(logPath, "utf8"), /'--model' 'openai-codex\/gpt-5\.6-sol:low'/);
  } finally {
    await handlersShutdown(handlers);
    restorePiEnv();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTmuxLog === undefined) delete process.env.TMUX_LOG;
    else process.env.TMUX_LOG = oldTmuxLog;
  }
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

test("tmux_subagent get with childId explains child result lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-get-child-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "child-get-hint";
  const turnPath = join(state, "jobs", id, "turns", "001-result.md");
  mkdirSync(join(state, "jobs", id, "turns"), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "code-critic", taskPreview: "Review", cwd: root, tmuxSession: "missing-session", status: "stopped", resultPath: join(state, "jobs", id, "result.md"), createdAt: 1, updatedAt: 2 }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "result.md"), "LGTM\n");
  writeFileSync(turnPath, "LGTM\n");
  writeFileSync(join(state, "jobs", id, "turns", "turns.json"), `${JSON.stringify({ version: 1, turns: [{ index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: turnPath }] }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { action: "get", childId: "child-get" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /`get` reads agent definitions/);
    assert.match(result.content[0].text, /tmux_subagent\(\{ action: "status", childId: "child-get-hint" \}\)/);
    assert.match(result.content[0].text, /read\(\{ path: ".*001-result\.md", limit: 2000 \}\)/);
  } finally {
    restorePiEnv();
  }
});

test("tmux_subagent send to stopped child points at the result", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-send-stopped-test-"));
  const agentDir = join(root, "agent");
  const state = join(agentDir, "pi-tmux-subagents");
  const id = "child-send-stopped";
  const turnPath = join(state, "jobs", id, "turns", "001-result.md");
  mkdirSync(join(state, "jobs", id, "turns"), { recursive: true });
  writeFileSync(join(state, "jobs.json"), `${JSON.stringify({
    version: 1,
    jobs: [{ id, agentName: "code-critic", taskPreview: "Review", cwd: root, tmuxSession: "missing-session", status: "stopped", resultPath: join(state, "jobs", id, "result.md"), createdAt: 1, updatedAt: 2 }],
  }, null, 2)}\n`);
  writeFileSync(join(state, "jobs", id, "result.md"), "LGTM\n");
  writeFileSync(turnPath, "LGTM\n");
  writeFileSync(join(state, "jobs", id, "turns", "turns.json"), `${JSON.stringify({ version: 1, turns: [{ index: 1, status: "waiting", startedAt: 1, completedAt: 2, resultPath: turnPath }] }, null, 2)}\n`);

  const restorePiEnv = isolatePiStateEnv(agentDir);
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { action: "send", childId: "child-send", message: "again" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Cannot send to stopped subagent/);
    assert.match(result.content[0].text, /Result is available at: .*001-result\.md/);
    assert.match(result.content[0].text, /read\(\{ path: ".*001-result\.md", limit: 2000 \}\)/);
  } finally {
    restorePiEnv();
  }
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
        model: "openai/gpt-5",
        resultPath: "/tmp/result.md",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      heartbeat: { jobId: "child-123", cwd: "/repo", state: "running", stateSince: 1_500, updatedAt: Date.now(), usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 } } },
      preview: "## Scope",
    },
  }, { expanded: false, isPartial: true }, theme, {}).render(120).join("\n");

  assert.match(rendered, /^<muted>tmux subagent plan-critic<\/muted>/);
  assert.match(rendered, /<warning>⟳<\/warning> <muted>running · 0s · activity 0s ago · 300 out · \$0\.006<\/muted>/);
  assert.doesNotMatch(rendered, /<dim>model:<\/dim>/);
  assert.doesNotMatch(rendered, /1\.2k in/);
  assert.doesNotMatch(rendered, /Pane preview/);
  assert.doesNotMatch(rendered, /## Scope/);
  assert.doesNotMatch(rendered, /attach:/);
  assert.doesNotMatch(rendered, /stop:/);
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
