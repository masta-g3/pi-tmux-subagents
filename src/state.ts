import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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

async function removeEmptyLock(lockDir: string): Promise<boolean> {
  try {
    await rmdir(lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function recoverAbandonedLock(lockDir: string): Promise<boolean> {
  try {
    const owners = await readdir(lockDir);
    if (owners.length === 0) {
      // Allow time to publish an owner, including for the old ownerless format.
      if (Date.now() - (await stat(lockDir)).mtimeMs < LOCK_TIMEOUT_MS) return false;
    } else {
      const pids = owners.map(owner => /^(\d+)\.[\da-f-]{36}\.owner$/.exec(owner)?.[1]);
      if (pids.some(pid => !pid || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0 || processIsAlive(Number(pid)))) return false;
      // Unique filenames prevent a competing recovery from unlinking a new owner.
      for (const owner of owners) await rm(join(lockDir, owner), { force: true });
    }
    // Never recursively remove a lock: a new owner may have published meanwhile.
    return await removeEmptyLock(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function withStateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const lockDir = join(root, "jobs.lock");
  const owner = `${process.pid}.${randomUUID()}.owner`;
  const candidate = join(root, `.jobs-lock-${owner}`);
  await mkdir(candidate);
  let acquired = false;
  try {
    await writeFile(join(candidate, owner), "", { flag: "wx" });
    const started = Date.now();
    while (!acquired) {
      if (await recoverAbandonedLock(lockDir)) {
        try {
          // Publish the directory and its owner together. Rename cannot replace
          // another contender's nonempty lock directory.
          await rename(candidate, lockDir);
          acquired = true;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        }
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${lockDir}`);
      await sleep(LOCK_RETRY_MS);
    }
    return await fn();
  } finally {
    if (acquired) {
      await rm(join(lockDir, owner), { force: true });
      await removeEmptyLock(lockDir);
    } else {
      await rm(candidate, { recursive: true, force: true });
    }
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
