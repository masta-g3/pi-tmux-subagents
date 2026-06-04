import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TmuxSubagentJob } from "./types.js";

export interface AgentHubMirrorContext {
  hubDir: string;
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
  agentType?: string;
  taskPreview?: string;
  resultPath?: string;
}

interface RegistryLike {
  version: 1;
  sessions: ManagedSessionLike[];
}

export function detectAgentHubMirror(): AgentHubMirrorContext | null {
  const hubDir = process.env.PI_AGENT_HUB_DIR;
  const parentId = process.env.PI_AGENT_HUB_SESSION_ID;
  if (!hubDir || !parentId) return null;

  const registryPath = join(hubDir, "registry.json");
  if (!existsSync(registryPath)) return null;

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryLike;
  const parent = registry.sessions?.find((session) => session.id === parentId);
  if (!parent) return null;

  return { hubDir, parentId, parentGroup: parent.group ?? "default" };
}

export function mirroredTmuxSessionName(childId: string): string {
  return `pi-agent-hub-${childId.slice(0, 12)}`;
}

export async function mirrorJobToAgentHub(job: TmuxSubagentJob, mirror: AgentHubMirrorContext): Promise<void> {
  const registryPath = join(mirror.hubDir, "registry.json");
  await withRegistryLock(mirror.hubDir, async () => {
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
  const hubDir = process.env.PI_AGENT_HUB_DIR;
  if (!hubDir) return;
  const registryPath = join(hubDir, "registry.json");
  if (!existsSync(registryPath)) return;
  await withRegistryLock(hubDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    const sessions = registry.sessions.map((session) => session.id === job.id ? { ...session, status, error, updatedAt: Date.now() } : session);
    await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
}

export async function removeMirroredJob(job: TmuxSubagentJob): Promise<void> {
  await removeMirroredJobs([job]);
}

export async function removeMirroredJobs(jobs: TmuxSubagentJob[]): Promise<void> {
  const hubDir = process.env.PI_AGENT_HUB_DIR;
  if (!hubDir || jobs.length === 0) return;
  const registryPath = join(hubDir, "registry.json");
  if (!existsSync(registryPath)) return;
  const ids = new Set(jobs.map((job) => job.id));
  await withRegistryLock(hubDir, async () => {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as RegistryLike;
    const sessions = registry.sessions.filter((session) => !ids.has(session.id));
    await writeJsonAtomic(registryPath, { ...registry, sessions });
  });
  await Promise.all([...ids].map((id) => rm(join(hubDir, "heartbeats", `${id}.json`), { force: true })));
}

function createMirroredRow(job: TmuxSubagentJob, mirror: AgentHubMirrorContext): ManagedSessionLike {
  const now = Date.now();
  const name = job.displayName ?? job.agentName;
  return {
    id: job.id,
    title: name,
    cwd: job.cwd,
    group: mirror.parentGroup,
    tmuxSession: job.tmuxSession,
    status: job.status,
    createdAt: job.createdAt || now,
    updatedAt: now,
    kind: "subagent",
    parentId: mirror.parentId,
    agentName: name,
    agentType: job.agentName,
    taskPreview: job.taskPreview,
    resultPath: job.resultPath,
  };
}

async function withRegistryLock<T>(hubDir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(hubDir, "registry.lock");
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > 5000) throw new Error(`Timed out waiting for pi-agent-hub registry lock: ${lockDir}`);
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
