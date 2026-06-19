import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GROUP_LABELS, groupCountSummary, groupSubagentRows, sortSubagentRows, type SubagentViewRow } from "./view-model.js";

export type SubagentsViewAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "peek"; id: string }
  | { type: "reply"; id: string }
  | { type: "stop"; id: string; confirmed?: boolean }
  | { type: "attach"; id: string }
  | { type: "result"; id: string };

type Theme = { fg?: (token: string, text: string) => string; bold?: (text: string) => string };

type Done = (action: SubagentsViewAction | undefined) => void;

const DONE_ROW_LIMIT = 5;

function fg(theme: Theme, token: string, text: string): string {
  return theme.fg ? theme.fg(token, text) : text;
}

function bold(theme: Theme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function padOrTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  const truncated = truncateToWidth(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function leftPadOrTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  const truncated = truncateToWidth(text, width);
  return `${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${truncated}`;
}

function lineToWidth(parts: string[], width: number): string {
  return truncateToWidth(parts.join(""), width);
}

function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
}

function usageCost(row: SubagentViewRow): number | undefined {
  return row.status.usage?.cost.total ?? row.status.heartbeat?.usage?.cost.total ?? row.status.latestTurn?.usage?.cost.total;
}

function totalCost(rows: SubagentViewRow[]): string | undefined {
  let total = 0;
  let hasCost = false;
  for (const row of rows) {
    const cost = usageCost(row);
    if (cost === undefined) continue;
    total += cost;
    hasCost = true;
  }
  return hasCost ? formatCost(total) : undefined;
}

function rowActivityText(row: SubagentViewRow): string {
  if ((row.group === "idle" || row.group === "done") && row.resultFile) return [`result ${row.resultFile}`, row.usage].filter(Boolean).join(" · ");
  return row.activity;
}

function cleanPeekText(text: string | undefined, max = 120): string | undefined {
  const withoutPaths = text?.replace(/(?:~|\/[^\s:;,.)\]}]+(?:\/[^\s:;,.)\]}]+)*)/g, (match) => match.split("/").filter(Boolean).at(-1) ?? match);
  const compact = withoutPaths?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export class SubagentsViewComponent {
  private selected = 0;
  private showPeek = true;
  private confirmStopFor: string | undefined;

  constructor(private rows: SubagentViewRow[], private theme: Theme, private done: Done) {}

  invalidate() {}

  handleInput(data: string) {
    const row = this.selectedRow();
    if (this.confirmStopFor) {
      if (data.toLowerCase() === "y") this.done({ type: "stop", id: this.confirmStopFor, confirmed: true });
      else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape) || data === "\u0003") this.confirmStopFor = undefined;
      return;
    }

    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, this.visibleRows().length - 1), this.selected + 1);
    else if (matchesKey(data, Key.escape) || data === "\u0003") this.done({ type: "close" });
    else if ((data === " " || data === "p") && row?.canPeek) this.showPeek = !this.showPeek;
    else if (data === "r" && row?.canReply) this.done({ type: "reply", id: row.id });
    else if (data === "a" && row) this.done({ type: "attach", id: row.id });
    else if (data === "s" && row?.canStop) this.stopOrConfirm(row);
    else if (matchesKey(data, Key.enter) && row) row.resultFile ? this.done({ type: "result", id: row.id }) : this.done({ type: "attach", id: row.id });
    else if (data === "R") this.done({ type: "refresh" });
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const counts = [groupCountSummary(this.rows) || "no jobs", totalCost(this.rows)].filter(Boolean).join(" · ");
    const headerText = ` subagents view · ${counts} `;
    const refreshText = " R refresh ";
    const fill = "─".repeat(Math.max(1, safeWidth - visibleWidth(headerText) - visibleWidth(refreshText)));
    const lines = [
      fg(this.theme, "borderMuted", "─".repeat(safeWidth)),
      lineToWidth([fg(this.theme, "accent", bold(this.theme, headerText)), fg(this.theme, "borderMuted", fill), fg(this.theme, "dim", refreshText)], safeWidth),
      "",
    ];

    if (!this.rows.length) {
      lines.push(fg(this.theme, "muted", "No tmux subagent jobs."));
      lines.push("");
      lines.push(fg(this.theme, "dim", "↑↓ select • enter result/attach • R refresh • esc close"));
      return lines.map((line) => truncateToWidth(line, safeWidth));
    }

    const visibleRows = this.visibleRows();
    const grouped = groupSubagentRows(visibleRows);
    const hiddenDone = this.rows.filter((row) => row.group === "done").length - visibleRows.filter((row) => row.group === "done").length;
    let absoluteIndex = 0;
    for (const [group, groupRows] of grouped) {
      lines.push(fg(this.theme, "muted", `${GROUP_LABELS[group]} (${groupRows.length})`));
      for (const row of groupRows) {
        const selected = absoluteIndex === this.selected;
        const marker = selected ? ">" : " ";
        const glyphToken = row.group === "needsInput" ? "warning" : row.group === "running" ? "accent" : row.group === "error" ? "error" : row.group === "idle" ? "success" : "muted";
        const nameWidth = Math.min(22, Math.max(12, Math.floor(safeWidth * 0.22)));
        const ageWidth = Math.min(8, Math.max(3, row.age.length));
        const fixed = 2 + 2 + nameWidth + 2 + ageWidth;
        const activityWidth = Math.max(10, safeWidth - fixed);
        const text = [
          marker,
          " ",
          fg(this.theme, glyphToken, row.glyph),
          " ",
          padOrTruncate(row.name, nameWidth),
          "  ",
          padOrTruncate(rowActivityText(row), activityWidth),
          leftPadOrTruncate(row.age, ageWidth),
        ].join("");
        lines.push(selected ? fg(this.theme, "accent", text) : text);
        absoluteIndex += 1;
      }
      if (group === "done" && hiddenDone > 0) lines.push(fg(this.theme, "dim", `  +${hiddenDone} more done`));
      lines.push("");
    }

    if (this.showPeek) lines.push(...this.renderPeek(safeWidth));
    lines.push(this.renderFooter());
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  private visibleRows(): SubagentViewRow[] {
    let doneCount = 0;
    return sortSubagentRows(this.rows).filter((row) => {
      if (row.group !== "done") return true;
      doneCount += 1;
      return doneCount <= DONE_ROW_LIMIT;
    });
  }

  private selectedRow(): SubagentViewRow | undefined {
    return this.visibleRows()[this.selected];
  }

  private stopOrConfirm(row: SubagentViewRow) {
    if (row.group === "running" || row.group === "needsInput") {
      this.confirmStopFor = row.id;
      return;
    }
    this.done({ type: "stop", id: row.id });
  }

  private renderFooter(): string {
    const row = this.selectedRow();
    if (this.confirmStopFor && row) {
      return fg(this.theme, "warning", `${row.name} is ${row.stateLabel}. Stop it and nested children? y confirm · n cancel`);
    }
    const reply = row?.canReply ? "r reply" : fg(this.theme, "dim", "r reply");
    const stop = row?.canStop ? "s stop" : fg(this.theme, "dim", "s stop");
    return fg(this.theme, "dim", `↑↓ select • p peek • ${reply} • ${stop} • a attach • enter result/attach • R refresh • esc close`);
  }

  private renderPeek(width: number): string[] {
    const row = this.selectedRow();
    if (!row) return [];
    const task = cleanPeekText(row.status.job.taskPreview);
    const question = cleanPeekText(row.status.heartbeat?.attention?.message);
    const error = cleanPeekText(row.status.job.error);
    const lead = question && row.group === "needsInput" ? `  question: ${question}` : error && row.group === "error" ? `  error: ${error}` : row.activity !== task && row.activity !== "—" ? `  status: ${cleanPeekText(row.activity)}` : undefined;
    const lines = [
      fg(this.theme, "borderMuted", "─".repeat(width)),
      `${fg(this.theme, "accent", "Peek:")} ${row.name} (${row.agentName}) · ${row.stateLabel} · ${row.age}${row.usage ? ` · ${row.usage}` : ""}`,
      lead,
      task ? `  task: ${task}` : undefined,
      row.parentId ? `  parent: ${row.parentId.slice(0, 12)}` : undefined,
      `  result: ${row.resultFile ?? "—"}`,
    ].filter((line): line is string => Boolean(line));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

export function createSubagentsView(rows: SubagentViewRow[], theme: Theme, done: Done): SubagentsViewComponent {
  return new SubagentsViewComponent(sortSubagentRows(rows), theme, done);
}
