import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { detectAgentHubMirror, mirroredTmuxSessionName, mirrorJobToAgentHub, removeMirroredJob, removeMirroredJobs, updateMirroredJobStatus } from "./pi-agent-hub-adapter.js";
import { buildPiArgs, taskPreview, writePromptFiles } from "./prompt.js";
import { TMUX_SESSION_PREFIX } from "./names.js";
import { heartbeatPath, metadataPath, resultPath, stateRoot as defaultStateRoot, turnsPath } from "./paths.js";
import { loadJobs, resolveJob, updateJob, updateJobs, upsertJob } from "./state.js";
import { capturePane, execTmux, killSession, newTmuxSession, sendMessage, sessionExists, type TmuxExecutor } from "./tmux.js";
import type { AgentConfig, SubagentStatusResult, TmuxSubagentHeartbeat, TmuxSubagentJob, TmuxSubagentStatus, TmuxSubagentTurnsRegistry } from "./types.js";

export interface LaunchSubagentInput {
  stateRoot?: string;
  cwd: string;
  agent: AgentConfig;
  task: string;
  background: boolean;
  autoStopOnComplete?: boolean;
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

function childBootstrapPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "child-bootstrap.js");
}

function piCommand(): string {
  return process.env.PI_TMUX_SUBAGENTS_PI_BIN ?? "pi";
}

function effectiveStatus(job: TmuxSubagentJob, heartbeat?: TmuxSubagentHeartbeat): TmuxSubagentStatus {
  if (!heartbeat) return job.status;
  if (heartbeat.state === "shutdown") return "stopped";
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
  const root = input.stateRoot ?? defaultStateRoot();
  const tmux = input.tmux ?? execTmux;
  const now = Date.now();
  const id = randomUUID();
  const mirror = detectAgentHubMirror();
  const tmuxSession = mirror ? mirroredTmuxSessionName(id) : `${TMUX_SESSION_PREFIX}${id.slice(0, 12)}`;
  const job: TmuxSubagentJob = {
    id,
    agentName: input.agent.name,
    taskPreview: taskPreview(input.task),
    cwd: input.cwd,
    tmuxSession,
    status: "starting",
    parentId: mirror?.parentId ?? process.env.PI_TMUX_SUBAGENTS_PARENT_ID,
    model: input.agent.model,
    resultPath: resultPath(root, id),
    createdAt: now,
    updatedAt: now,
    autoStopOnComplete: input.autoStopOnComplete,
  };

  const promptFiles = await writePromptFiles(root, job, input.agent, input.task);
  mkdirSync(dirname(metadataPath(root, id)), { recursive: true });
  await writeFile(metadataPath(root, id), `${JSON.stringify({ job, agent: input.agent }, null, 2)}\n`, "utf8");
  await upsertJob(root, job);
  if (mirror) await mirrorJobToAgentHub(job, mirror);

  const args = buildPiArgs({
    agent: input.agent,
    taskPath: promptFiles.taskPath,
    agentSystemPath: promptFiles.agentSystemPath,
    childBootstrapPath: childBootstrapPath(),
  });
  const env: Record<string, string | undefined> = {
    PI_TMUX_SUBAGENTS_JOB_ID: id,
    PI_TMUX_SUBAGENTS_DIR: root,
    PI_TMUX_SUBAGENTS_PARENT_ID: job.parentId,
    PI_SUBAGENT_AGENT: input.agent.name,
    PI_SUBAGENT_TASK_PREVIEW: job.taskPreview,
    PI_SUBAGENT_RESULT_PATH: job.resultPath,
    PI_SUBAGENT_DEPTH: String(Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1),
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
  const latestResult = latestTurn ? await readOptional(latestTurn.resultPath) : undefined;
  const result = latestResult ?? await readOptional(resultPath(root, job.id));
  const exists = await sessionExists(tmux, job.tmuxSession);
  const preview = exists ? await capturePane(tmux, job.tmuxSession) : undefined;
  const status = exists ? effectiveStatus(job, heartbeat) : "stopped";
  if (status !== job.status) {
    const updated = await updateJob(root, job.id, (existing) => ({ ...existing, status, updatedAt: Date.now() }));
    await updateMirroredJobStatus(updated, status);
  }
  return { job: { ...job, status }, status, heartbeat, result, latestResult, latestTurn, preview };
}

export async function sendSubagentMessage(
  root: string,
  idOrPrefix: string,
  message: string,
  tmux: TmuxExecutor = execTmux,
): Promise<SubagentStatusResult> {
  const status = await getSubagentStatus(root, idOrPrefix, tmux);
  if (status.status === "stopped") throw new Error(`Cannot send to stopped subagent: ${status.job.id}`);
  if (status.status === "starting" || status.status === "running") throw new Error(`Cannot send to busy subagent ${status.job.id}; wait until it is idle.`);
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

  const stoppedAt = Date.now();
  let stoppedTarget: TmuxSubagentJob | undefined;
  const ids = new Set(jobs.map((job) => job.id));
  const updatedRegistry = await updateJobs(root, (latest) => ({
    ...latest,
    jobs: latest.jobs.map((job) => {
      if (!ids.has(job.id)) return job;
      const stopped = { ...job, status: "stopped" as const, updatedAt: stoppedAt };
      if (job.id === target.id) stoppedTarget = stopped;
      return stopped;
    }),
  }));
  stoppedTarget ??= updatedRegistry.jobs.find((job) => job.id === target.id);
  await removeMirroredJobs(jobs);
  return stoppedTarget!;
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

export async function autoStopCompletedSubagent(
  root: string,
  status: SubagentStatusResult,
  tmux: TmuxExecutor = execTmux,
): Promise<SubagentStatusResult> {
  if (status.status !== "waiting") return status;
  let stopped: TmuxSubagentJob;
  try {
    stopped = await cancelSubagent(root, status.job.id, tmux);
  } catch (error) {
    return { ...status, autoStopError: error instanceof Error ? error.message : String(error) };
  }

  try {
    await removeMirroredJob(stopped);
  } catch (error) {
    return { ...status, job: stopped, autoStopped: true, mirrorCleanupError: error instanceof Error ? error.message : String(error) };
  }
  return { ...status, job: stopped, autoStopped: true };
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
