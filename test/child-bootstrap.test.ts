import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import childBootstrap from "../src/child-bootstrap.js";

test("child bootstrap writes final assistant text to result path on agent_end", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-result-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "LGTM" }] },
    ] } as any, { cwd: root });

    assert.equal(await readFile(resultPath, "utf8"), "LGTM\n");
    assert.match(await readFile(join(root, "jobs", "child-1", "heartbeat.json"), "utf8"), /"state": "waiting"/);

    await handlers.session_shutdown?.({ type: "session_shutdown" } as any, { cwd: root });
  });
});

test("child bootstrap does not overwrite an explicit result file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-child-existing-result-test-"));
  const resultPath = join(root, "jobs", "child-1", "result.md");
  await mkdir(join(root, "jobs", "child-1"), { recursive: true });
  await writeFile(resultPath, "explicit result\n", "utf8");

  await withChildEnv(root, resultPath, async () => {
    const handlers = loadBootstrapHandlers();

    await handlers.agent_end?.({ type: "agent_end", messages: [
      { role: "assistant", content: [{ type: "text", text: "fallback result" }] },
    ] } as any, { cwd: root });

    assert.equal(await readFile(resultPath, "utf8"), "explicit result\n");

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
  const oldJobId = process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  const oldDir = process.env.PI_TMUX_SUBAGENTS_DIR;
  const oldResult = process.env.PI_SUBAGENT_RESULT_PATH;
  process.env.PI_TMUX_SUBAGENTS_JOB_ID = "child-1";
  process.env.PI_TMUX_SUBAGENTS_DIR = root;
  process.env.PI_SUBAGENT_RESULT_PATH = resultPath;
  try {
    await fn();
  } finally {
    if (oldJobId === undefined) delete process.env.PI_TMUX_SUBAGENTS_JOB_ID;
    else process.env.PI_TMUX_SUBAGENTS_JOB_ID = oldJobId;
    if (oldDir === undefined) delete process.env.PI_TMUX_SUBAGENTS_DIR;
    else process.env.PI_TMUX_SUBAGENTS_DIR = oldDir;
    if (oldResult === undefined) delete process.env.PI_SUBAGENT_RESULT_PATH;
    else process.env.PI_SUBAGENT_RESULT_PATH = oldResult;
  }
}
