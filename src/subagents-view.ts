import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GROUP_LABELS, groupCountSummary, groupSubagentRows, sortSubagentRows, type SubagentViewRow } from "./view-model.js";

export type SubagentsViewAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "peek"; id: string }
  | { type: "reply"; id: string }
  | { type: "stop"; id: string }
  | { type: "attach"; id: string }
  | { type: "result"; id: string };

type Theme = { fg?: (token: string, text: string) => string; bold?: (text: string) => string };

type Done = (action: SubagentsViewAction | undefined) => void;

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

function lineToWidth(parts: string[], width: number): string {
  return truncateToWidth(parts.join(""), width);
}

export class SubagentsViewComponent {
  private selected = 0;
  private showPeek = true;

  constructor(private rows: SubagentViewRow[], private theme: Theme, private done: Done) {}

  invalidate() {}

  handleInput(data: string) {
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, this.rows.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.escape) || data === "\u0003") this.done({ type: "close" });
    else if (matchesKey(data, Key.enter) && this.selectedRow()) this.selectedRow()!.resultFile ? this.done({ type: "result", id: this.selectedRow()!.id }) : this.done({ type: "attach", id: this.selectedRow()!.id });
    else if (data === "R") this.done({ type: "refresh" });
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const counts = groupCountSummary(this.rows) || "no jobs";
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

    const grouped = groupSubagentRows(this.rows);
    let absoluteIndex = 0;
    for (const [group, groupRows] of grouped) {
      lines.push(fg(this.theme, "muted", GROUP_LABELS[group]));
      for (const row of groupRows) {
        const selected = absoluteIndex === this.selected;
        const marker = selected ? ">" : " ";
        const glyphToken = row.group === "needsInput" || row.group === "running" ? "warning" : row.group === "error" ? "error" : row.group === "idle" ? "success" : "muted";
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
          padOrTruncate(row.activity, activityWidth),
          padOrTruncate(row.age, ageWidth),
        ].join("");
        lines.push(selected ? fg(this.theme, "accent", text) : text);
        absoluteIndex += 1;
      }
      lines.push("");
    }

    if (this.showPeek) lines.push(...this.renderPeek(safeWidth));
    lines.push(fg(this.theme, "dim", "↑↓ select • enter result/attach • R refresh • esc close • actions: /subagents reply|stop|attach <id>"));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  private selectedRow(): SubagentViewRow | undefined {
    return sortSubagentRows(this.rows)[this.selected];
  }

  private renderPeek(width: number): string[] {
    const row = this.selectedRow();
    if (!row) return [];
    const lines = [
      fg(this.theme, "borderMuted", "─".repeat(Math.min(width, 80))),
      `${fg(this.theme, "accent", "Peek:")} ${row.name} (${row.agentName}) · ${row.stateLabel} · ${row.age}${row.usage ? ` · ${row.usage}` : ""}`,
      `  task: ${row.status.job.taskPreview}`,
      row.parentId ? `  parent: ${row.parentId.slice(0, 12)}` : undefined,
      `  result: ${row.resultFile ?? "—"}`,
      `  attach: ${row.attachCommand}`,
    ].filter((line): line is string => Boolean(line));
    return lines.map((line) => truncateToWidth(line, width));
  }
}

export function createSubagentsView(rows: SubagentViewRow[], theme: Theme, done: Done): SubagentsViewComponent {
  return new SubagentsViewComponent(sortSubagentRows(rows), theme, done);
}
