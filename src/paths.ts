import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { STATE_DIR_BASENAME, STATE_ENV } from "./names.js";

export function codingAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[STATE_ENV] ?? join(codingAgentDir(env), STATE_DIR_BASENAME);
}

export function jobsPath(root = stateRoot()): string {
  return join(root, "jobs.json");
}

export function jobDir(root: string, id: string): string {
  return join(root, "jobs", id);
}

export function heartbeatPath(root: string, id: string): string {
  return join(jobDir(root, id), "heartbeat.json");
}

export function metadataPath(root: string, id: string): string {
  return join(jobDir(root, id), "metadata.json");
}

export function resultPath(root: string, id: string): string {
  return join(jobDir(root, id), "result.md");
}

export function turnsDir(root: string, id: string): string {
  return join(jobDir(root, id), "turns");
}

export function turnsPath(root: string, id: string): string {
  return join(turnsDir(root, id), "turns.json");
}

export function turnResultPath(root: string, id: string, index: number): string {
  return join(turnsDir(root, id), `${String(index).padStart(3, "0")}-result.md`);
}

export function agentSystemPath(root: string, id: string): string {
  return join(jobDir(root, id), "agent-system.md");
}

export function taskPath(root: string, id: string): string {
  return join(jobDir(root, id), "task.md");
}

export function userAgentsDir(): string {
  return join(codingAgentDir(), "agents");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function findProjectAgentsDir(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
