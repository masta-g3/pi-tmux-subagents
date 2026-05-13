import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { heartbeatPath } from "./paths.js";
import type { TmuxSubagentHeartbeat } from "./types.js";

type PiContext = { cwd: string };
type MessageLike = { role?: string; content?: unknown };

const EXTENSION_KEY = Symbol.for("pi-tmux-subagents.child-bootstrap.loaded");
type GlobalState = typeof globalThis & { [EXTENSION_KEY]?: true };

const HEARTBEAT_INTERVAL_MS = 2000;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function finalAssistantText(messages: MessageLike[] | undefined): string | undefined {
  let message: MessageLike | undefined;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages?.[i]?.role === "assistant") {
      message = messages[i];
      break;
    }
  }
  if (!message) return undefined;
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function isTextPart(part: unknown): part is { type: string; text: string } {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
}

async function writeResultIfMissing(messages: MessageLike[] | undefined): Promise<void> {
  const resultPath = process.env.PI_SUBAGENT_RESULT_PATH;
  const result = finalAssistantText(messages);
  if (!resultPath || !result) return;
  await mkdir(dirname(resultPath), { recursive: true });
  try {
    await writeFile(resultPath, `${result}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
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

    if (process.env.PI_AGENT_HUB_DIR && process.env.PI_AGENT_HUB_SESSION_ID) {
      await writeJson(join(process.env.PI_AGENT_HUB_DIR, "heartbeats", `${process.env.PI_AGENT_HUB_SESSION_ID}.json`), {
        managedSessionId: process.env.PI_AGENT_HUB_SESSION_ID,
        cwd: ctx.cwd,
        state,
        stateSince,
        message,
        updatedAt: now,
        kind: process.env.PI_AGENT_HUB_KIND,
        parentId: process.env.PI_AGENT_HUB_PARENT_ID,
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
  pi.on("agent_end", async (event, ctx) => {
    let message: string | undefined;
    try {
      await writeResultIfMissing((event as { messages?: MessageLike[] }).messages);
    } catch (error) {
      message = `Could not write result.md: ${error instanceof Error ? error.message : String(error)}`;
    }
    await heartbeat("waiting", ctx as PiContext, message);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (timer) clearInterval(timer);
      await heartbeat("shutdown", ctx as PiContext);
    } finally {
      delete globalState[EXTENSION_KEY];
    }
  });
}
