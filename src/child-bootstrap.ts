import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { heartbeatPath } from "./paths.js";
import type { TmuxSubagentHeartbeat } from "./types.js";

type PiContext = { cwd: string };

const EXTENSION_KEY = Symbol.for("pi-tmux-subagents.child-bootstrap.loaded");
type GlobalState = typeof globalThis & { [EXTENSION_KEY]?: true };

const HEARTBEAT_INTERVAL_MS = 2000;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export default function tmuxSubagentChildBootstrap(pi: ExtensionAPI) {
  const globalState = globalThis as GlobalState;
  if (globalState[EXTENSION_KEY]) return;
  globalState[EXTENSION_KEY] = true;

  const configuredJobId = process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  const configuredStateRoot = process.env.PI_TMUX_SUBAGENTS_DIR;
  if (!configuredJobId || !configuredStateRoot) return;
  const jobId = configuredJobId;
  const stateRoot = configuredStateRoot;

  let currentState: TmuxSubagentHeartbeat["state"] = "starting";
  let stateSince = Date.now();
  let seenRunning = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function heartbeat(state: TmuxSubagentHeartbeat["state"], ctx: PiContext, message?: string) {
    if (state !== currentState) {
      currentState = state;
      stateSince = Date.now();
    }
    if (state === "running") seenRunning = true;
    const now = Date.now();
    const data: TmuxSubagentHeartbeat = {
      jobId,
      cwd: ctx.cwd,
      state,
      stateSince,
      message,
      updatedAt: now,
      seenRunning,
    };
    await writeJson(heartbeatPath(stateRoot, jobId), data);

    if (process.env.PI_SESSIONS_DIR && process.env.PI_SESSIONS_SESSION_ID) {
      await writeJson(join(process.env.PI_SESSIONS_DIR, "heartbeats", `${process.env.PI_SESSIONS_SESSION_ID}.json`), {
        managedSessionId: process.env.PI_SESSIONS_SESSION_ID,
        cwd: ctx.cwd,
        state,
        stateSince,
        message,
        updatedAt: now,
        kind: process.env.PI_SESSIONS_KIND,
        parentId: process.env.PI_SESSIONS_PARENT_ID,
        agentName: process.env.PI_SUBAGENT_AGENT,
        taskPreview: process.env.PI_SUBAGENT_TASK_PREVIEW,
        resultPath: process.env.PI_SUBAGENT_RESULT_PATH,
      });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await heartbeat("waiting", ctx as PiContext);
    timer = setInterval(() => void heartbeat(currentState, ctx as PiContext), HEARTBEAT_INTERVAL_MS);
  });
  pi.on("agent_start", async (_event, ctx) => heartbeat("running", ctx as PiContext));
  pi.on("agent_end", async (_event, ctx) => heartbeat("waiting", ctx as PiContext));
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (timer) clearInterval(timer);
      await heartbeat("shutdown", ctx as PiContext);
    } finally {
      delete globalState[EXTENSION_KEY];
    }
  });
}
