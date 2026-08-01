import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SUBAGENT_UI } from "./ui-tokens.js";
import { compactGroupCountSummary, groupCountSummary, sortSubagentRows, type SubagentViewRow } from "./view-model.js";

type Theme = {
  fg?: (token: string, text: string) => string;
  bg?: (token: string, text: string) => string;
  bold?: (text: string) => string;
};

function fg(theme: Theme, token: string, text: string): string {
  return theme.fg ? theme.fg(token, text) : text;
}

function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

function totalCost(rows: SubagentViewRow[]): string | undefined {
  const costs = rows.map((row) => row.cost).filter((cost): cost is number => cost !== undefined);
  return costs.length ? formatCost(costs.reduce((sum, cost) => sum + cost, 0)) : undefined;
}

function formatAge(updatedAt: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - updatedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function pad(text: string, width: number): string {
  const value = truncateToWidth(text, Math.max(0, width));
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function exceptionToken(row: SubagentViewRow): string | undefined {
  if (row.group === "needsInput") return SUBAGENT_UI.theme.attention;
  if (row.group === "error") return SUBAGENT_UI.theme.error;
  return undefined;
}

function renderRow(row: SubagentViewRow, width: number, theme: Theme, now: number): string {
  const glyph = row.group === "done" ? "·" : row.glyph;
  const token = exceptionToken(row);
  const styledGlyph = token ? fg(theme, token, glyph) : glyph;
  const nameWidth = Math.min(SUBAGENT_UI.nameMax, Math.max(SUBAGENT_UI.nameMin, Math.floor(width * 0.22)));
  const age = formatAge(row.updatedAt, now);
  const wide = width >= SUBAGENT_UI.wideViewMin;
  const fixedWidth = 2 + nameWidth + 2 + (wide ? age.length + 2 : 0);
  const detailWidth = Math.max(0, width - fixedWidth);
  const name = pad(row.name, nameWidth);
  const detail = truncateToWidth(row.detail, detailWidth);
  const styledDetail = token ? fg(theme, token, detail) : detail;
  const body = `${styledGlyph} ${fg(theme, SUBAGENT_UI.theme.primary, name)}  ${styledDetail}`;
  if (!wide) return truncateToWidth(body, width);
  const plainBodyWidth = 2 + nameWidth + 2 + visibleWidth(detail);
  const gap = " ".repeat(Math.max(2, width - plainBodyWidth - age.length));
  return truncateToWidth(`${body}${gap}${fg(theme, SUBAGENT_UI.theme.tertiary, age)}`, width);
}

export function nextWidgetAgeRefreshMs(rows: SubagentViewRow[], now = Date.now()): number | undefined {
  if (!rows.length) return undefined;
  const delays = rows.map((row) => {
    const age = Math.max(0, now - row.updatedAt);
    const unit = age < 60_000 ? 1_000 : 60_000;
    return unit - (age % unit) || unit;
  });
  return Math.max(1, Math.min(...delays));
}

export class SubagentsWidgetComponent {
  constructor(private rows: SubagentViewRow[], private theme: Theme, private now: () => number = Date.now) {}

  invalidate() {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const ordered = sortSubagentRows(this.rows);
    const visible = ordered.slice(0, SUBAGENT_UI.widgetRowLimit);
    const summary = safeWidth < SUBAGENT_UI.wideViewMin
      ? compactGroupCountSummary(ordered)
      : [groupCountSummary(ordered) || "no jobs", totalCost(ordered)].filter(Boolean).join(" · ");
    const lines = [fg(this.theme, SUBAGENT_UI.theme.secondary, `subagents · ${summary}`)];
    lines.push(...visible.map((row) => renderRow(row, safeWidth, this.theme, this.now())));
    const hidden = ordered.length - visible.length;
    if (hidden > 0) lines.push(fg(this.theme, SUBAGENT_UI.theme.tertiary, `+${hidden} more · /subagents`));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }
}

export function createSubagentsWidget(rows: SubagentViewRow[], theme: Theme, now: () => number = Date.now): SubagentsWidgetComponent {
  return new SubagentsWidgetComponent(rows, theme, now);
}
