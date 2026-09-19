import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, type PathLike } from "node:fs";
import fs, { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childBootstrap from "../src/child-bootstrap.js";
import { getSubagentStatus } from "../src/run.js";

test("child completion waits for settled and preserves errors and aborts", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-settled-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  try {
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      const ctx = { cwd: root, isIdle: () => true };
      const heartbeat = () => readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8").then(JSON.parse);
      try {
        await handlers.agent_start?.({}, ctx);
        await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] }, ctx);
        assert.equal((await heartbeat()).state, "running", "agent_end may be followed by automatic continuation");
        await handlers.agent_settled?.({}, { ...ctx, isIdle: () => false });
        assert.equal((await heartbeat()).state, "running", "another extension may start a continuation");
        await handlers.agent_settled?.({}, ctx);
        assert.equal((await heartbeat()).state, "waiting");
        for (const stopReason of ["error", "aborted"]) {
          await handlers.agent_start?.({}, ctx);
          await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason, errorMessage: "Interrupted", content: [] }] }, ctx);
          await handlers.agent_settled?.({}, ctx);
          const state = await heartbeat();
          assert.equal(state.state, "error");
          assert.match(state.message, /Interrupted/);
          assert.equal(await readFile(resultPath, "utf8"), "done\n");
        }
      } finally {
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new one-shot children close after successful publication and finalize on shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-one-shot-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  try {
    await writeJobRegistry(root, { autoStopOnComplete: true, idleTimeoutMs: 900_000 });
    await withChildEnv(root, resultPath, async () => {
      const hubDir = join(root, "hub");
      await mkdir(join(hubDir, "heartbeats"), { recursive: true });
      await writeFile(join(hubDir, "registry.json"), JSON.stringify({ sessions: [{ id: "child-1" }] }), "utf8");
      process.env.PI_AGENT_HUB_DIR = hubDir;
      process.env.PI_AGENT_HUB_SESSION_ID = "child-1";
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify() {} } };
      await handlers.session_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "stop", content: "done" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);

      assert.equal(shutdowns, 1);
      const waiting = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(waiting.state, "waiting");
      assert.equal(typeof waiting.idleSince, "number");

      await handlers.session_shutdown?.({}, ctx);
      const registry = JSON.parse(await readFile(join(root, "jobs.json"), "utf8"));
      assert.equal(registry.jobs[0].status, "stopped");
      assert.equal(registry.jobs[0].autoStopped, true);
      assert.equal(JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8")).state, "waiting", "automatic teardown must not publish shutdown");
      assert.deepEqual(JSON.parse(await readFile(join(hubDir, "registry.json"), "utf8")).sessions, []);
      await assert.rejects(readFile(join(hubDir, "heartbeats", "child-1.json"), "utf8"), { code: "ENOENT" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child lifetimes distinguish finite, indefinite, and legacy policies", async (t) => {
  for (const [idleTimeoutMs, expectedShutdowns] of [[10, 1], [0, 0], [undefined, 0]] as const) {
    const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-reusable-test-"));
    const resultPath = join(root, "jobs", "child-1", "result.md");
    let tick: (() => void) | undefined;
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return 1 as any; });
    try {
      await writeJobRegistry(root, { autoStopOnComplete: idleTimeoutMs === undefined, idleTimeoutMs });
      await withChildEnv(root, resultPath, async () => {
        const handlers = loadBootstrapHandlers();
        let shutdowns = 0;
        const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify() {} } };
        await handlers.session_start?.({}, ctx);
        await handlers.agent_start?.({}, ctx);
        await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
        await handlers.agent_settled?.({}, ctx);
        assert.equal(shutdowns, 0);
        now += 10;
        await tick!();
        assert.equal(shutdowns, expectedShutdowns);
        await handlers.session_shutdown?.({}, ctx);
      });
    } finally {
      t.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("idle expiry protects active work, input and failures, then resets after success", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-protected-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  let now = 1_000;
  let tick: (() => void) | undefined;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return undefined; });
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 100 });
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown() { shutdowns++; }, ui: { notify() {} } };
      const succeed = async () => {
        await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
        await handlers.agent_settled?.({}, ctx);
      };
      try {
        await handlers.session_start?.({}, ctx);
        now += 1_000;
        await tick!();
        assert.equal(shutdowns, 0, "startup idle has no successful run to expire");
        await handlers.agent_start?.({}, ctx);
        await succeed();
        await handlers.tool_call?.({ toolName: "ask_question", toolCallId: "question", input: { question: "Proceed?" } }, ctx);
        now += 100;
        await tick!();
        assert.equal(shutdowns, 0, "explicit input keeps an idle child open");
        await handlers.tool_result?.({ toolCallId: "question" }, ctx);
        await handlers.agent_start?.({}, ctx);
        now += 1_000;
        await tick!();
        assert.equal(shutdowns, 0, "new work cancels the old idle deadline");
        for (const stopReason of ["error", "aborted"]) {
          await handlers.agent_start?.({}, ctx);
          await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason, errorMessage: "Interrupted", content: [] }] }, ctx);
          await handlers.agent_settled?.({}, ctx);
          now += 1_000;
          await tick!();
          assert.equal(shutdowns, 0, stopReason);
        }
        await handlers.agent_start?.({}, ctx);
        process.env.PI_SUBAGENT_RESULT_PATH = root;
        await succeed();
        now += 1_000;
        await tick!();
        assert.equal(shutdowns, 0, "result-write failure must not expire");
        process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
        await handlers.agent_start?.({}, ctx);
        await succeed();
        now += 99;
        await tick!();
        assert.equal(shutdowns, 0);
        now++;
        await tick!();
        assert.equal(shutdowns, 1, "a later success starts a fresh full idle period");
      } finally {
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic teardown reports finalization failure without claiming removal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-finalize-error-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  try {
    await writeJobRegistry(root, { autoStopOnComplete: true, idleTimeoutMs: 900_000 });
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown() { shutdowns++; }, ui: { notify() {} } };
      await handlers.session_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "saved result" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      assert.equal(shutdowns, 1);
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
        if (to === join(root, "jobs.json")) throw new Error("Registry write failed");
        return rename(from, to);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(handlers.session_shutdown?.({}, ctx), /Registry write failed/);
        assert.equal(JSON.parse(await readFile(join(root, "jobs.json"), "utf8")).jobs[0].autoStopped, undefined);
        assert.equal(await readFile(resultPath, "utf8"), "saved result\n");
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reload restores only a proven successful idle period", async (t) => {
  for (const previous of [
    { state: "waiting", idleSince: 1_000, seenRunning: true },
    { state: "waiting", seenRunning: true },
    { state: "error", idleSince: 1_000, seenRunning: true },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-reload-test-"));
    const resultPath = join(root, "jobs", "child-1", "result.md");
    t.mock.method(Date, "now", () => 2_000);
    try {
      await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 500 });
      await mkdir(join(root, "jobs", "child-1"), { recursive: true });
      await writeFile(join(root, "jobs", "child-1", "heartbeat.json"), JSON.stringify({ jobId: "child-1", cwd: root, stateSince: 1_000, updatedAt: 1_000, ...previous }), "utf8");
      await withChildEnv(root, resultPath, async () => {
        const handlers = loadBootstrapHandlers();
        let shutdowns = 0;
        const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify() {} } };
        await handlers.session_start?.({}, ctx);
        assert.equal(shutdowns, previous.state === "waiting" && previous.idleSince !== undefined ? 1 : 0);
        const heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
        assert.equal(heartbeat.idleSince, previous.state === "waiting" ? previous.idleSince : undefined);
        await handlers.session_shutdown?.({}, ctx);
      });
    } finally {
      t.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a full child reload preserves its deadline despite a stopped observation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-full-reload-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  let now = 1_000;
  let tick: (() => void) | undefined;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return undefined; });
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 500 });
    await withChildEnv(root, resultPath, async () => {
      let handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown() { shutdowns++; }, ui: { notify() {} } };
      try {
        await handlers.session_start?.({}, ctx);
        await handlers.agent_start?.({}, ctx);
        await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
        await handlers.agent_settled?.({}, ctx);
        now = 1_200;
        await handlers.session_shutdown?.({ reason: "reload" }, ctx);
        const observed = await getSubagentStatus(root, "child-1", async () => { throw new Error("Transient tmux query failure"); });
        assert.equal(observed.job.status, "stopped");
        assert.equal(observed.autoStopped, undefined);
        handlers = loadBootstrapHandlers();
        await handlers.session_start?.({ reason: "reload" }, ctx);
        const heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
        assert.equal(heartbeat.idleSince, 1_000);
        assert.equal(shutdowns, 0);
        now = 1_500;
        await tick!();
        await waitFor(() => shutdowns === 1);
      } finally {
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing launch records are reported rather than treated as legacy jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-missing-job-test-"));
  try {
    await withChildEnv(root, join(root, "result.md"), async () => {
      await rm(join(root, "jobs.json"));
      const handlers = loadBootstrapHandlers();
      const ctx = { cwd: root, isIdle: () => true, shutdown() {}, ui: { notify() {} } };
      try {
        await assert.rejects(handlers.session_start?.({}, ctx), /Unknown job/);
      } finally {
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new work accepted during a descendant query cancels the stale close", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-race-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const bin = join(root, "bin");
  const entered = join(root, "tmux-entered");
  const release = join(root, "tmux-release");
  const savedPath = process.env.PATH;
  try {
    await writeJobRegistry(root, { autoStopOnComplete: true, idleTimeoutMs: 900_000 }, [{ id: "descendant", parentId: "child-1", tmuxSession: "descendant-session" }]);
    await mkdir(bin);
    const tmux = join(bin, "tmux");
    await writeFile(tmux, `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nexit 0\n`, "utf8");
    await fs.chmod(tmux, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify() {} } };
      await handlers.session_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
      const settling = handlers.agent_settled?.({}, ctx);
      await waitFor(() => readdirSync(root).includes("tmux-entered"));
      await handlers.agent_start?.({}, ctx);
      await writeFile(release, "", "utf8");
      await settling;
      assert.equal(shutdowns, 0);
      assert.equal(JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8")).state, "running");
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    process.env.PATH = savedPath;
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("descendant query errors retry and open descendants defer closure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-descendants-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const bin = join(root, "bin");
  const mode = join(root, "tmux-mode");
  const savedPath = process.env.PATH;
  let tick: (() => void) | undefined;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return 1 as any; });
  try {
    await writeJobRegistry(root, { autoStopOnComplete: true, idleTimeoutMs: 900_000 }, [{ id: "descendant", parentId: "child-1", tmuxSession: "descendant-session" }]);
    await mkdir(bin);
    const tmux = join(bin, "tmux");
    await writeFile(tmux, `#!/bin/sh\ncase "$(cat '${mode}')" in error) exit 1;; open) echo descendant-session;; esac\n`, "utf8");
    await fs.chmod(tmux, 0o755);
    await writeFile(mode, "error", "utf8");
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const notices: string[] = [];
      const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify(message: string) { notices.push(message); } } };
      await handlers.session_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      assert.equal(shutdowns, 0);
      assert.match(notices.join("\n"), /Could not check subagent descendants/);

      await writeFile(mode, "open", "utf8");
      await tick!();
      assert.equal(shutdowns, 0);

      await writeFile(mode, "clear", "utf8");
      await tick!();
      assert.equal(shutdowns, 1);
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    process.env.PATH = savedPath;
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy policy-less children and failed runs never close automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-legacy-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  try {
    await writeJobRegistry(root, { autoStopOnComplete: true });
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = { cwd: root, isIdle: () => true, shutdown: () => { shutdowns += 1; }, ui: { notify() {} } };
      await handlers.session_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "failed" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      assert.equal(shutdowns, 0);
      assert.equal(JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8")).idleSince, undefined);
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("periodic heartbeat write failures are reported without an unhandled rejection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-heartbeat-error-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  let tick: (() => void) | undefined;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return undefined; });
  const notices: string[] = [];
  try {
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      const ctx = { cwd: root, ui: { notify(message: string) { notices.push(message); } } };
      const path = join(root, "jobs", "child-1", "heartbeat.json");
      try {
        await handlers.session_start?.({}, ctx);
        await rm(path);
        await mkdir(path);
        tick!();
        for (let attempt = 0; attempt < 100 && !notices.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.match(notices.join("\n"), /Subagent heartbeat stopped:/);
      } finally {
        await rm(path, { recursive: true, force: true });
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat publication keeps newer state after an overlapping timer write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-heartbeat-order-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  let tick: (() => void) | undefined;
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return undefined; });
  try {
    await withChildEnv(root, resultPath, async () => {
      const handlers = loadBootstrapHandlers();
      const ctx = { cwd: root, isIdle: () => true };
      const heartbeatPath = join(root, "jobs", "child-1", "heartbeat.json");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      let published!: () => void;
      const oldPublished = new Promise<void>((resolve) => { published = resolve; });
      const rename = fs.rename;
      try {
        await handlers.session_start?.({}, ctx);
        let blockNext = true;
        t.mock.method(fs, "rename", async (from: string, to: string) => {
          if (to === heartbeatPath && blockNext) {
            blockNext = false;
            reached();
            await held;
            await rename(from, to);
            published();
          } else await rename(from, to);
        });
        syncBuiltinESMExports();
        tick!();
        await entered;
        const starting = handlers.agent_start?.({}, ctx);
        await Promise.race([starting, new Promise((resolve) => setTimeout(resolve, 30))]);
        release();
        await Promise.all([starting, oldPublished]);
        assert.equal(JSON.parse(await readFile(heartbeatPath, "utf8")).state, "running");
      } finally {
        release();
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await handlers.session_shutdown?.({}, ctx);
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child bootstrap writes final assistant text to latest and turn result paths when settled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-result-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "LGTM" }] },
    ] } as any, { cwd: root });

    await handlers.agent_settled?.({}, { cwd: root, isIdle: () => true });
    assert.equal(await readFile(resultPath, "utf8"), "LGTM\n");
    assert.equal(await readFile(join(root, "jobs", "child-1", "turns", "001-result.md"), "utf8"), "LGTM\n");
    assert.match(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"), /"state": "waiting"/);

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("new children publish exact session metadata and persisted lifetime usage across runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-lifetime-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const entries: any[] = [];
  const usage = (input: number, output: number, total: number) => ({
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 0, accountingVersion: 1, executionId: "exec-1" });
    await withChildEnv(root, resultPath, async () => {
      process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID = "exec-1";
      const handlers = loadBootstrapHandlers("high");
      const ctx = {
        cwd: root, isIdle: () => true, shutdown() {}, ui: { notify() {} },
        model: { provider: "test-provider", id: "test-model" },
        sessionManager: {
          getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session-1", getEntries: () => entries,
        },
      };
      await handlers.session_start?.({ reason: "startup" }, ctx);
      let job = JSON.parse(await readFile(join(root, "jobs.json"), "utf8")).jobs[0];
      assert.equal(job.sessionFile, join(root, "session.jsonl"));
      assert.equal(job.sessionId, "session-1");
      assert.equal(job.resolvedModel, "test-provider/test-model");
      assert.equal(job.resolvedThinking, "high");

      await handlers.agent_start?.({}, ctx);
      entries.push(
        { id: "assistant-1", type: "message", message: { role: "assistant", usage: usage(10, 2, 0.1) } },
        { id: "tool-1", type: "message", message: { role: "toolResult", usage: usage(3, 0, 0.03) } },
        { id: "compact-1", type: "compaction", usage: usage(5, 1, 0.05) },
      );
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "first" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      let heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.executionId, "exec-1");
      assert.equal(heartbeat.usage.totalTokens, 21);
      assert.equal(heartbeat.lifetimeUsage.totalTokens, 21);

      await handlers.agent_start?.({}, ctx);
      entries.push({ id: "assistant-2", type: "message", message: { role: "assistant", usage: usage(7, 4, 0.07) } });
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "second" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.usage.totalTokens, 11);
      assert.equal(heartbeat.lifetimeUsage.totalTokens, 32);
      const turns = JSON.parse(await readFile(join(root, "jobs", "child-1", "turns", "turns.json"), "utf8"));
      assert.equal(turns.turns[1].executionId, "exec-1");
      assert.equal(turns.turns[1].usage.totalTokens, 11);
      assert.equal(turns.turns[1].lifetimeUsage.totalTokens, 32);
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown and reload preserve an active run baseline across retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-active-reload-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const makeUsage = (tokens: number) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: tokens / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 100 } });
  const entries: any[] = [{ id: "prior", type: "message", message: { role: "assistant", usage: makeUsage(100) } }];
  const ctx = {
    cwd: root, isIdle: () => true, shutdown() {}, ui: { notify() {} },
    model: { provider: "test", id: "model" }, thinkingLevel: "low",
    sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session-1", getEntries: () => entries },
  };
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 0, accountingVersion: 1, executionId: "exec-1" });
    await withChildEnv(root, resultPath, async () => {
      process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID = "exec-1";
      let handlers = loadBootstrapHandlers();
      await handlers.session_start?.({ reason: "startup" }, ctx);
      await handlers.agent_start?.({}, ctx);
      entries.push({ id: "spent-before-reload", type: "message", message: { role: "assistant", usage: makeUsage(20) } });
      await handlers.turn_end?.({}, ctx);
      await handlers.session_shutdown?.({ reason: "reload" }, ctx);

      handlers = loadBootstrapHandlers();
      await handlers.session_start?.({ reason: "reload" }, ctx);
      let heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.runActive, true);
      assert.equal(heartbeat.runUsageBaseline.totalTokens, 100);
      assert.equal(heartbeat.lifetimeUsage.totalTokens, 120, "reload recomputes newer persisted totals");
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_start?.({}, ctx); // automatic retry must not reset the logical-run baseline
      entries.push({ id: "spent-after-reload", type: "message", message: { role: "assistant", usage: makeUsage(10) } });
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "done" }] }, ctx);
      await handlers.agent_settled?.({}, ctx);
      heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.usage.totalTokens, 30);
      assert.equal(heartbeat.lifetimeUsage.totalTokens, 130);
      assert.equal(heartbeat.runActive, false);
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale child execution cannot publish turn or result files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-stale-turn-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  const ctx = {
    cwd: root, isIdle: () => true, shutdown() {}, ui: { notify() {} },
    sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session-1", getEntries: () => [] },
  };
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, accountingVersion: 1, executionId: "exec-1" });
    await withChildEnv(root, resultPath, async () => {
      process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID = "exec-1";
      const handlers = loadBootstrapHandlers();
      await handlers.session_start?.({ reason: "startup" }, ctx);
      await handlers.agent_start?.({}, ctx);
      await handlers.agent_end?.({ messages: [{ role: "assistant", content: "stale result" }] }, ctx);
      const registry = JSON.parse(await readFile(join(root, "jobs.json"), "utf8"));
      registry.jobs[0].executionId = "exec-2";
      await writeFile(join(root, "jobs.json"), JSON.stringify(registry), "utf8");
      await assert.rejects(handlers.agent_settled?.({}, ctx), /Stale subagent execution/);
      await assert.rejects(readFile(resultPath, "utf8"), { code: "ENOENT" });
      await assert.rejects(readFile(join(root, "jobs", "child-1", "turns", "turns.json"), "utf8"), { code: "ENOENT" });
      await handlers.session_shutdown?.({}, ctx).catch(() => {});
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new execution does not restore the previous execution idle deadline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-new-execution-idle-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  t.mock.method(Date, "now", () => 10_000);
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, idleTimeoutMs: 100, accountingVersion: 1, executionId: "exec-new" });
    await mkdir(join(root, "jobs", "child-1"), { recursive: true });
    await writeFile(join(root, "jobs", "child-1", "heartbeat.json"), JSON.stringify({ jobId: "child-1", executionId: "exec-old", state: "waiting", stateSince: 1, updatedAt: 1, idleSince: 1, runActive: false }), "utf8");
    await withChildEnv(root, resultPath, async () => {
      process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID = "exec-new";
      const handlers = loadBootstrapHandlers();
      let shutdowns = 0;
      const ctx = {
        cwd: root, isIdle: () => true, shutdown() { shutdowns++; }, ui: { notify() {} },
        sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "session-1", getEntries: () => [] },
      };
      await handlers.session_start?.({ reason: "startup" }, ctx);
      const heartbeat = JSON.parse(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"));
      assert.equal(heartbeat.idleSince, undefined);
      assert.equal(shutdowns, 0);
      await handlers.session_shutdown?.({}, ctx);
    });
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale child execution cannot publish heartbeat or session metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-stale-execution-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  try {
    await writeJobRegistry(root, { autoStopOnComplete: false, accountingVersion: 1, executionId: "current" });
    await withChildEnv(root, resultPath, async () => {
      process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID = "stale";
      const handlers = loadBootstrapHandlers();
      const ctx = { cwd: root, isIdle: () => true, sessionManager: { getEntries: () => [], getSessionFile: () => "/tmp/stale", getSessionId: () => "stale" } };
      await assert.rejects(handlers.session_start?.({ reason: "startup" }, ctx), /Stale subagent execution/);
      await handlers.session_shutdown?.({}, ctx).catch(() => {});
      const job = JSON.parse(await readFile(join(root, "jobs.json"), "utf8")).jobs[0];
      assert.equal(job.sessionId, undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

    await handlers.agent_settled?.({}, { cwd: root, isIdle: () => true });
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
    await handlers.agent_settled?.({}, { cwd: root, isIdle: () => true });
    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "second result" }] },
    ] } as any, { cwd: root });
    await handlers.agent_settled?.({}, { cwd: root, isIdle: () => true });

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
      await handlers.agent_settled?.({}, { cwd: largeCwd, isIdle: () => true });
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

async function writeJobRegistry(
  root: string,
  policy: { autoStopOnComplete: boolean; idleTimeoutMs?: number; accountingVersion?: 1; executionId?: string },
  extraJobs: Array<{ id: string; parentId: string; tmuxSession: string }> = [],
): Promise<void> {
  await mkdir(root, { recursive: true });
  const base = {
    agentName: "worker",
    taskPreview: "test",
    cwd: root,
    status: "running",
    resultPath: join(root, "jobs", "child-1", "result.md"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writeFile(join(root, "jobs.json"), `${JSON.stringify({ version: 1, jobs: [
    { ...base, id: "child-1", tmuxSession: "pi-subagent-child-1", ...policy },
    ...extraJobs.map((job) => ({ ...base, ...job })),
  ] }, null, 2)}\n`, "utf8");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("timed out waiting for condition");
}

function loadBootstrapHandlers(thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" = "low"): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  childBootstrap({
    getThinkingLevel: () => thinkingLevel,
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
    "PI_TMUX_SUBAGENTS_EXECUTION_ID",
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
  if (!existsSync(join(root, "jobs.json"))) await writeJobRegistry(root, { autoStopOnComplete: true });
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
