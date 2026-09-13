import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { detectAgentHubMirror, mirroredTmuxSessionName, mirrorJobToAgentHub, removeMirroredJobs, updateMirroredJobStatus } from "./pi-agent-hub-adapter.js";
import { boundedSystemPromptAppend, buildPiArgs, taskPreview, writePromptFiles } from "./prompt.js";
import { SYSTEM_PROMPT_APPEND_ENV, TMUX_SESSION_PREFIX } from "./names.js";
import { heartbeatPath, metadataPath, resultPath, stateRoot as defaultStateRoot, turnsPath } from "./paths.js";
import { loadJobs, resolveJob, updateJob, updateJobs, upsertJob } from "./state.js";
import { capturePane, execTmux, killSession, newTmuxSession, sendMessage, sessionExists, type TmuxExecutor } from "./tmux.js";
import type { AgentConfig, SubagentStatusResult, TmuxSubagentHeartbeat, TmuxSubagentJob, TmuxSubagentStatus, TmuxSubagentTurnsRegistry } from "./types.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

export interface LaunchSubagentInput {
  stateRoot?: string;
  cwd: string;
  agent: AgentConfig;
  task: string;
  background: boolean;
  displayName?: string;
  autoStopOnComplete?: boolean;
  idleTimeoutMs?: number;
  allowNestedSubagents?: boolean;
  nestedAgentAllowlist?: string[];
  maxNestedDepth?: number;
  tmux?: TmuxExecutor;
}

export interface WaitOptions {
  signal?: AbortSignal;
  onUpdate?: (status: SubagentStatusResult) => void;
  intervalMs?: number;
  timeoutMs?: number;
  afterTurnIndex?: number;
  cancelOnAbort?: boolean;
}

export interface WaitAnyOptions extends Omit<WaitOptions, "afterTurnIndex"> {
  jobFilter?: (job: TmuxSubagentJob) => boolean;
}

function childBootstrapPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "child-bootstrap.js");
}

function piCommand(): string {
  return process.env.PI_TMUX_SUBAGENTS_PI_BIN ?? "pi";
}

function effectiveStatus(job: TmuxSubagentJob, heartbeat?: TmuxSubagentHeartbeat): TmuxSubagentStatus {
  if (!heartbeat) return job.status;
  // A live child may be reloading, not exiting. Keep legacy observations unchanged.
  if (heartbeat.state === "shutdown") return job.idleTimeoutMs === undefined ? "stopped" : job.status;
  if (heartbeat.state === "error") return "error";
  if (heartbeat.state === "running") return "running";
  if (heartbeat.state === "waiting") return heartbeat.seenRunning ? "waiting" : "running";
  return "starting";
}

async function readHeartbeat(root: string, id: string): Promise<TmuxSubagentHeartbeat | undefined> {
  try {
    return JSON.parse(await readFile(heartbeatPath(root, id), "utf8")) as TmuxSubagentHeartbeat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTurns(root: string, id: string): Promise<TmuxSubagentTurnsRegistry | undefined> {
  try {
    const registry = JSON.parse(await readFile(turnsPath(root, id), "utf8")) as TmuxSubagentTurnsRegistry;
    if (registry.version !== 1 || !Array.isArray(registry.turns)) throw new Error(`Unsupported turns registry: ${turnsPath(root, id)}`);
    return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function launchSubagent(input: LaunchSubagentInput): Promise<TmuxSubagentJob> {
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new Error("idleTimeoutMs must be a finite nonnegative safe integer");
  }
  const root = input.stateRoot ?? defaultStateRoot();
  const tmux = input.tmux ?? execTmux;
  const now = Date.now();
  const id = randomUUID();
  const mirror = detectAgentHubMirror();
  const tmuxSession = mirror ? mirroredTmuxSessionName(id) : `${TMUX_SESSION_PREFIX}${id.slice(0, 12)}`;
  const job: TmuxSubagentJob = {
    id,
    agentName: input.agent.name,
    displayName: input.displayName,
    taskPreview: taskPreview(input.task),
    cwd: input.cwd,
    tmuxSession,
    status: "starting",
    parentId: mirror?.parentId ?? process.env.PI_TMUX_SUBAGENTS_JOB_ID ?? process.env.PI_TMUX_SUBAGENTS_PARENT_ID,
    model: input.agent.model,
    resultPath: resultPath(root, id),
    createdAt: now,
    updatedAt: now,
    autoStopOnComplete: input.autoStopOnComplete,
    idleTimeoutMs,
    allowNestedSubagents: input.allowNestedSubagents || undefined,
    nestedAgentAllowlist: input.allowNestedSubagents ? input.nestedAgentAllowlist ?? [] : undefined,
    maxNestedDepth: input.allowNestedSubagents ? input.maxNestedDepth ?? 2 : undefined,
  };

  const systemPromptAppend = boundedSystemPromptAppend(process.env[SYSTEM_PROMPT_APPEND_ENV]);
  const promptFiles = await writePromptFiles(root, job, input.agent, input.task, systemPromptAppend);
  mkdirSync(dirname(metadataPath(root, id)), { recursive: true });
  await writeFile(metadataPath(root, id), `${JSON.stringify({ job, agent: input.agent }, null, 2)}\n`, "utf8");
  await upsertJob(root, job);
  if (mirror) await mirrorJobToAgentHub(job, mirror);

  const args = buildPiArgs({
    agent: input.agent,
    taskPath: promptFiles.taskPath,
    agentSystemPath: promptFiles.agentSystemPath,
    childBootstrapPath: childBootstrapPath(),
    allowNestedSubagents: input.allowNestedSubagents,
  });
  const env: Record<string, string | undefined> = {
    PI_TMUX_SUBAGENTS_JOB_ID: id,
    PI_TMUX_SUBAGENTS_DIR: root,
    PI_TMUX_SUBAGENTS_PARENT_ID: job.parentId,
    PI_SUBAGENT_AGENT: input.agent.name,
    PI_SUBAGENT_DISPLAY_NAME: job.displayName,
    PI_SUBAGENT_TASK_PREVIEW: job.taskPreview,
    PI_SUBAGENT_RESULT_PATH: job.resultPath,
    PI_SUBAGENT_DEPTH: String(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1),
    PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST: input.allowNestedSubagents ? (input.nestedAgentAllowlist ?? []).join(",") : "",
    PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH: input.allowNestedSubagents ? String(input.maxNestedDepth ?? 2) : "",
    [SYSTEM_PROMPT_APPEND_ENV]: systemPromptAppend,
    PI_AGENT_HUB_DIR: "",
    PI_AGENT_HUB_SESSION_ID: "",
    PI_AGENT_HUB_PARENT_ID: "",
    PI_AGENT_HUB_KIND: "",
  };
  if (mirror) {
    env.PI_AGENT_HUB_DIR = mirror.hubDir;
    env.PI_AGENT_HUB_SESSION_ID = id;
    env.PI_AGENT_HUB_PARENT_ID = mirror.parentId;
    env.PI_AGENT_HUB_KIND = "subagent";
  }

  try {
    await newTmuxSession({ tmux, sessionName: tmuxSession, cwd: input.cwd, env, command: piCommand(), args });
    return job;
  } catch (error) {
    const failed = await updateJob(root, id, (existing) => ({
      ...existing,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    }));
    await updateMirroredJobStatus(failed, "error", failed.error);
    throw new Error(`Failed to launch tmux subagent ${failed.id}: ${failed.error}`);
  }
}

export async function getSubagentStatus(
  root: string,
  idOrPrefix: string,
  tmux: TmuxExecutor = execTmux,
): Promise<SubagentStatusResult> {
  const job = await resolveJob(root, idOrPrefix);
  const heartbeat = await readHeartbeat(root, job.id);
  const turns = await readTurns(root, job.id);
  const latestTurn = turns?.turns.at(-1);
  const usage = heartbeat?.usage ?? latestTurn?.usage;
  if (usage !== undefined && ![usage?.input, usage?.output, usage?.cost?.total].every(Number.isFinite)) {
    throw new Error(`Invalid usage for subagent ${job.id}`);
  }
  const latestResult = latestTurn ? await readOptional(latestTurn.resultPath) : undefined;
  const result = latestResult ?? await readOptional(resultPath(root, job.id));
  const exists = job.autoStopped ? false : await sessionExists(tmux, job.tmuxSession);
  const preview = exists ? await capturePane(tmux, job.tmuxSession) : undefined;
  const observedStatus = job.autoStopped ? "stopped" : exists ? effectiveStatus(job, heartbeat) : "stopped";
  const observedError = observedStatus === "error" ? heartbeat?.message ?? job.error : job.error;
  let current: TmuxSubagentJob = { ...job, status: observedStatus, error: observedError };
  if (observedStatus !== job.status || observedError !== job.error) {
    current = await updateJob(root, job.id, (existing) => {
      if (existing.autoStopped) return existing;
      return { ...existing, status: observedStatus, error: observedError, updatedAt: Date.now() };
    });
    if (!current.autoStopped) {
      await updateMirroredJobStatus(current, current.status, current.status === "error" ? current.error : undefined);
    }
  } else {
    current = await resolveJob(root, job.id);
  }
  const status = current.autoStopped ? "stopped" : current.status;
  return { job: current, status, heartbeat, result, latestResult, latestTurn, preview, usage, autoStopped: current.autoStopped || undefined };
}

export async function sendSubagentMessage(
  root: string,
  idOrPrefix: string,
  message: string,
  tmux: TmuxExecutor = execTmux,
): Promise<SubagentStatusResult> {
  return sendSubagentMessageInternal(root, idOrPrefix, message, false, tmux);
}

export async function sendSubagentAttentionReply(
  root: string,
  idOrPrefix: string,
  message: string,
  tmux: TmuxExecutor = execTmux,
): Promise<SubagentStatusResult> {
  return sendSubagentMessageInternal(root, idOrPrefix, message, true, tmux);
}

async function sendSubagentMessageInternal(
  root: string,
  idOrPrefix: string,
  message: string,
  allowAttentionReply: boolean,
  tmux: TmuxExecutor,
): Promise<SubagentStatusResult> {
  const status = await getSubagentStatus(root, idOrPrefix, tmux);
  if (status.status === "stopped") throw new Error(`Cannot send to stopped subagent: ${status.job.id}`);
  const busy = status.status === "starting" || status.status === "running";
  if (busy && (!allowAttentionReply || !status.heartbeat?.attention)) throw new Error(`Cannot send to busy subagent ${status.job.id}; wait until it is idle.`);
  await sendMessage(tmux, status.job.tmuxSession, message);
  return getSubagentStatus(root, status.job.id, tmux);
}

export async function cancelSubagent(
  root: string,
  idOrPrefix: string,
  tmux: TmuxExecutor = execTmux,
): Promise<TmuxSubagentJob> {
  const target = await resolveJob(root, idOrPrefix);
  const registry = await loadJobs(root);
  const jobs = jobSubtree(registry.jobs, target.id);
  for (const job of jobs.slice().reverse()) {
    if (await sessionExists(tmux, job.tmuxSession)) await killSession(tmux, job.tmuxSession);
  }

  const stopped = await finalizeStoppedSubagents(root, jobs);
  return stopped.find((job) => job.id === target.id)!;
}

export async function finalizeStoppedSubagents(
  root: string,
  jobs: TmuxSubagentJob[],
  autoStopped = false,
): Promise<TmuxSubagentJob[]> {
  if (jobs.length === 0) return [];
  const ids = new Set(jobs.map((job) => job.id));
  const stoppedAt = Date.now();
  const updatedRegistry = await updateJobs(root, (latest) => ({
    ...latest,
    jobs: latest.jobs.map((job) => {
      if (!ids.has(job.id)) return job;
      const nextAutoStopped = job.autoStopped || autoStopped || undefined;
      if (job.status === "stopped" && job.autoStopped === nextAutoStopped) return job;
      return { ...job, status: "stopped" as const, autoStopped: nextAutoStopped, updatedAt: stoppedAt };
    }),
  }));
  const stopped = jobs
    .map((job) => updatedRegistry.jobs.find((candidate) => candidate.id === job.id))
    .filter((job): job is TmuxSubagentJob => job !== undefined);
  await removeMirroredJobs(stopped);
  return stopped;
}

function jobSubtree(jobs: TmuxSubagentJob[], rootId: string): TmuxSubagentJob[] {
  const byParent = new Map<string, TmuxSubagentJob[]>();
  for (const job of jobs) {
    if (!job.parentId) continue;
    const children = byParent.get(job.parentId) ?? [];
    children.push(job);
    byParent.set(job.parentId, children);
  }
  const root = jobs.find((job) => job.id === rootId);
  if (!root) return [];
  const subtree: TmuxSubagentJob[] = [root];
  for (let index = 0; index < subtree.length; index += 1) {
    subtree.push(...(byParent.get(subtree[index]!.id) ?? []));
  }
  return subtree;
}

export async function hasOpenDescendants(
  root: string,
  id: string,
  tmux: TmuxExecutor = execTmux,
): Promise<boolean> {
  const descendants = jobSubtree((await loadJobs(root)).jobs, id).slice(1);
  if (descendants.length === 0) return false;
  const { stdout } = await tmux(["list-sessions", "-F", "#{session_name}"]);
  const openNames = new Set(stdout.split(/\r?\n/).filter(Boolean));
  return descendants.some((job) => openNames.has(job.tmuxSession));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSubagent(
  root: string,
  id: string,
  tmux: TmuxExecutor = execTmux,
  options: WaitOptions = {},
): Promise<SubagentStatusResult> {
  const intervalMs = options.intervalMs ?? 1000;
  const started = Date.now();
  while (true) {
    if (options.signal?.aborted) {
      if (options.cancelOnAbort ?? true) await cancelSubagent(root, id, tmux);
      throw new Error("Subagent wait aborted");
    }
    if (options.timeoutMs !== undefined && Date.now() - started > options.timeoutMs) throw new Error(`Timed out waiting for subagent ${id}`);
    const status = await getSubagentStatus(root, id, tmux);
    options.onUpdate?.(status);
    if (["stopped", "error"].includes(status.status)) return status;
    const turnComplete = options.afterTurnIndex === undefined || (status.latestTurn?.index ?? 0) > options.afterTurnIndex;
    if (status.status === "waiting" && turnComplete) return status;
    await sleep(intervalMs);
  }
}

export async function waitForAnySubagent(
  root: string,
  tmux: TmuxExecutor = execTmux,
  options: WaitAnyOptions = {},
): Promise<SubagentStatusResult> {
  const candidates = (await loadJobs(root)).jobs
    .filter((job) => options.jobFilter?.(job) ?? true)
    .filter((job) => job.status === "starting" || job.status === "running");
  if (!candidates.length) throw new Error("No running tmux subagent jobs to wait for.");

  const intervalMs = options.intervalMs ?? 1000;
  const started = Date.now();
  while (true) {
    if (options.signal?.aborted) {
      if (options.cancelOnAbort ?? true) await Promise.all(candidates.map((job) => cancelSubagent(root, job.id, tmux)));
      throw new Error("Subagent wait aborted");
    }
    if (options.timeoutMs !== undefined && Date.now() - started > options.timeoutMs) throw new Error("Timed out waiting for a tmux subagent to complete");

    for (const job of candidates) {
      const status = await getSubagentStatus(root, job.id, tmux);
      options.onUpdate?.(status);
      if (status.status !== "starting" && status.status !== "running") return status;
    }
    await sleep(intervalMs);
  }
}
