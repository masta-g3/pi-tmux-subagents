import { lstat, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LEGACY_STATE_DIR_BASENAME, LEGACY_TMUX_SESSION_PREFIX, STATE_DIR_BASENAME, STATE_ENV, TMUX_SESSION_PREFIX } from "./names.js";
import { codingAgentDir, metadataPath } from "./paths.js";
import { rewriteMirroredResultPaths } from "./pi-sessions-adapter.js";
import { loadJobs, saveJobs } from "./state.js";
import { execTmux, renameSession, type TmuxExecutor } from "./tmux.js";
import type { TmuxSubagentJob, TmuxSubagentsRegistry } from "./types.js";

export interface MigrationSummary {
  migratedRoot?: { from: string; to: string };
  legacySymlink?: "created" | "skipped" | "failed";
  rewrittenJobs: number;
  rewrittenMetadata: number;
  rewrittenMirrorRows: number;
  renamedTmuxSessions: number;
  warnings: string[];
}

interface StateRoots {
  root: string;
  legacyRoot: string;
  explicit: boolean;
}

export function defaultStateRoots(env: NodeJS.ProcessEnv = process.env): StateRoots {
  const agentDir = codingAgentDir(env);
  const explicitRoot = env[STATE_ENV];
  return {
    root: explicitRoot ?? join(agentDir, STATE_DIR_BASENAME),
    legacyRoot: join(agentDir, LEGACY_STATE_DIR_BASENAME),
    explicit: explicitRoot !== undefined,
  };
}

export async function migrateLegacyState(options: { env?: NodeJS.ProcessEnv; tmux?: TmuxExecutor } = {}): Promise<MigrationSummary> {
  const env = options.env ?? process.env;
  const tmux = options.tmux ?? execTmux;
  const { root, legacyRoot, explicit } = defaultStateRoots(env);
  const summary: MigrationSummary = {
    legacySymlink: "skipped",
    rewrittenJobs: 0,
    rewrittenMetadata: 0,
    rewrittenMirrorRows: 0,
    renamedTmuxSessions: 0,
    warnings: [],
  };

  const legacyState = await pathState(legacyRoot);
  const rootState = await pathState(root);

  if (!explicit && legacyState.exists && !rootState.exists) {
    await rename(legacyRoot, root);
    summary.migratedRoot = { from: legacyRoot, to: root };
    try {
      await symlink(root, legacyRoot, "dir");
      summary.legacySymlink = "created";
    } catch (error) {
      summary.legacySymlink = "failed";
      summary.warnings.push(`Could not create legacy state symlink ${legacyRoot} -> ${root}: ${message(error)}`);
    }
  } else if (!explicit && legacyState.exists && rootState.exists && !legacyState.isSymlink) {
    summary.warnings.push(`legacy state root still exists and was not merged: ${legacyRoot}`);
  }

  if (!(await pathState(root)).exists) return summary;

  const registry = await loadJobs(root);
  const rewritten = await rewriteRegistry(root, legacyRoot, registry, tmux, summary);
  if (rewritten) await saveJobs(root, registry);
  summary.rewrittenMirrorRows = await rewriteMirroredResultPaths(registry.jobs, legacyRoot, root, env);
  return summary;
}

async function rewriteRegistry(root: string, legacyRoot: string, registry: TmuxSubagentsRegistry, tmux: TmuxExecutor, summary: MigrationSummary): Promise<boolean> {
  let changed = false;
  const nextJobs: TmuxSubagentJob[] = [];
  for (const job of registry.jobs) {
    const next = await rewriteJob(root, legacyRoot, job, tmux, summary);
    if (next !== job) changed = true;
    nextJobs.push(next);
  }
  registry.jobs = nextJobs;
  return changed;
}

async function rewriteJob(root: string, legacyRoot: string, job: TmuxSubagentJob, tmux: TmuxExecutor, summary: MigrationSummary): Promise<TmuxSubagentJob> {
  let next = job;
  const resultPath = rewriteRoot(job.resultPath, legacyRoot, root);
  if (resultPath !== job.resultPath) next = { ...next, resultPath };

  if (job.tmuxSession.startsWith(LEGACY_TMUX_SESSION_PREFIX)) {
    const desired = `${TMUX_SESSION_PREFIX}${job.tmuxSession.slice(LEGACY_TMUX_SESSION_PREFIX.length)}`;
    const renameResult = await renameTmuxIfSafe(job.tmuxSession, desired, tmux);
    if (renameResult === "renamed") {
      summary.renamedTmuxSessions += 1;
      next = { ...next, tmuxSession: desired };
    } else if (renameResult === "old-missing") {
      next = { ...next, tmuxSession: desired };
    } else {
      summary.warnings.push(`Could not rename tmux session ${job.tmuxSession} to ${desired}: ${renameResult}`);
    }
  }

  if (next !== job) {
    summary.rewrittenJobs += 1;
    if (await rewriteMetadata(root, next)) summary.rewrittenMetadata += 1;
  }
  return next;
}

async function renameTmuxIfSafe(oldName: string, newName: string, tmux: TmuxExecutor): Promise<"renamed" | "old-missing" | "new-exists" | string> {
  const oldState = await tmuxSessionState(tmux, oldName);
  if (oldState === "missing") return "old-missing";
  if (oldState !== "exists") return oldState;

  const newState = await tmuxSessionState(tmux, newName);
  if (newState === "exists") return "new-exists";
  if (newState !== "missing") return newState;

  try {
    await renameSession(tmux, oldName, newName);
    return "renamed";
  } catch (error) {
    return message(error);
  }
}

async function tmuxSessionState(tmux: TmuxExecutor, sessionName: string): Promise<"exists" | "missing" | string> {
  try {
    await tmux(["has-session", "-t", sessionName]);
    return "exists";
  } catch (error) {
    const text = `${message(error)}\n${typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : ""}`;
    return /can't find session|no server running/i.test(text) ? "missing" : text.trim();
  }
}

async function rewriteMetadata(root: string, job: TmuxSubagentJob): Promise<boolean> {
  const path = metadataPath(root, job.id);
  let data: { job?: TmuxSubagentJob; [key: string]: unknown };
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  data.job = { ...data.job, resultPath: job.resultPath, tmuxSession: job.tmuxSession } as TmuxSubagentJob;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return true;
}

function rewriteRoot(path: string, from: string, to: string): string {
  if (path === from) return to;
  const prefix = `${from}/`;
  return path.startsWith(prefix) ? `${to}/${path.slice(prefix.length)}` : path;
}

async function pathState(path: string): Promise<{ exists: boolean; isSymlink: boolean }> {
  try {
    const stat = await lstat(path);
    return { exists: true, isSymlink: stat.isSymbolicLink() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, isSymlink: false };
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
