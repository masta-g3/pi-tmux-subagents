import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { heartbeatPath, turnResultPath, turnsPath } from "./paths.js";
import { hasOpenDescendants, finalizeStoppedSubagents } from "./run.js";
import { loadJobs, saveJobs, withStateLock } from "./state.js";
import type { ThinkingLevel, TmuxSubagentAttention, TmuxSubagentHeartbeat, TmuxSubagentJob, TmuxSubagentTurnsRegistry, TmuxSubagentUsage } from "./types.js";

type PiContext = Pick<ExtensionContext, "cwd" | "isIdle" | "shutdown" | "ui"> & Partial<Pick<ExtensionContext, "sessionManager" | "model">>;
type MessageLike = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: Partial<TmuxSubagentUsage> & { cost?: Partial<TmuxSubagentUsage["cost"]> } };

const EXTENSION_KEY = Symbol.for("pi-tmux-subagents.child-bootstrap.loaded");
type GlobalState = typeof globalThis & { [EXTENSION_KEY]?: true };

const HEARTBEAT_INTERVAL_MS = 2000;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function finalAssistantMessage(messages: MessageLike[] | undefined): MessageLike | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages?.[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function finalAssistantText(messages: MessageLike[] | undefined): string | undefined {
  const message = finalAssistantMessage(messages);
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

function extractToolName(event: unknown): string | undefined {
  const value = event as { toolName?: unknown; name?: unknown; tool?: { name?: unknown } };
  return typeof value.toolName === "string" ? value.toolName : typeof value.name === "string" ? value.name : typeof value.tool?.name === "string" ? value.tool.name : undefined;
}

function extractToolCallId(event: unknown): string | undefined {
  const value = event as { toolCallId?: unknown; id?: unknown; toolUseId?: unknown };
  return typeof value.toolCallId === "string" ? value.toolCallId : typeof value.id === "string" ? value.id : typeof value.toolUseId === "string" ? value.toolUseId : undefined;
}

function extractQuestionMessage(event: unknown): string {
  const value = event as { input?: unknown; args?: unknown; parameters?: unknown };
  const input = (typeof value.input === "object" && value.input !== null ? value.input : typeof value.args === "object" && value.args !== null ? value.args : typeof value.parameters === "object" && value.parameters !== null ? value.parameters : {}) as Record<string, unknown>;
  const direct = [input.question, input.prompt, input.message, input.text].find((item) => typeof item === "string" && item.trim());
  if (typeof direct === "string") return direct.replace(/\s+/g, " ").trim().slice(0, 240);
  return "Child session is asking for input.";
}

const zeroUsage = (): TmuxSubagentUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function addUsage(total: TmuxSubagentUsage, usage: MessageLike["usage"]): TmuxSubagentUsage {
  return {
    input: total.input + (usage?.input ?? 0), output: total.output + (usage?.output ?? 0),
    cacheRead: total.cacheRead + (usage?.cacheRead ?? 0), cacheWrite: total.cacheWrite + (usage?.cacheWrite ?? 0),
    totalTokens: total.totalTokens + (usage?.totalTokens ?? 0),
    cost: {
      input: roundCost(total.cost.input + (usage?.cost?.input ?? 0)), output: roundCost(total.cost.output + (usage?.cost?.output ?? 0)),
      cacheRead: roundCost(total.cost.cacheRead + (usage?.cost?.cacheRead ?? 0)), cacheWrite: roundCost(total.cost.cacheWrite + (usage?.cost?.cacheWrite ?? 0)),
      total: roundCost(total.cost.total + (usage?.cost?.total ?? 0)),
    },
  };
}

function subtractUsage(total: TmuxSubagentUsage, baseline: TmuxSubagentUsage): TmuxSubagentUsage {
  return {
    input: total.input - baseline.input, output: total.output - baseline.output,
    cacheRead: total.cacheRead - baseline.cacheRead, cacheWrite: total.cacheWrite - baseline.cacheWrite,
    totalTokens: total.totalTokens - baseline.totalTokens,
    cost: {
      input: roundCost(total.cost.input - baseline.cost.input), output: roundCost(total.cost.output - baseline.cost.output),
      cacheRead: roundCost(total.cost.cacheRead - baseline.cost.cacheRead), cacheWrite: roundCost(total.cost.cacheWrite - baseline.cost.cacheWrite),
      total: roundCost(total.cost.total - baseline.cost.total),
    },
  };
}

function aggregateUsage(messages: MessageLike[] | undefined): TmuxSubagentUsage | undefined {
  const usageMessages = (messages ?? []).filter((message) => message.role === "assistant" && message.usage);
  return usageMessages.length ? usageMessages.reduce((total, message) => addUsage(total, message.usage), zeroUsage()) : undefined;
}

function persistedUsage(ctx: PiContext): TmuxSubagentUsage {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getEntries !== "function") {
    throw new Error("Persisted session entries are required for lifetime usage accounting");
  }
  return ctx.sessionManager.getEntries().reduce((total, entry) => {
    const value = entry as { type?: string; message?: MessageLike; usage?: MessageLike["usage"] };
    if (value.type === "message" && value.message?.usage) return addUsage(total, value.message.usage);
    if ((value.type === "compaction" || value.type === "branch_summary") && value.usage) return addUsage(total, value.usage);
    return total;
  }, zeroUsage());
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

async function writeTurnResult(
  stateRoot: string,
  jobId: string,
  resultPath: string,
  messages: MessageLike[] | undefined,
  usage?: TmuxSubagentUsage,
  lifetimeUsage?: TmuxSubagentUsage,
  executionId?: string,
): Promise<TmuxSubagentUsage | undefined> {
  const result = finalAssistantText(messages);
  if (!result) return usage ?? aggregateUsage(messages);

  const registryPath = turnsPath(stateRoot, jobId);
  const registry = await readTurns(registryPath);
  const index = Math.max(0, ...registry.turns.map((turn) => turn.index)) + 1;
  const now = Date.now();
  const path = turnResultPath(stateRoot, jobId, index);
  const messagePreview = result.replace(/\s+/g, " ").trim().slice(0, 240);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${result}\n`, "utf8");
  await writeFile(resultPath, `${result}\n`, "utf8");
  const turnUsage = usage ?? aggregateUsage(messages);
  await writeJson(registryPath, {
    version: 1,
    turns: [...registry.turns, { index, executionId, status: "waiting", startedAt: now, completedAt: now, resultPath: path, messagePreview, usage: turnUsage, lifetimeUsage }],
  });
  return turnUsage;
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
  const executionId = process.env.PI_TMUX_SUBAGENTS_EXECUTION_ID;

  let currentState: TmuxSubagentHeartbeat["state"] = "starting";
  let stateSince = Date.now();
  let seenRunning = false;
  let latestUsage: TmuxSubagentUsage | undefined;
  let lifetimeUsage: TmuxSubagentUsage | undefined;
  let runUsageBaseline: TmuxSubagentUsage | undefined;
  let runActive = false;
  let attention: TmuxSubagentAttention | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeatQueue: Promise<void> = Promise.resolve();
  let pendingMessages: MessageLike[] | undefined;
  let currentMessage: string | undefined;
  let idleSince: number | undefined;
  let lifetimeJob: TmuxSubagentJob | undefined;
  let closing = false;

  async function withCurrentExecution<T>(fn: (job: TmuxSubagentJob) => Promise<T>): Promise<T> {
    return withStateLock(stateRoot, async () => {
      const registry = await loadJobs(stateRoot);
      const index = registry.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) throw new Error(`Unknown job: ${jobId}`);
      const job = registry.jobs[index]!;
      if (job.executionId !== executionId) throw new Error(`Stale subagent execution: ${executionId ?? "missing"}`);
      return fn(job);
    });
  }

  function settlePersistedUsage(ctx: PiContext): void {
    if (lifetimeJob?.accountingVersion !== 1) return;
    lifetimeUsage = persistedUsage(ctx);
    runUsageBaseline ??= lifetimeUsage;
    latestUsage = subtractUsage(lifetimeUsage, runUsageBaseline);
  }

  async function maybeClose(ctx: PiContext): Promise<void> {
    if (closing || !lifetimeJob || lifetimeJob.autoStopped || lifetimeJob.idleTimeoutMs === undefined || currentState !== "waiting" || idleSince === undefined || attention || !ctx.isIdle()) return;
    const capturedIdleSince = idleSince;
    const eligible = lifetimeJob.autoStopOnComplete !== false
      || (lifetimeJob.idleTimeoutMs > 0 && Date.now() - capturedIdleSince >= lifetimeJob.idleTimeoutMs);
    if (!eligible) return;

    let descendantsOpen: boolean;
    try {
      descendantsOpen = await hasOpenDescendants(stateRoot, jobId);
    } catch (error) {
      ctx.ui.notify(`Could not check subagent descendants: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (descendantsOpen || closing || currentState !== "waiting" || idleSince !== capturedIdleSince || attention || !ctx.isIdle()) return;
    closing = true;
    ctx.shutdown();
  }

  function heartbeat(state: TmuxSubagentHeartbeat["state"], ctx: PiContext, message?: string): Promise<void> {
    if (state !== currentState || message !== undefined) currentMessage = message;
    if (state !== currentState) {
      currentState = state;
      stateSince = Date.now();
    }
    if (state === "running") seenRunning = true;
    const now = Date.now();
    const data: TmuxSubagentHeartbeat = {
      jobId,
      executionId,
      cwd: ctx.cwd,
      state,
      stateSince,
      message: currentMessage,
      updatedAt: now,
      seenRunning,
      usage: latestUsage,
      lifetimeUsage,
      runUsageBaseline,
      runActive,
      attention,
      idleSince,
    };
    const publish = () => withCurrentExecution(async () => {
      await writeJson(heartbeatPath(stateRoot, jobId), data);
      if (process.env.PI_AGENT_HUB_DIR && process.env.PI_AGENT_HUB_SESSION_ID) {
        await writeJson(join(process.env.PI_AGENT_HUB_DIR, "heartbeats", `${process.env.PI_AGENT_HUB_SESSION_ID}.json`), {
          ...data,
          managedSessionId: process.env.PI_AGENT_HUB_SESSION_ID,
          kind: process.env.PI_AGENT_HUB_KIND,
          parentId: process.env.PI_AGENT_HUB_PARENT_ID,
          agentName: process.env.PI_SUBAGENT_DISPLAY_NAME ?? process.env.PI_SUBAGENT_AGENT,
          agentType: process.env.PI_SUBAGENT_AGENT,
          taskPreview: process.env.PI_SUBAGENT_TASK_PREVIEW,
          resultPath: process.env.PI_SUBAGENT_RESULT_PATH,
        });
      }
    });
    heartbeatQueue = heartbeatQueue.then(publish, publish);
    return heartbeatQueue;
  }

  pi.on("session_start", async (event, ctx) => {
    lifetimeJob = await withStateLock(stateRoot, async () => {
      const registry = await loadJobs(stateRoot);
      const index = registry.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) throw new Error(`Unknown job: ${jobId}`);
      const current = registry.jobs[index]!;
      if (current.executionId !== executionId) throw new Error(`Stale subagent execution: ${executionId ?? "missing"}`);
      if (current.accountingVersion !== 1) return current;
      const model = ctx.model as { provider?: string; id?: string } | undefined;
      const updated: TmuxSubagentJob = {
        ...current,
        sessionFile: ctx.sessionManager?.getSessionFile() ?? current.sessionFile,
        sessionId: ctx.sessionManager?.getSessionId() ?? current.sessionId,
        resolvedModel: model?.provider && model.id ? `${model.provider}/${model.id}` : current.resolvedModel,
        resolvedThinking: pi.getThinkingLevel() as ThinkingLevel,
      };
      const jobs = registry.jobs.slice();
      jobs[index] = updated;
      await saveJobs(stateRoot, { ...registry, jobs });
      return updated;
    });
    if (lifetimeJob.accountingVersion === 1 || (lifetimeJob.idleTimeoutMs !== undefined && !lifetimeJob.autoStopped)) {
      try {
        const previous = JSON.parse(await readFile(heartbeatPath(stateRoot, jobId), "utf8")) as TmuxSubagentHeartbeat;
        const sameExecution = previous.executionId === executionId;
        const wasIdle = previous.state === "waiting" || (event.reason === "reload" && previous.state === "shutdown");
        if (sameExecution) {
          latestUsage = previous.usage ?? latestUsage;
          lifetimeUsage = previous.lifetimeUsage ?? lifetimeUsage;
          runUsageBaseline = previous.runUsageBaseline ?? runUsageBaseline;
          attention = previous.attention;
          if (event.reason === "reload" && previous.runActive === true && previous.runUsageBaseline) runActive = true;
          if (lifetimeJob.idleTimeoutMs !== undefined && !lifetimeJob.autoStopped && wasIdle && typeof previous.idleSince === "number" && Number.isFinite(previous.idleSince)) {
            idleSince = previous.idleSince;
            seenRunning = true;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (lifetimeJob.accountingVersion === 1) settlePersistedUsage(ctx as PiContext);
    await heartbeat("waiting", ctx as PiContext);
    timer = setInterval(async () => {
      try {
        await heartbeat(currentState, ctx);
      } catch (error) {
        if (timer) clearInterval(timer);
        ctx.ui.notify(`Subagent heartbeat stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      try {
        await maybeClose(ctx);
      } catch (error) {
        ctx.ui.notify(`Could not shut down idle subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, HEARTBEAT_INTERVAL_MS);
    await maybeClose(ctx as PiContext);
  });
  pi.on("agent_start", async (_event, ctx) => {
    pendingMessages = undefined;
    attention = undefined;
    idleSince = undefined;
    if (!runActive) {
      if (lifetimeJob?.accountingVersion === 1) {
        settlePersistedUsage(ctx as PiContext);
        runUsageBaseline = lifetimeUsage ?? zeroUsage();
        latestUsage = zeroUsage();
      }
      runActive = true;
    }
    await heartbeat("running", ctx as PiContext);
  });
  pi.on("turn_end", async (_event, ctx) => {
    settlePersistedUsage(ctx as PiContext);
  });
  pi.on("session_compact", async (_event, ctx) => {
    settlePersistedUsage(ctx as PiContext);
  });
  pi.on("model_select", async (event) => {
    if (lifetimeJob?.accountingVersion !== 1) return;
    const model = event.model as { provider?: string; id?: string };
    if (!model.provider || !model.id) return;
    await withCurrentExecution(async () => {
      const registry = await loadJobs(stateRoot);
      const index = registry.jobs.findIndex((job) => job.id === jobId);
      const updated = { ...registry.jobs[index]!, resolvedModel: `${model.provider}/${model.id}` };
      const jobs = registry.jobs.slice(); jobs[index] = updated;
      await saveJobs(stateRoot, { ...registry, jobs }); lifetimeJob = updated;
    });
  });
  pi.on("thinking_level_select", async (event) => {
    if (lifetimeJob?.accountingVersion !== 1) return;
    await withCurrentExecution(async () => {
      const registry = await loadJobs(stateRoot);
      const index = registry.jobs.findIndex((job) => job.id === jobId);
      const updated = { ...registry.jobs[index]!, resolvedThinking: event.level as ThinkingLevel };
      const jobs = registry.jobs.slice(); jobs[index] = updated;
      await saveJobs(stateRoot, { ...registry, jobs }); lifetimeJob = updated;
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    if (extractToolName(event) !== "ask_question") return;
    attention = { kind: "question", message: extractQuestionMessage(event), updatedAt: Date.now(), toolCallId: extractToolCallId(event) };
    await heartbeat(currentState, ctx as PiContext);
  });
  pi.on("tool_result", async (event, ctx) => {
    const toolCallId = extractToolCallId(event);
    if (!attention || (attention.toolCallId && toolCallId && attention.toolCallId !== toolCallId)) return;
    attention = undefined;
    await heartbeat(currentState, ctx as PiContext);
  });
  pi.on("agent_end", (event) => {
    pendingMessages = event.messages;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle() || !pendingMessages) return;
    const messages = pendingMessages;
    pendingMessages = undefined;
    settlePersistedUsage(ctx as PiContext);
    const last = finalAssistantMessage(messages);
    if (last?.stopReason === "error" || last?.stopReason === "aborted") {
      runActive = false;
      idleSince = undefined;
      await heartbeat("error", ctx, last.errorMessage || `Child run ${last.stopReason}`);
      return;
    }
    try {
      const resultPath = process.env.PI_SUBAGENT_RESULT_PATH;
      const turnUsage = lifetimeJob?.accountingVersion === 1 ? latestUsage : aggregateUsage(messages);
      const usage = resultPath ? await withCurrentExecution(() => writeTurnResult(
        stateRoot, jobId, resultPath, messages, turnUsage,
        lifetimeJob?.accountingVersion === 1 ? lifetimeUsage : undefined, executionId,
      )) : turnUsage;
      if (usage) latestUsage = usage;
    } catch (error) {
      runActive = false;
      idleSince = undefined;
      await heartbeat("error", ctx, `Could not write result: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    runActive = false;
    if (ctx.isIdle()) {
      idleSince = Date.now();
      await heartbeat("waiting", ctx);
      await maybeClose(ctx);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (timer) clearInterval(timer);
      settlePersistedUsage(ctx as PiContext);
      timer = undefined;
      if (closing) {
        await heartbeatQueue;
        await finalizeStoppedSubagents(stateRoot, [lifetimeJob!], true);
      } else if (lifetimeJob) {
        await heartbeat("shutdown", ctx as PiContext);
      }
    } finally {
      delete globalState[EXTENSION_KEY];
    }
  });
}
