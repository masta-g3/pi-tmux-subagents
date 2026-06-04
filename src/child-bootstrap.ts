import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { heartbeatPath, turnResultPath, turnsPath } from "./paths.js";
import type { TmuxSubagentHeartbeat, TmuxSubagentTurnsRegistry, TmuxSubagentUsage } from "./types.js";

type PiContext = { cwd: string };
type MessageLike = { role?: string; content?: unknown; usage?: Partial<TmuxSubagentUsage> & { cost?: Partial<TmuxSubagentUsage["cost"]> } };

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

function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function aggregateUsage(messages: MessageLike[] | undefined): TmuxSubagentUsage | undefined {
  const usageMessages = (messages ?? []).filter((message) => message.role === "assistant" && message.usage);
  if (!usageMessages.length) return undefined;
  return usageMessages.reduce<TmuxSubagentUsage>((total, message) => ({
    input: total.input + (message.usage?.input ?? 0),
    output: total.output + (message.usage?.output ?? 0),
    cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (message.usage?.cacheWrite ?? 0),
    totalTokens: total.totalTokens + (message.usage?.totalTokens ?? 0),
    cost: {
      input: roundCost(total.cost.input + (message.usage?.cost?.input ?? 0)),
      output: roundCost(total.cost.output + (message.usage?.cost?.output ?? 0)),
      cacheRead: roundCost(total.cost.cacheRead + (message.usage?.cost?.cacheRead ?? 0)),
      cacheWrite: roundCost(total.cost.cacheWrite + (message.usage?.cost?.cacheWrite ?? 0)),
      total: roundCost(total.cost.total + (message.usage?.cost?.total ?? 0)),
    },
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
}

async function readTurns(path: string): Promise<TmuxSubagentTurnsRegistry> {
  try {
    const registry = JSON.parse(await readFile(path, "utf8")) as TmuxSubagentTurnsRegistry;
    if (registry.version === 1 && Array.isArray(registry.turns)) return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, turns: [] };
}

async function writeTurnResult(stateRoot: string, jobId: string, resultPath: string, messages: MessageLike[] | undefined): Promise<TmuxSubagentUsage | undefined> {
  const result = finalAssistantText(messages);
  if (!result) return aggregateUsage(messages);

  const registryPath = turnsPath(stateRoot, jobId);
  const registry = await readTurns(registryPath);
  const index = Math.max(0, ...registry.turns.map((turn) => turn.index)) + 1;
  const now = Date.now();
  const path = turnResultPath(stateRoot, jobId, index);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${result}\n`, "utf8");
  await writeFile(resultPath, `${result}\n`, "utf8");
  const usage = aggregateUsage(messages);
  await writeJson(registryPath, {
    version: 1,
    turns: [...registry.turns, { index, status: "waiting", startedAt: now, completedAt: now, resultPath: path, usage }],
  });
  return usage;
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
  let latestUsage: TmuxSubagentUsage | undefined;
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
      usage: latestUsage,
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
        agentName: process.env.PI_SUBAGENT_DISPLAY_NAME ?? process.env.PI_SUBAGENT_AGENT,
        agentType: process.env.PI_SUBAGENT_AGENT,
        taskPreview: process.env.PI_SUBAGENT_TASK_PREVIEW,
        resultPath: process.env.PI_SUBAGENT_RESULT_PATH,
        usage: latestUsage,
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
      const resultPath = process.env.PI_SUBAGENT_RESULT_PATH;
      const usage = resultPath ? await writeTurnResult(stateRoot, jobId, resultPath, (event as { messages?: MessageLike[] }).messages) : aggregateUsage((event as { messages?: MessageLike[] }).messages);
      if (usage) latestUsage = usage;
    } catch (error) {
      message = `Could not write result: ${error instanceof Error ? error.message : String(error)}`;
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
