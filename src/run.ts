import { randomUUID } from "node:crypto";
import { readFile, writeFile, access, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { detectAgentHubMirror, mirroredTmuxSessionName, mirrorJobToAgentHub, removeMirroredJobs, updateMirroredJobStatus } from "./pi-agent-hub-adapter.js";
import { boundedSystemPromptAppend, buildPiArgs, taskPreview, writePromptFiles } from "./prompt.js";
import { SYSTEM_PROMPT_APPEND_ENV, TMUX_SESSION_PREFIX } from "./names.js";
import { agentSystemPath, heartbeatPath, metadataPath, resultPath, stateRoot as defaultStateRoot, turnsPath } from "./paths.js";
import { loadJobs, resolveJob, saveJobs, updateJob, upsertJob, withStateLock } from "./state.js";
import { capturePane, execTmux, killSession, newTmuxSession, sendMessage, sessionExists, type TmuxExecutor } from "./tmux.js";
import type { AgentConfig, SubagentStatusResult, TmuxSubagentHeartbeat, TmuxSubagentJob, TmuxSubagentsRegistry, TmuxSubagentStatus, TmuxSubagentTurnsRegistry } from "./types.js";

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
  executionId?: string;
  cancelOnAbort?: boolean;
}

export interface WaitAnyOptions extends Omit<WaitOptions, "afterTurnIndex" | "executionId"> {
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
    accountingVersion: 1,
    executionId: randomUUID(),
    depth: Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1,
    hubDir: mirror?.hubDir,
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
  await writeFile(metadataPath(root, id), `${JSON.stringify({ job, agent: input.agent, systemPromptAppend }, null, 2)}\n`, "utf8");
  await upsertJob(root, job);
  if (mirror) await mirrorJobToAgentHub(job, mirror);

  const args = buildPiArgs({
    agent: input.agent,
    taskPath: promptFiles.taskPath,
    agentSystemPath: promptFiles.agentSystemPath,
    childBootstrapPath: childBootstrapPath(),
    allowNestedSubagents: input.allowNestedSubagents,
  });
  const env = childEnvironment(root, job, systemPromptAppend);

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

function childEnvironment(root: string, job: TmuxSubagentJob, systemPromptAppend?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PI_TMUX_SUBAGENTS_JOB_ID: job.id,
    PI_TMUX_SUBAGENTS_EXECUTION_ID: job.executionId,
    PI_TMUX_SUBAGENTS_DIR: root,
    PI_TMUX_SUBAGENTS_PARENT_ID: job.parentId,
    PI_SUBAGENT_AGENT: job.agentName,
    PI_SUBAGENT_DISPLAY_NAME: job.displayName,
    PI_SUBAGENT_TASK_PREVIEW: job.taskPreview,
    PI_SUBAGENT_RESULT_PATH: job.resultPath,
    PI_SUBAGENT_DEPTH: String(job.depth),
    PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST: job.allowNestedSubagents ? (job.nestedAgentAllowlist ?? []).join(",") : "",
    PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH: job.allowNestedSubagents ? String(job.maxNestedDepth ?? 2) : "",
    [SYSTEM_PROMPT_APPEND_ENV]: systemPromptAppend,
    PI_AGENT_HUB_DIR: "",
    PI_AGENT_HUB_SESSION_ID: "",
    PI_AGENT_HUB_PARENT_ID: "",
    PI_AGENT_HUB_KIND: "",
  };
  if (job.hubDir) {
    env.PI_AGENT_HUB_DIR = job.hubDir;
    env.PI_AGENT_HUB_SESSION_ID = job.id;
    env.PI_AGENT_HUB_PARENT_ID = job.parentId;
    env.PI_AGENT_HUB_KIND = "subagent";
  }
  return env;
}

async function sessionIsLive(tmux: TmuxExecutor, name: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", name]);
    return true;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/can't find session|no server running|error connecting to .*No such file/i.test(stderr)) return false;
    throw error;
  }
}

async function verifySavedSession(job: TmuxSubagentJob): Promise<void> {
  if (!job.sessionFile || !job.sessionId || !job.resolvedModel || !job.resolvedThinking) {
    throw new Error("This child has no saved session metadata; it cannot resume. Launch a new child explicitly.");
  }
  await access(job.cwd);
  const file = await open(job.sessionFile, "r");
  try {
    const lines = file.readLines();
    const first = await lines[Symbol.asyncIterator]().next();
    const header = JSON.parse(first.value ?? "null");
    if (header?.type !== "session" || header.id !== job.sessionId) throw new Error("Saved session identity does not match this child.");
    lines.close();
  } finally { await file.close(); }
}

export async function resumeSubagent(root: string, id: string, message: string, tmux: TmuxExecutor = execTmux): Promise<TmuxSubagentJob> {
  if (!message.trim()) throw new Error("Resume requires a nonblank message.");
  const initial = await resolveJob(root, id);
  await verifySavedSession(initial);
  const metadata = JSON.parse(await readFile(metadataPath(root, initial.id), "utf8")) as { agent: AgentConfig; systemPromptAppend?: string };
  if (!metadata.agent) throw new Error("Saved agent configuration is missing.");
  await access(agentSystemPath(root, initial.id));
  const mirror = detectAgentHubMirror();
  const executionId = randomUUID();
  // The claim prevents another caller from preparing or dispatching this resume.
  const claimed = await withStateLock(root, async () => {
    const registry = await loadJobs(root);
    const current = registry.jobs.find(j => j.id === initial.id)!;
    if (current.executionId !== initial.executionId || current.launchPending) throw new Error("Child has another pending execution; inspect it or explicitly stop it first.");
    if (await sessionIsLive(tmux, current.tmuxSession)) throw new Error("Child is still live; use send instead of resume.");
    const job: TmuxSubagentJob = {
      ...current, executionId, launchPending: true, status: "starting", autoStopped: undefined, error: undefined,
      parentId: mirror?.parentId ?? process.env.PI_TMUX_SUBAGENTS_JOB_ID ?? process.env.PI_TMUX_SUBAGENTS_PARENT_ID,
      hubDir: mirror?.hubDir, depth: Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) + 1, updatedAt: Date.now(),
    };
    await saveJobs(root, { ...registry, jobs: registry.jobs.map(j => j.id === job.id ? job : j) });
    return job;
  });
  try {
    return await withStateLock(root, async () => {
      const registry = await loadJobs(root);
      const current = registry.jobs.find(j => j.id === claimed.id)!;
      if (current.executionId !== executionId || !current.launchPending) throw new Error("Resume was stopped before launch.");
      const taskFile = join(dirname(metadataPath(root, current.id)), "resume.md");
      await writeFile(taskFile, `${message}\n`, "utf8");
      const args = buildPiArgs({
        agent: { ...metadata.agent, model: current.resolvedModel, thinking: current.resolvedThinking },
        taskPath: taskFile, agentSystemPath: agentSystemPath(root, current.id), childBootstrapPath: childBootstrapPath(),
        allowNestedSubagents: current.allowNestedSubagents,
      });
      args.unshift("--session", current.sessionFile!);
      if (initial.hubDir) await removeMirroredJobs([initial], initial.hubDir);
      if (mirror) await mirrorJobToAgentHub(current, mirror);
      await newTmuxSession({ tmux, sessionName: current.tmuxSession, cwd: current.cwd, command: piCommand(), args,
        env: childEnvironment(root, current, metadata.systemPromptAppend) });
      const started = { ...current, launchPending: undefined };
      await saveJobs(root, { ...registry, jobs: registry.jobs.map(j => j.id === started.id ? started : j) });
      return started;
    });
  } catch (error) {
    await withStateLock(root, async () => {
      const registry = await loadJobs(root);
      const current = registry.jobs.find(job => job.id === claimed.id)!;
      if (current.executionId !== executionId) return;
      const failed: TmuxSubagentJob = { ...current, launchPending: undefined, status: "error",
        error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() };
      await saveJobs(root, { ...registry, jobs: registry.jobs.map(job => job.id === failed.id ? failed : job) });
      await updateMirroredJobStatus(failed, "error", failed.error);
    });
    throw error;
  }
}

export interface StatusOptions {
  registry?: TmuxSubagentsRegistry;
  readResults?: boolean;
  capturePreview?: boolean;
}

function selectJob(registry: TmuxSubagentsRegistry, id: string): TmuxSubagentJob {
  const exact = registry.jobs.find(job => job.id === id);
  if (exact) return exact;
  const matches = registry.jobs.filter(job => job.id === id || job.id.startsWith(id));
  if (!matches.length) throw new Error(`Unknown job: ${id}`);
  if (matches.length !== 1) throw new Error(`Ambiguous job prefix: ${id}`);
  return matches[0]!;
}

async function availableResult(root: string, id: string): Promise<string | undefined> {
  const path = resultPath(root, id);
  try { await access(path); return path; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function observeJob(root: string, job: TmuxSubagentJob, tmux: TmuxExecutor, options: StatusOptions): Promise<SubagentStatusResult> {
  const savedHeartbeat = await readHeartbeat(root, job.id);
  const heartbeat = job.executionId && savedHeartbeat?.executionId !== job.executionId ? undefined : savedHeartbeat;
  const turns = await readTurns(root, job.id);
  const latestTurn = turns?.turns.at(-1);
  const lifetime = job.accountingVersion === 1 ? heartbeat?.lifetimeUsage ?? latestTurn?.lifetimeUsage : undefined;
  const usage = lifetime ?? heartbeat?.usage ?? latestTurn?.usage;
  if (usage !== undefined && ![usage.input, usage.output, usage.cost?.total].every(Number.isFinite)) throw new Error(`Invalid usage for subagent ${job.id}`);
  const path = latestTurn?.resultPath ?? await availableResult(root, job.id);
  const result = options.readResults && path ? await readOptional(path) : undefined;
  const exists = job.autoStopped ? false : await sessionExists(tmux, job.tmuxSession);
  const preview = options.capturePreview && exists ? await capturePane(tmux, job.tmuxSession) : undefined;
  const status = job.autoStopped ? "stopped" : job.launchPending ? "starting" : exists ? effectiveStatus(job, heartbeat) : "stopped";
  const error = status === "error" ? heartbeat?.message ?? job.error : job.error;
  return {job: {...job,status,error},status,heartbeat,result,latestResult:latestTurn ? result : undefined,
    latestTurn,resultPath:path,preview,usage,usageScope: lifetime ? "lifetime" : usage ? "latest-run" : undefined,autoStopped:job.autoStopped || undefined};
}

export async function getSubagentStatuses(root: string, ids: string[], tmux: TmuxExecutor = execTmux, options: StatusOptions = {}): Promise<PromiseSettledResult<SubagentStatusResult>[]> {
  if (!ids.length) return [];
  const registry = options.registry ?? await loadJobs(root);
  const observations = await Promise.allSettled(ids.map(async id => observeJob(root, selectJob(registry,id),tmux,options)));
  const changes = new Map<string, SubagentStatusResult>();
  for (const result of observations) if (result.status === "fulfilled") {
    const before = selectJob(registry,result.value.job.id);
    if (before.status !== result.value.status || before.error !== result.value.job.error) changes.set(before.id,result.value);
  }
  // One shared final read protects all rows from concurrent auto-stop/resume changes.
  const latest = changes.size ? await withStateLock(root, async () => {
    const current = await loadJobs(root);
    const beforeById = new Map(registry.jobs.map(job => [job.id, job]));
    const changed: TmuxSubagentJob[] = [];
    const next = { ...current, jobs: current.jobs.map(job => {
      const observed = changes.get(job.id);
      const before = beforeById.get(job.id);
      if (!observed || !before || job.autoStopped || job.launchPending || job.executionId !== before.executionId || job.status !== before.status) return job;
      const updated = { ...job, status: observed.status, error: observed.job.error, updatedAt: Date.now() };
      changed.push(updated);
      return updated;
    }) };
    await saveJobs(root, next);
    for (const job of changed) await updateMirroredJobStatus(job, job.status, job.status === "error" ? job.error : undefined);
    return next;
  }) : await loadJobs(root);
  const byId = new Map(latest.jobs.map(job=>[job.id,job]));
  return observations.map(result => {
    if (result.status === "rejected") return result;
    const observed = result.value;
    const job = byId.get(observed.job.id);
    if (!job) return {status:"rejected",reason:new Error(`Unknown job: ${observed.job.id}`)};
    if (job.executionId !== observed.job.executionId) return {status:"fulfilled",value:{job,status:job.status,autoStopped:job.autoStopped || undefined}};
    return {status:"fulfilled",value:{...observed,job,status:job.autoStopped ? "stopped" : job.status,autoStopped:job.autoStopped || undefined}};
  });
}

export async function getSubagentStatus(root: string, idOrPrefix: string, tmux: TmuxExecutor = execTmux, options: StatusOptions = {}): Promise<SubagentStatusResult> {
  const result = (await getSubagentStatuses(root,[idOrPrefix],tmux,options))[0]!;
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export async function readSubagentResult(root: string, id: string, expected?: SubagentStatusResult): Promise<string | undefined> {
  const status = await getSubagentStatus(root,id);
  if (expected && (expected.job.executionId !== status.job.executionId || expected.resultPath !== status.resultPath)) {
    throw new Error("Child result changed; refresh and expand it again.");
  }
  return status.resultPath ? readOptional(status.resultPath) : undefined;
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
  const stopped = await withStateLock(root, async () => {
    const registry = await loadJobs(root);
    const jobs = jobSubtree(registry.jobs, target.id);
    for (const job of jobs.slice().reverse()) {
      if (await sessionExists(tmux, job.tmuxSession)) await killSession(tmux, job.tmuxSession);
    }
    // No execution remains current after an explicit stop. Retain its final heartbeat
    // for reported usage; old writers still fail their execution-ID guard.
    const updated = jobs.map(job => ({ ...job, status: "stopped" as const, launchPending: undefined,
      executionId: undefined, updatedAt: Date.now() }));
    const byId = new Map(updated.map(job => [job.id, job]));
    await saveJobs(root, { ...registry, jobs: registry.jobs.map(job => byId.get(job.id) ?? job) });
    for (const job of updated) await removeMirroredJobs([job], job.hubDir ?? process.env.PI_AGENT_HUB_DIR);
    return updated;
  });
  return stopped.find((job) => job.id === target.id)!;
}

export async function finalizeStoppedSubagents(
  root: string,
  jobs: TmuxSubagentJob[],
  autoStopped = false,
): Promise<TmuxSubagentJob[]> {
  if (jobs.length === 0) return [];
  const expected = new Map(jobs.map(job => [job.id, job.executionId]));
  const stoppedAt = Date.now();
  return withStateLock(root, async () => {
    const latest = await loadJobs(root);
    const updatedRegistry = {
      ...latest,
      jobs: latest.jobs.map((job) => {
        if (!expected.has(job.id) || job.executionId !== expected.get(job.id)) return job;
        const nextAutoStopped = job.autoStopped || autoStopped || undefined;
        if (job.status === "stopped" && job.autoStopped === nextAutoStopped) return job;
        return { ...job, status: "stopped" as const, autoStopped: nextAutoStopped, updatedAt: stoppedAt };
      }),
    };
    await saveJobs(root, updatedRegistry);
    const stopped = updatedRegistry.jobs.filter(job => expected.has(job.id) && job.executionId === expected.get(job.id));
    for (const job of stopped) await removeMirroredJobs([job], job.hubDir ?? process.env.PI_AGENT_HUB_DIR);
    return stopped;
  });
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
    const turnComplete = (options.afterTurnIndex === undefined || (status.latestTurn?.index ?? 0) > options.afterTurnIndex)
      && (options.executionId === undefined || status.latestTurn?.executionId === options.executionId);
    if (options.executionId !== undefined) {
      if (status.job.executionId !== options.executionId && !(status.status === "stopped" && status.job.executionId === undefined)) {
        throw new Error(`Subagent execution changed while waiting: ${id}`);
      }
      if (status.status === "stopped" && !turnComplete) throw new Error(`Subagent stopped before completing the requested turn: ${id}`);
    }
    if (["stopped", "error"].includes(status.status)) return status;
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

    const statuses = await getSubagentStatuses(root, candidates.map(job => job.id), tmux);
    for (const result of statuses) {
      if (result.status === "rejected") throw result.reason;
      const status = result.value;
      options.onUpdate?.(status);
      if (status.status !== "starting" && status.status !== "running") return status;
    }
    await sleep(intervalMs);
  }
}
