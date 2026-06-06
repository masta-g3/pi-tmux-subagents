import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionSummaryMetadata {
  summary: string;
  phase?: string;
  updatedAt: number;
}

const SUMMARY_SOURCE = "pi-session-summary";
export const SESSION_SUMMARY_STALE_MS = 60_000;
const ACCEPTED_STATES = new Set(["starting", "running", "waiting", "complete", "blocked"]);

export function isFreshSessionSummary(summary: Pick<SessionSummaryMetadata, "updatedAt">, now = Date.now()): boolean {
  return now - summary.updatedAt <= SESSION_SUMMARY_STALE_MS;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function summaryPath(hubDir: string, sessionId: string): string {
  return join(hubDir, "session-summary", `${safeSessionId(sessionId)}.json`);
}

function parseSummary(value: unknown, now: number): SessionSummaryMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || state.source !== SUMMARY_SOURCE) return undefined;
  if (typeof state.state !== "string" || !ACCEPTED_STATES.has(state.state)) return undefined;
  if (typeof state.summary !== "string" || !state.summary.trim()) return undefined;
  if (typeof state.updatedAt !== "number" || !isFreshSessionSummary({ updatedAt: state.updatedAt }, now)) return undefined;
  return {
    summary: state.summary.replace(/\s+/g, " ").trim(),
    phase: typeof state.phase === "string" ? state.phase : undefined,
    updatedAt: state.updatedAt,
  };
}

async function readSessionSummary(hubDir: string, sessionId: string, now: number): Promise<SessionSummaryMetadata | undefined> {
  try {
    return parseSummary(JSON.parse(await readFile(summaryPath(hubDir, sessionId), "utf8")), now);
  } catch {
    return undefined;
  }
}

export async function readSessionSummaries(jobIds: string[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<Map<string, SessionSummaryMetadata>> {
  const hubDir = env.PI_AGENT_HUB_DIR;
  if (!hubDir || jobIds.length === 0) return new Map();
  const entries = await Promise.all([...new Set(jobIds)].map(async (id) => [id, await readSessionSummary(hubDir, id, now)] as const));
  return new Map(entries.filter((entry): entry is readonly [string, SessionSummaryMetadata] => Boolean(entry[1])));
}
