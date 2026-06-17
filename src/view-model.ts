import { basename } from "node:path";
import type { SessionSummaryMetadata } from "./session-summary.js";
import { isFreshSessionSummary } from "./session-summary.js";
import type { SubagentStatusResult, TmuxSubagentUsage } from "./types.js";

export type SubagentPresentationGroup = "needsInput" | "running" | "idle" | "done" | "error";

export interface SubagentViewRow {
  id: string;
  shortId: string;
  name: string;
  agentName: string;
  group: SubagentPresentationGroup;
  glyph: string;
  stateLabel: string;
  activity: string;
  age: string;
  usage?: string;
  resultFile?: string;
  tmuxSession: string;
  attachCommand: string;
  canReply: boolean;
  canStop: boolean;
  canPeek: boolean;
  parentId?: string;
  status: SubagentStatusResult;
}

export interface SubagentViewModelOptions {
  summaries?: Map<string, SessionSummaryMetadata>;
  now?: number;
}

export const GROUP_LABELS: Record<SubagentPresentationGroup, string> = {
  needsInput: "Needs input",
  running: "Running",
  idle: "Idle",
  done: "Done",
  error: "Error",
};

const GROUP_ORDER: SubagentPresentationGroup[] = ["needsInput", "running", "idle", "done", "error"];

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

function statusUsage(status: SubagentStatusResult): TmuxSubagentUsage | undefined {
  return status.usage ?? status.heartbeat?.usage ?? status.latestTurn?.usage;
}

function compactUsage(status: SubagentStatusResult): string | undefined {
  const usage = statusUsage(status);
  if (!usage) return undefined;
  return `${formatNumber(usage.output || usage.input)} ${usage.output ? "out" : "in"} · ${formatCost(usage.cost.total)}`;
}

function hasResult(status: SubagentStatusResult): boolean {
  return Boolean(status.latestTurn || status.latestResult || status.result);
}

function resultFile(status: SubagentStatusResult): string | undefined {
  if (!hasResult(status)) return undefined;
  return basename(status.latestTurn?.resultPath ?? status.job.resultPath);
}

function groupFor(status: SubagentStatusResult): SubagentPresentationGroup {
  if (status.status === "error") return "error";
  if (status.heartbeat?.attention && status.status !== "stopped") return "needsInput";
  if (status.status === "starting" || status.status === "running") return "running";
  if (status.status === "waiting" && status.job.autoStopOnComplete === false) return "idle";
  return "done";
}

function stateFor(group: SubagentPresentationGroup): { glyph: string; label: string } {
  if (group === "needsInput") return { glyph: "✸", label: "needs input" };
  if (group === "running") return { glyph: "⟳", label: "running" };
  if (group === "idle") return { glyph: "✓", label: "idle" };
  if (group === "error") return { glyph: "✗", label: "error" };
  return { glyph: "·", label: "done" };
}

function cleanActivity(text: string | undefined, max = 120): string | undefined {
  const compact = text?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function activityFor(status: SubagentStatusResult, summaries: Map<string, SessionSummaryMetadata>, now: number): string {
  const attention = cleanActivity(status.heartbeat?.attention?.message);
  if (attention) return attention;
  const metadata = summaries.get(status.job.id);
  if (metadata && isFreshSessionSummary(metadata, now)) {
    const semantic = cleanActivity(metadata.status ?? metadata.goal ?? metadata.nextStep);
    if (semantic) return semantic;
  }
  const turn = cleanActivity(status.latestTurn?.messagePreview);
  if (turn) return turn;
  const result = resultFile(status);
  if ((status.status === "waiting" || status.status === "stopped" || status.status === "error") && result) return `result ${result}`;
  return cleanActivity(status.job.taskPreview) ?? "—";
}

function rowUpdatedAt(status: SubagentStatusResult): number {
  return status.heartbeat?.updatedAt ?? status.latestTurn?.completedAt ?? status.job.updatedAt;
}

export function toSubagentViewRows(statuses: SubagentStatusResult[], options: SubagentViewModelOptions = {}): SubagentViewRow[] {
  const now = options.now ?? Date.now();
  const summaries = options.summaries ?? new Map<string, SessionSummaryMetadata>();
  return statuses.map((status) => {
    const group = groupFor(status);
    const state = stateFor(group);
    return {
      id: status.job.id,
      shortId: status.job.id.slice(0, 12),
      name: status.job.displayName ?? status.job.agentName,
      agentName: status.job.agentName,
      group,
      glyph: state.glyph,
      stateLabel: state.label,
      activity: activityFor(status, summaries, now),
      age: formatDuration(now - rowUpdatedAt(status)),
      usage: compactUsage(status),
      resultFile: resultFile(status),
      tmuxSession: status.job.tmuxSession,
      attachCommand: `tmux attach-session -t ${status.job.tmuxSession}`,
      canReply: status.status === "waiting" || Boolean(status.heartbeat?.attention),
      canStop: status.status !== "stopped",
      canPeek: true,
      parentId: status.job.parentId,
      status,
    };
  });
}

export function sortSubagentRows(rows: SubagentViewRow[]): SubagentViewRow[] {
  return [...rows].sort((left, right) => {
    const group = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
    if (group) return group;
    return rowUpdatedAt(right.status) - rowUpdatedAt(left.status) || left.id.localeCompare(right.id);
  });
}

export function groupSubagentRows(rows: SubagentViewRow[]): Map<SubagentPresentationGroup, SubagentViewRow[]> {
  const grouped = new Map<SubagentPresentationGroup, SubagentViewRow[]>();
  for (const row of sortSubagentRows(rows)) {
    const list = grouped.get(row.group) ?? [];
    list.push(row);
    grouped.set(row.group, list);
  }
  return grouped;
}

export function groupCountSummary(rows: SubagentViewRow[]): string {
  const grouped = groupSubagentRows(rows);
  return GROUP_ORDER.map((group) => {
    const count = grouped.get(group)?.length ?? 0;
    if (!count) return undefined;
    const label = group === "needsInput" ? "needs input" : group === "running" ? "running" : group === "idle" ? "idle" : group === "error" ? "error" : "done";
    return `${count} ${label}`;
  }).filter(Boolean).join(" · ");
}
