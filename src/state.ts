import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jobsPath } from "./paths.js";
import type { TmuxSubagentJob, TmuxSubagentsRegistry } from "./types.js";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

export const emptyJobs = (): TmuxSubagentsRegistry => ({ version: 1, jobs: [] });

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockDir = join(root, "jobs.lock");
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${lockDir}`);
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function loadJobs(root: string): Promise<TmuxSubagentsRegistry> {
  const registry = await readJsonOr<TmuxSubagentsRegistry>(jobsPath(root), emptyJobs());
  if (registry.version !== 1 || !Array.isArray(registry.jobs)) throw new Error(`Unsupported jobs registry: ${jobsPath(root)}`);
  return registry;
}

export async function saveJobs(root: string, registry: TmuxSubagentsRegistry): Promise<void> {
  await writeJsonAtomic(jobsPath(root), registry);
}

export async function updateJobs(
  root: string,
  mutate: (registry: TmuxSubagentsRegistry) => TmuxSubagentsRegistry | void,
): Promise<TmuxSubagentsRegistry> {
  return withStateLock(root, async () => {
    const registry = await loadJobs(root);
    const next = mutate(registry) ?? registry;
    await saveJobs(root, next);
    return next;
  });
}

export async function upsertJob(root: string, job: TmuxSubagentJob): Promise<TmuxSubagentJob> {
  await updateJobs(root, (registry) => {
    const index = registry.jobs.findIndex((item) => item.id === job.id);
    if (index === -1) return { ...registry, jobs: [...registry.jobs, job] };
    const jobs = registry.jobs.slice();
    jobs[index] = job;
    return { ...registry, jobs };
  });
  return job;
}

export async function resolveJob(root: string, idOrPrefix: string): Promise<TmuxSubagentJob> {
  const registry = await loadJobs(root);
  const matches = registry.jobs.filter((job) => job.id === idOrPrefix || job.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`Unknown job: ${idOrPrefix}`);
  if (matches.length > 1) throw new Error(`Ambiguous job prefix: ${idOrPrefix}`);
  return matches[0]!;
}

export async function updateJob(
  root: string,
  idOrPrefix: string,
  mutate: (job: TmuxSubagentJob) => TmuxSubagentJob,
): Promise<TmuxSubagentJob> {
  let updated: TmuxSubagentJob | undefined;
  await updateJobs(root, (registry) => {
    const matches = registry.jobs.map((job, index) => ({ job, index })).filter(({ job }) => job.id === idOrPrefix || job.id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`Unknown job: ${idOrPrefix}`);
    if (matches.length > 1) throw new Error(`Ambiguous job prefix: ${idOrPrefix}`);
    const jobs = registry.jobs.slice();
    updated = mutate(matches[0]!.job);
    jobs[matches[0]!.index] = updated;
    return { ...registry, jobs };
  });
  return updated!;
}
