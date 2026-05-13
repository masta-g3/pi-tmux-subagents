import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { detectPiSessionsMirror, mirroredTmuxSessionName, mirrorJobToPiSessions, removeMirroredJob, updateMirroredJobStatus } from "./pi-sessions-adapter.js";
import { buildPiArgs, taskPreview, writePromptFiles } from "./prompt.js";
import { TMUX_SESSION_PREFIX } from "./names.js";
import { heartbeatPath, metadataPath, resultPath, stateRoot as defaultStateRoot } from "./paths.js";
import { resolveJob, updateJob, upsertJob } from "./state.js";
import { capturePane, execTmux, killSession, newTmuxSession, sessionExists, type TmuxExecutor } from "./tmux.js";
import type { AgentConfig, SubagentStatusResult, TmuxSubagentHeartbeat, TmuxSubagentJob, TmuxSubagentStatus } from "./types.js";

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

export async function launchSubagent(input: LaunchSubagentInput): Promise<TmuxSubagentJob> {
  const root = input.stateRoot ?? defaultStateRoot();
  const tmux = input.tmux ?? execTmux;
  const now = Date.now();
  const id = randomUUID();
  const mirror = detectPiSessionsMirror();
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
    autoStopOnComplete: input.autoStopOnComplete || undefined,
  };

  const promptFiles = await writePromptFiles(root, job, input.agent, input.task);
  mkdirSync(dirname(metadataPath(root, id)), { recursive: true });
  await writeFile(metadataPath(root, id), `${JSON.stringify({ job, agent: input.agent }, null, 2)}\n`, "utf8");
  await upsertJob(root, job);
  if (mirror) await mirrorJobToPiSessions(job, mirror);

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
  };
  if (process.env.PI_SESSIONS_DIR) env.PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR;
  if (mirror) {
    env.PI_SESSIONS_SESSION_ID = id;
    env.PI_SESSIONS_PARENT_ID = mirror.parentId;
    env.PI_SESSIONS_KIND = "subagent";
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
  const result = await readOptional(resultPath(root, job.id));
  const exists = await sessionExists(tmux, job.tmuxSession);
  const preview = exists ? await capturePane(tmux, job.tmuxSession) : undefined;
  const status = exists ? effectiveStatus(job, heartbeat) : "stopped";
  if (status !== job.status) {
    const updated = await updateJob(root, job.id, (existing) => ({ ...existing, status, updatedAt: Date.now() }));
    await updateMirroredJobStatus(updated, status);
  }
  return { job: { ...job, status }, status, heartbeat, result, preview };
}

export async function cancelSubagent(
  root: string,
  idOrPrefix: string,
  tmux: TmuxExecutor = execTmux,
): Promise<TmuxSubagentJob> {
  const job = await resolveJob(root, idOrPrefix);
  await killSession(tmux, job.tmuxSession);
  const updated = await updateJob(root, job.id, (existing) => ({ ...existing, status: "stopped", updatedAt: Date.now() }));
  await updateMirroredJobStatus(updated, "stopped");
  return updated;
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
  while (true) {
    if (options.signal?.aborted) {
      await cancelSubagent(root, id, tmux);
      throw new Error("Subagent launch aborted");
    }
    const status = await getSubagentStatus(root, id, tmux);
    options.onUpdate?.(status);
    if (["waiting", "stopped", "error"].includes(status.status)) return status;
    await sleep(intervalMs);
  }
}
