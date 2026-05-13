import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TmuxSubagentJob } from "./types.js";

export interface PiSessionsMirrorContext {
  sessionsDir: string;
  parentId: string;
  parentGroup: string;
}

interface ManagedSessionLike {
  id: string;
  title: string;
  cwd: string;
  group: string;
  tmuxSession: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  kind?: "main" | "subagent";
  parentId?: string;
  agentName?: string;
  taskPreview?: string;
  resultPath?: string;
}

interface RegistryLike {
  version: 1;
  sessions: ManagedSessionLike[];
}

export function detectPiSessionsMirror(): PiSessionsMirrorContext | null {
  const sessionsDir = process.env.PI_SESSIONS_DIR;
  const parentId = process.env.PI_SESSIONS_SESSION_ID;
  if (!sessionsDir || !parentId) return null;

  const registryPath = join(sessionsDir, "registry.json");
  if (!existsSync(registryPath)) return null;

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryLike;
  const parent = registry.sessions?.find((session) => session.id === parentId);
  if (!parent) return null;

  return { sessionsDir, parentId, parentGroup: parent.group ?? "default" };
}

export function mirroredTmuxSessionName(childId: string): string {
  return `pi-sessions-${childId.slice(0, 12)}`;
}

export async function mirrorJobToPiSessions(job: TmuxSubagentJob, mirror: PiSessionsMirrorContext): Promise<void> {
  const registryPath = join(mirror.sessionsDir, "registry.json");
  await withRegistryLock(mirror.sessionsDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    if (!registry.sessions.some((session) => session.id === mirror.parentId)) return;
    const row = createMirroredRow(job, mirror);
    const index = registry.sessions.findIndex((session) => session.id === job.id);
    const sessions = registry.sessions.slice();
    if (index === -1) sessions.push(row);
    else sessions[index] = { ...sessions[index], ...row, createdAt: sessions[index]!.createdAt };
    await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
}

export async function updateMirroredJobStatus(job: TmuxSubagentJob, status: string, error?: string): Promise<void> {
  const sessionsDir = process.env.PI_SESSIONS_DIR;
  if (!sessionsDir) return;
  const registryPath = join(sessionsDir, "registry.json");
  if (!existsSync(registryPath)) return;
  await withRegistryLock(sessionsDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    const sessions = registry.sessions.map((session) => session.id === job.id ? { ...session, status, error, updatedAt: Date.now() } : session);
    await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
}

export async function removeMirroredJob(job: TmuxSubagentJob): Promise<void> {
  const sessionsDir = process.env.PI_SESSIONS_DIR;
  if (!sessionsDir) return;
  const registryPath = join(sessionsDir, "registry.json");
  if (!existsSync(registryPath)) return;
  await withRegistryLock(sessionsDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    const sessions = registry.sessions.filter((session) => session.id !== job.id);
    await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
}

export async function rewriteMirroredResultPaths(jobs: TmuxSubagentJob[], oldRoot: string, newRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const sessionsDir = env.PI_SESSIONS_DIR;
  if (!sessionsDir) return 0;
  const registryPath = join(sessionsDir, "registry.json");
  if (!existsSync(registryPath)) return 0;
  const resultPaths = new Map(jobs.map((job) => [job.id, job.resultPath]));
  let rewritten = 0;
  await withRegistryLock(sessionsDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    const sessions = registry.sessions.map((session) => {
      const resultPath = resultPaths.get(session.id);
      if (!resultPath || session.resultPath === resultPath) return session;
      if (session.resultPath && !session.resultPath.startsWith(`${oldRoot}/`)) return session;
      rewritten += 1;
      return { ...session, resultPath, updatedAt: Date.now() };
    });
    if (rewritten > 0) await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
  return rewritten;
}

function createMirroredRow(job: TmuxSubagentJob, mirror: PiSessionsMirrorContext): ManagedSessionLike {
  const now = Date.now();
  return {
    id: job.id,
    title: job.agentName,
    cwd: job.cwd,
    group: mirror.parentGroup,
    tmuxSession: job.tmuxSession,
    status: job.status,
    createdAt: job.createdAt || now,
    updatedAt: now,
    kind: "subagent",
    parentId: mirror.parentId,
    agentName: job.agentName,
    taskPreview: job.taskPreview,
    resultPath: job.resultPath,
  };
}

async function withRegistryLock<T>(sessionsDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(sessionsDir, "registry.lock");
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 5000) throw new Error(`Timed out waiting for pi-sessions registry lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
