import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SummaryStage =
  | "starting"
  | "planning"
  | "investigating"
  | "implementing"
  | "testing"
  | "debugging"
  | "reviewing"
  | "waiting"
  | "complete"
  | "blocked"
  | "unknown";

export interface SessionSummaryMetadata {
  goal?: string;
  status?: string;
  nextStep?: string;
  stage?: SummaryStage;
  confidence?: number;
  updatedAt: number;
}

export const SESSION_SUMMARY_STALE_MS = 60_000;
const SUMMARY_STAGES = new Set<SummaryStage>([
  "starting",
  "planning",
  "investigating",
  "implementing",
  "testing",
  "debugging",
  "reviewing",
  "waiting",
  "complete",
  "blocked",
  "unknown",
]);

export function isFreshSessionSummary(summary: Pick<SessionSummaryMetadata, "updatedAt">, now = Date.now()): boolean {
  return now - summary.updatedAt <= SESSION_SUMMARY_STALE_MS;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function metadataPath(hubDir: string, sessionId: string): string {
  return join(hubDir, "session-metadata", `${safeSessionId(sessionId)}.json`);
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function parseSummary(value: unknown, now: number): SessionSummaryMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Record<string, unknown>;
  if (typeof state.updatedAt !== "number" || !isFreshSessionSummary({ updatedAt: state.updatedAt }, now)) return undefined;
  if (typeof state.confidence === "number" && Number.isFinite(state.confidence) && state.confidence < 0.5) return undefined;

  const goal = cleanText(state.goal);
  const status = cleanText(state.status);
  const nextStep = cleanText(state.nextStep);
  const stage = typeof state.stage === "string" && SUMMARY_STAGES.has(state.stage as SummaryStage) ? state.stage as SummaryStage : undefined;
  const confidence = typeof state.confidence === "number" && Number.isFinite(state.confidence) ? state.confidence : undefined;
  if (!goal && !status && !nextStep && !stage) return undefined;

  return {
    ...(goal ? { goal } : {}),
    ...(status ? { status } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(stage ? { stage } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    updatedAt: state.updatedAt,
  };
}

async function readSessionSummary(hubDir: string, sessionId: string, now: number): Promise<SessionSummaryMetadata | undefined> {
  try {
    return parseSummary(JSON.parse(await readFile(metadataPath(hubDir, sessionId), "utf8")), now);
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
