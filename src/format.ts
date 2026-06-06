import { basename } from "node:path";
import { isFreshSessionSummary, type SessionSummaryMetadata } from "./session-summary.js";
import type { SubagentStatusResult, TmuxSubagentStatus, TmuxSubagentUsage } from "./types.js";

const STATUS_PRESENTATION: Record<TmuxSubagentStatus, { glyph: string; label: string; title: string }> = {
  starting: { glyph: "⟳", label: "starting", title: "Starting" },
  running: { glyph: "⟳", label: "running", title: "Running" },
  waiting: { glyph: "✓", label: "done", title: "Done" },
  stopped: { glyph: "■", label: "stopped", title: "Stopped" },
  error: { glyph: "✗", label: "error", title: "Error" },
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
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

function formatCompactUsage(status: SubagentStatusResult): string | undefined {
  const usage = statusUsage(status);
  if (!usage) return undefined;
  return `${formatNumber(usage.input)}/${formatNumber(usage.output)} · ${formatCost(usage.cost.total)}`;
}

function formatCardUsage(status: SubagentStatusResult): string | undefined {
  const usage = statusUsage(status);
  if (!usage) return undefined;
  const tokenText = usage.output > 0 ? `${formatNumber(usage.output)} out` : `${formatNumber(usage.input)} in`;
  return `${tokenText} · ${formatCost(usage.cost.total)}`;
}

function lastActivity(status: SubagentStatusResult): string | undefined {
  if (!status.heartbeat || status.status !== "running" && status.status !== "starting") return undefined;
  return `${formatDuration(Date.now() - status.heartbeat.updatedAt)} ago`;
}

function formatActivityLabel(status: SubagentStatusResult, now = Date.now()): string | undefined {
  if (!status.heartbeat || status.status !== "running" && status.status !== "starting") return undefined;
  const age = Math.max(0, now - status.heartbeat.updatedAt);
  if (age < 1000) return "active now";
  if (age < 60_000) return `active ${Math.floor(age / 1000)}s ago`;
  return `no activity for ${Math.floor(age / 60_000)}m`;
}

function compactName(status: SubagentStatusResult): string {
  return status.job.displayName ?? status.job.agentName;
}

function displayName(status: SubagentStatusResult): string {
  const name = compactName(status);
  return status.job.displayName && status.job.displayName !== status.job.agentName ? `${name} (${status.job.agentName})` : name;
}

function presentationFor(status: SubagentStatusResult): { glyph: string; label: string; title: string } {
  return status.status === "waiting" && status.job.autoStopOnComplete === false
    ? { glyph: "✓", label: "idle", title: "Ready" }
    : STATUS_PRESENTATION[status.status];
}

function snippet(text: string | undefined, maxLines = 8): string[] {
  const trimmed = text?.trim();
  if (!trimmed) return [];
  const allLines = trimmed.split(/\r?\n/);
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) lines.push("…");
  return lines;
}

function usefulPanePreview(text: string | undefined): string | undefined {
  const lines = text?.split(/\r?\n/) ?? [];
  const useful = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^pi v\d+\.\d+\.\d+/.test(trimmed)) return false;
    if (/escape interrupt .*\/ commands/.test(trimmed)) return false;
    if (/^Press ctrl\+o to show full startup help/.test(trimmed)) return false;
    if (/^Pi can explain its own features/.test(trimmed)) return false;
    if (/^Ask it how to use or extend Pi\.$/.test(trimmed)) return false;
    return true;
  });
  return useful.join("\n");
}

function statusElapsed(status: SubagentStatusResult): string {
  return formatDuration((status.heartbeat?.updatedAt ?? status.job.updatedAt) - status.job.createdAt);
}

function resultBasename(status: SubagentStatusResult): string {
  return basename(status.latestTurn?.resultPath ?? status.job.resultPath);
}

function truncateLine(text: string | undefined, max = 100): string | undefined {
  const compact = text?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function sanitizeWidgetDetail(text: string | undefined): string | undefined {
  return truncateLine(text?.replace(/(?:~|\/[^\s:;,.)\]}]+(?:\/[^\s:;,.)\]}]+)*)/g, (match) => basename(match)), 100);
}

function hasResult(status: SubagentStatusResult): boolean {
  return Boolean(status.latestTurn || status.latestResult || status.result);
}

export function formatSubagentFooterStatus(statuses: SubagentStatusResult[]): string | undefined {
  if (!statuses.length) return undefined;
  const counts = new Map<string, number>();
  let totalCost = 0;
  let hasCost = false;
  for (const status of statuses) {
    const label = presentationFor(status).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const usage = statusUsage(status);
    if (usage) {
      totalCost += usage.cost.total;
      hasCost = true;
    }
  }
  const order = ["starting", "running", "idle", "error", "done", "stopped"];
  const labels = [...order.filter((label) => counts.has(label)), ...[...counts.keys()].filter((label) => !order.includes(label))];
  const summary = labels.map((label) => `${counts.get(label)} ${label}`).join(" · ");
  return [`subagents: ${summary}`, hasCost ? formatCost(totalCost) : undefined].filter(Boolean).join(" · ");
}

function formatSubagentWidgetRows(statuses: SubagentStatusResult[]): string[] {
  const rows = statuses.map((status) => {
    const presentation = presentationFor(status);
    return {
      glyph: presentation.glyph,
      name: compactName(status),
      state: presentation.label,
      elapsed: statusElapsed(status),
      activity: lastActivity(status) ?? "—",
      usage: formatCompactUsage(status)?.replace(" · ", "  ") ?? "—",
    };
  });
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const stateWidth = Math.max(...rows.map((row) => row.state.length));
  const elapsedWidth = Math.max(...rows.map((row) => row.elapsed.length));
  const activityWidth = Math.max(...rows.map((row) => row.activity.length));
  return rows.map((row) => `${row.glyph} ${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  ${row.elapsed.padEnd(elapsedWidth)}  ${row.activity.padEnd(activityWidth)}  ${row.usage}`);
}

export function formatSubagentWidget(statuses: SubagentStatusResult[]): string[] | undefined {
  if (!statuses.length) return undefined;
  return ["tmux subagents", ...formatSubagentWidgetRows(statuses)];
}

type SubagentWidgetFormatOptions = {
  summaries?: Map<string, SessionSummaryMetadata>;
  now?: number;
  maxRows?: number;
};

function statusRank(status: SubagentStatusResult): number {
  if (status.status === "error") return 0;
  if (status.status === "starting" || status.status === "running") return 1;
  if (status.autoStopped) return 2;
  if (status.status === "waiting" && status.job.autoStopOnComplete === false) return 3;
  return 4;
}

function sortedWidgetStatuses(statuses: SubagentStatusResult[]): SubagentStatusResult[] {
  return [...statuses].sort((left, right) => statusRank(left) - statusRank(right) || (right.heartbeat?.updatedAt ?? right.job.updatedAt) - (left.heartbeat?.updatedAt ?? left.job.updatedAt));
}

function widgetPrimaryDetail(status: SubagentStatusResult, summaries: Map<string, SessionSummaryMetadata>, now: number): string | undefined {
  const metadata = summaries.get(status.job.id);
  const summary = metadata && isFreshSessionSummary(metadata, now) ? sanitizeWidgetDetail(metadata.summary) : undefined;
  if (summary) return `summary: ${summary}`;
  const task = sanitizeWidgetDetail(status.job.taskPreview);
  if (task) return `task: ${task}`;
  if ((status.status === "waiting" || status.status === "stopped" || status.status === "error") && hasResult(status)) return `result: ${resultBasename(status)}`;
  return undefined;
}

function formatSummaryRow(status: SubagentStatusResult, now: number): string {
  const presentation = presentationFor(status);
  const activity = formatActivityLabel(status, now);
  const usage = formatCardUsage(status);
  const terminalResult = (status.status === "waiting" || status.status === "stopped" || status.status === "error") && hasResult(status) ? `result ${resultBasename(status)}` : undefined;
  return [`${presentation.glyph} ${compactName(status)}`, presentation.label, activity, terminalResult, usage].filter(Boolean).join(" · ");
}

export function formatSubagentSummaryWidget(statuses: SubagentStatusResult[], options: SubagentWidgetFormatOptions = {}): string[] | undefined {
  if (!statuses.length) return undefined;
  const now = options.now ?? Date.now();
  const summaries = options.summaries ?? new Map<string, SessionSummaryMetadata>();
  const ordered = sortedWidgetStatuses(statuses);
  if (ordered.length === 1) {
    const status = ordered[0]!;
    const summary = summaries.get(status.job.id);
    const freshSummary = summary && isFreshSessionSummary(summary, now) ? sanitizeWidgetDetail(summary.summary) : undefined;
    const task = sanitizeWidgetDetail(status.job.taskPreview);
    return [
      "tmux subagent · background",
      formatSummaryRow(status, now),
      task ? `  ⎿ task: ${task}` : undefined,
      freshSummary ? `  ⎿ summary: ${freshSummary}` : undefined,
      "╰─ /subagents details · /subagents peek",
    ].filter((line): line is string => Boolean(line));
  }

  const maxRows = options.maxRows ?? 3;
  const visible = ordered.slice(0, maxRows);
  const lines = [formatSubagentFooterStatus(statuses)?.replace(/^subagents:/, "tmux subagents ·") ?? "tmux subagents"];
  visible.forEach((status, index) => {
    const last = index === visible.length - 1;
    const branch = last ? "└─" : "├─";
    const detailPrefix = last ? "   ⎿" : "│  ⎿";
    lines.push(`${branch} ${formatSummaryRow(status, now)}`);
    const detail = widgetPrimaryDetail(status, summaries, now);
    if (detail) lines.push(`${detailPrefix} ${detail}`);
  });
  const hidden = ordered.length - visible.length;
  if (hidden > 0) lines.push(`+${hidden} more · /subagents for details`);
  lines.push("╰─ /subagents details · /subagents peek");
  return lines;
}

export function formatSubagentPeekWidget(statuses: SubagentStatusResult[], summaries = new Map<string, SessionSummaryMetadata>()): string[] | undefined {
  if (!statuses.length) return undefined;
  const rows = formatSubagentWidgetRows(statuses);
  return [
    "tmux subagents · peek",
    ...statuses.flatMap((status, index) => {
      const task = truncateLine(status.job.taskPreview);
      const metadata = summaries.get(status.job.id);
      const summary = metadata && isFreshSessionSummary(metadata) ? truncateLine(metadata.summary) : undefined;
      return [
        rows[index],
        task ? `   task: ${task}` : undefined,
        summary ? `   summary: ${summary}` : undefined,
        (status.status === "waiting" || status.status === "stopped" || status.status === "error") && hasResult(status) ? `   result: ${resultBasename(status)}` : undefined,
      ].filter((line): line is string => Boolean(line));
    }),
  ];
}

export function formatUserStatusList(statuses: SubagentStatusResult[], hiddenStopped = 0): string {
  const lines = [
    "tmux subagents",
    [formatSubagentFooterStatus(statuses)?.replace(/^subagents: /, "") ?? "0 jobs", hiddenStopped ? `${hiddenStopped} stopped hidden` : undefined].filter(Boolean).join(" · "),
  ];

  const widget = formatSubagentWidget(statuses)?.slice(1) ?? [];
  lines.push(...widget.map((line) => ` ${line}`));
  return lines.join("\n");
}

export function formatUserStatus(status: SubagentStatusResult): string {
  const presentation = presentationFor(status);
  const activity = lastActivity(status);
  const usage = formatCardUsage(status);
  const parts = [presentation.label, statusElapsed(status), activity ? `activity ${activity}` : undefined, usage].filter(Boolean);
  const lines = [
    `tmux subagent ${displayName(status)}`,
    ` ${presentation.glyph} ${parts.join(" · ")}`,
  ];

  if (status.status === "error") {
    if (status.job.error) lines.push(`   error: ${status.job.error}`);
    lines.push(`   inspect result → ${resultBasename(status)}`);
  } else if ((status.status === "waiting" || status.status === "stopped") && (status.latestTurn || status.latestResult || status.result)) {
    lines.push(`   ✓ result ready → ${resultBasename(status)}`);
  }
  return lines.join("\n");
}

export function formatStatus(status: SubagentStatusResult): string {
  const presentation = presentationFor(status);
  const elapsed = formatDuration((status.heartbeat?.updatedAt ?? status.job.updatedAt) - status.job.createdAt);
  const result = snippet(status.result);
  const task = result.length ? [] : snippet(status.job.taskPreview, 4);
  const preview = result.length ? [] : snippet(usefulPanePreview(status.preview));
  const error = result.length || task.length || preview.length ? [] : snippet(status.job.error);
  const name = status.job.displayName ?? status.job.agentName;
  const lines = [
    `tmux subagent ${name}`,
    ` ${presentation.glyph} ${name} · ${presentation.label} · ${elapsed}`,
    `   ⎿  ${presentation.title}`,
  ];

  if (result.length) lines.push(...result.map((line) => `      ${line}`));
  else {
    if (task.length) lines.push("      Task:", ...task.map((line) => `      ${line}`));
    if (preview.length) lines.push("      Pane preview:", ...preview.map((line) => `      ${line}`));
    if (error.length) lines.push(...error.map((line) => `      ${line}`));
  }

  lines.push(
    `   tmux: ${status.job.tmuxSession}`,
    ...(status.job.model ? [`   model: ${status.job.model}`] : []),
    `   attach: tmux attach-session -t ${status.job.tmuxSession}`,
    `   output: ${status.latestTurn?.resultPath ?? status.job.resultPath}`,
  );
  if (status.autoStopped) {
    lines.push("   auto-stopped after completion");
    if (status.mirrorCleanupError) lines.push(`   pi-agent-hub cleanup failed: ${status.mirrorCleanupError}`);
  } else {
    if (status.autoStopError) lines.push(`   auto-stop failed: ${status.autoStopError}`);
    lines.push(`   stop: tmux_subagent({ action: "stop", childId: "${status.job.id}" })`);
  }
  if (status.hygieneNote) lines.push(`   cleanup: ${status.hygieneNote}`);
  return lines.join("\n");
}
