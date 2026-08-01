import { basename } from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SUBAGENT_UI } from "./ui-tokens.js";
import { GROUP_LABELS, compactGroupCountSummary, groupCountSummary, groupSubagentRows, sortSubagentRows, type SubagentViewRow } from "./view-model.js";

export type SubagentsViewAction =
  | { type: "close" }
  | { type: "reply"; id: string }
  | { type: "stop"; id: string; confirmed?: boolean }
  | { type: "attach"; id: string }
  | { type: "result"; id: string };

export interface SubagentsViewHooks {
  requestRender(): void;
  refreshNow(): Promise<void>;
  finish(action: SubagentsViewAction | undefined): void;
}

export interface SubagentsViewOptions {
  selectedId?: string;
}

type Theme = {
  fg?: (token: string, text: string) => string;
  bg?: (token: string, text: string) => string;
  bold?: (text: string) => string;
};

function fg(theme: Theme, token: string, text: string): string {
  return theme.fg ? theme.fg(token, text) : text;
}

function bg(theme: Theme, token: string, text: string): string {
  return theme.bg ? theme.bg(token, text) : text;
}

function bold(theme: Theme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function pad(text: string, width: number): string {
  const value = truncateToWidth(text, Math.max(0, width));
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function lineToWidth(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width));
}

function rowToken(row: SubagentViewRow): string | undefined {
  if (row.group === "needsInput") return SUBAGENT_UI.theme.attention;
  if (row.group === "error") return SUBAGENT_UI.theme.error;
  return undefined;
}

function cleanText(text: string | undefined, max = 240): string | undefined {
  const withoutAnsi = text?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const withoutControls = withoutAnsi?.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const withoutPaths = withoutControls?.replace(/(?:~|\/[^\s:;,.)\]}]+(?:\/[^\s:;,.)\]}]+)*)/g, (match) => basename(match));
  const compact = withoutPaths?.replace(/[ \t]+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function resultText(row: SubagentViewRow): string | undefined {
  return row.status.latestResult ?? row.status.result;
}

function resultExcerpt(row: SubagentViewRow, width: number): { lines: string[]; omitted: boolean } {
  const raw = resultText(row)?.replace(/\r\n?/g, "\n");
  if (!raw) return { lines: ["No result text captured."], omitted: false };
  const cleaned = cleanText(raw, SUBAGENT_UI.resultExcerptChars);
  if (!cleaned) return { lines: ["No result text captured."], omitted: false };
  const sourceOmitted = raw.length > SUBAGENT_UI.resultExcerptChars;
  const wrapped = cleaned.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(8, width)));
  const omitted = sourceOmitted || wrapped.length > SUBAGENT_UI.resultExcerptLines;
  if (!omitted) return { lines: wrapped, omitted: false };
  return {
    lines: [...wrapped.slice(0, Math.max(1, SUBAGENT_UI.resultExcerptLines - 1)), "…"],
    omitted: true,
  };
}

function groupToken(group: SubagentViewRow["group"]): string {
  if (group === "needsInput") return SUBAGENT_UI.theme.attention;
  if (group === "error") return SUBAGENT_UI.theme.error;
  return SUBAGENT_UI.theme.secondary;
}

export class SubagentsViewComponent {
  private rows: SubagentViewRow[];
  private selected = 0;
  private expandedFor: { id: string; kind: "details" | "result" } | undefined;
  private confirmStopFor: string | undefined;
  private refreshing = false;
  private refreshError: string | undefined;

  constructor(rows: SubagentViewRow[], private theme: Theme, private hooks: SubagentsViewHooks, options: SubagentsViewOptions = {}) {
    this.rows = sortSubagentRows(rows);
    if (options.selectedId) {
      const index = this.visibleRows().findIndex((row) => row.id === options.selectedId);
      if (index >= 0) this.selected = index;
    }
  }

  invalidate() {}

  updateRows(nextRows: SubagentViewRow[]) {
    const previousRows = this.visibleRows();
    const previous = previousRows[this.selected];
    const previousIndex = this.selected;
    this.rows = sortSubagentRows(nextRows);
    const visible = this.visibleRows();
    const sameId = previous ? visible.findIndex((row) => row.id === previous.id) : -1;
    if (sameId >= 0) this.selected = sameId;
    else if (previous) {
      const sameGroup = visible.map((row, index) => ({ row, index })).filter(({ row }) => row.group === previous.group);
      this.selected = sameGroup.length
        ? sameGroup.reduce((best, item) => Math.abs(item.index - previousIndex) < Math.abs(best.index - previousIndex) ? item : best).index
        : Math.min(previousIndex, Math.max(0, visible.length - 1));
    } else this.selected = 0;
    if (this.expandedFor && !visible.some((row) => row.id === this.expandedFor!.id)) this.expandedFor = undefined;
    this.hooks.requestRender();
  }

  handleInput(data: string) {
    const row = this.selectedRow();
    if (this.confirmStopFor) {
      if (data.toLowerCase() === "y") this.hooks.finish({ type: "stop", id: this.confirmStopFor, confirmed: true });
      else if (data.toLowerCase() === "n" || matchesKey(data, Key.escape) || data === "\u0003") {
        this.confirmStopFor = undefined;
        this.hooks.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.expandedFor = undefined;
      this.hooks.requestRender();
    } else if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, this.visibleRows().length - 1), this.selected + 1);
      this.expandedFor = undefined;
      this.hooks.requestRender();
    } else if (matchesKey(data, Key.escape) || data === "\u0003") this.hooks.finish({ type: "close" });
    else if (matchesKey(data, Key.enter) && row) this.primaryAction(row);
    else if (data === "r" && row?.canReply) this.hooks.finish({ type: "reply", id: row.id });
    else if (data === "a" && row?.canAttach) this.hooks.finish({ type: "attach", id: row.id });
    else if (data === "o" && row?.resultFile) this.hooks.finish({ type: "result", id: row.id });
    else if (data === "s" && row?.canStop) this.stopOrConfirm(row);
    else if (data === "R") void this.refresh();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const counts = groupCountSummary(this.rows) || "no jobs";
    const totalCost = this.totalCost();
    const headerLines = safeWidth < SUBAGENT_UI.wideViewMin
      ? [
          fg(this.theme, SUBAGENT_UI.theme.primary, bold(this.theme, "Subagents")),
          fg(this.theme, SUBAGENT_UI.theme.secondary, [compactGroupCountSummary(this.rows), totalCost].filter(Boolean).join(" · ")),
        ]
      : [fg(this.theme, SUBAGENT_UI.theme.primary, bold(this.theme, ["Subagents", counts, totalCost].filter(Boolean).join(" · ")))];
    const lines = [
      ...headerLines,
      fg(this.theme, SUBAGENT_UI.theme.divider, "─".repeat(safeWidth)),
      "",
    ];

    if (!this.rows.length) {
      lines.push(fg(this.theme, SUBAGENT_UI.theme.secondary, "No tmux subagent jobs."));
      lines.push("", fg(this.theme, SUBAGENT_UI.theme.tertiary, "esc close"));
      return lines.map((line) => lineToWidth(line, safeWidth));
    }

    const visibleRows = this.visibleRows();
    const grouped = groupSubagentRows(visibleRows);
    const hiddenDone = this.rows.filter((row) => row.group === "done").length - visibleRows.filter((row) => row.group === "done").length;
    let absoluteIndex = 0;
    for (const [group, groupRows] of grouped) {
      lines.push(fg(this.theme, groupToken(group), `${GROUP_LABELS[group]}  ${groupRows.length}`));
      for (const row of groupRows) {
        lines.push(this.renderRow(row, absoluteIndex === this.selected, safeWidth));
        absoluteIndex += 1;
      }
      if (group === "done" && hiddenDone > 0) lines.push(fg(this.theme, SUBAGENT_UI.theme.tertiary, `  +${hiddenDone} more done`));
      lines.push("");
    }

    lines.push(...this.renderSelectedDetail(safeWidth));
    lines.push(...this.renderFooter(safeWidth));
    return lines.map((line) => lineToWidth(line, safeWidth));
  }

  private visibleRows(): SubagentViewRow[] {
    let doneCount = 0;
    return sortSubagentRows(this.rows).filter((row) => {
      if (row.group !== "done") return true;
      doneCount += 1;
      return doneCount <= SUBAGENT_UI.doneRowLimit;
    });
  }

  private selectedRow(): SubagentViewRow | undefined {
    return this.visibleRows()[this.selected];
  }

  private primaryAction(row: SubagentViewRow) {
    if (row.primaryAction === "reply") {
      this.hooks.finish({ type: "reply", id: row.id });
      return;
    }
    const kind = row.primaryAction === "result" ? "result" : "details";
    this.expandedFor = this.expandedFor?.id === row.id && this.expandedFor.kind === kind ? undefined : { id: row.id, kind };
    this.hooks.requestRender();
  }

  private stopOrConfirm(row: SubagentViewRow) {
    if (row.group === "running" || row.group === "needsInput") {
      this.confirmStopFor = row.id;
      this.hooks.requestRender();
      return;
    }
    this.hooks.finish({ type: "stop", id: row.id });
  }

  private async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshError = undefined;
    this.hooks.requestRender();
    try {
      await this.hooks.refreshNow();
    } catch (error) {
      this.refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshing = false;
      this.hooks.requestRender();
    }
  }

  private renderRow(row: SubagentViewRow, selected: boolean, width: number): string {
    const marker = selected ? ">" : " ";
    const glyph = row.group === "done" ? "·" : row.glyph;
    const token = rowToken(row);
    const styledGlyph = token ? fg(this.theme, token, glyph) : glyph;
    const ageWidth = Math.max(2, row.age.length);
    let line: string;
    if (width >= SUBAGENT_UI.wideViewMin) {
      const nameWidth = Math.min(SUBAGENT_UI.nameMax, Math.max(SUBAGENT_UI.nameMin, Math.floor(width * 0.22)));
      const fixed = 4 + nameWidth + 2 + ageWidth;
      const activityWidth = Math.max(8, width - fixed);
      const activity = pad(row.activity, activityWidth);
      const styledActivity = token ? fg(this.theme, token, activity) : activity;
      line = `${marker} ${styledGlyph} ${pad(row.name, nameWidth)}  ${styledActivity}${pad(row.age, ageWidth)}`;
    } else {
      const nameWidth = Math.max(4, width - 4 - ageWidth);
      line = `${marker} ${styledGlyph} ${pad(row.name, nameWidth)}${pad(row.age, ageWidth)}`;
    }
    const fitted = pad(lineToWidth(line, width), width);
    return selected ? bg(this.theme, SUBAGENT_UI.theme.selectionBg, fitted) : fitted;
  }

  private renderSelectedDetail(width: number): string[] {
    const row = this.selectedRow();
    if (!row) return [];
    const header = [row.name, row.stateLabel, row.age, row.usage].filter(Boolean).join(" · ");
    const lines = [
      fg(this.theme, SUBAGENT_UI.theme.divider, "─".repeat(width)),
      fg(this.theme, SUBAGENT_UI.theme.primary, bold(this.theme, header)),
      rowToken(row) ? fg(this.theme, rowToken(row)!, row.detail) : row.detail,
    ];
    const expanded = this.expandedFor?.id === row.id ? this.expandedFor.kind : undefined;
    if (expanded === "result") {
      const excerpt = resultExcerpt(row, Math.max(8, width - 2));
      lines.push(fg(this.theme, SUBAGENT_UI.theme.secondary, `result  ${row.resultFile ?? "result"}${excerpt.omitted ? " · excerpt" : ""}`));
      lines.push(...excerpt.lines.map((line) => `  ${line}`));
    } else if (expanded === "details") {
      const task = cleanText(row.status.job.taskPreview);
      if (task) lines.push(`task  ${task}`);
      if (row.resultFile) lines.push(`result  ${row.resultFile}`);
      if (row.parentId) lines.push(`parent  ${row.parentId.slice(0, 12)}`);
    }
    lines.push("");
    return lines;
  }

  private renderFooter(width: number): string[] {
    const row = this.selectedRow();
    if (this.confirmStopFor && row) {
      const prompt = `${row.name} is ${row.stateLabel}. Stop it and nested children?`;
      const lines = width < 40 ? [prompt, "y confirm · n cancel"] : [`${prompt} y confirm · n cancel`];
      return lines.map((line) => fg(this.theme, SUBAGENT_UI.theme.attention, line));
    }
    if (!row) return [fg(this.theme, SUBAGENT_UI.theme.tertiary, "esc close")];
    const expanded = this.expandedFor?.id === row.id ? this.expandedFor.kind : undefined;
    const primary = row.primaryAction === "reply"
      ? "enter reply"
      : row.primaryAction === "result"
        ? `enter ${expanded === "result" ? "hide" : "show"} result`
        : `enter ${expanded === "details" ? "hide" : "show"} details`;
    const stop = row.canStop ? "s stop" : undefined;
    const error = this.refreshError ? `refresh failed: ${cleanText(this.refreshError, 60)}` : undefined;
    const parts = width >= SUBAGENT_UI.wideViewMin
      ? [error, primary, row.resultFile ? "o result path" : undefined, stop, row.canAttach ? "a attach" : undefined, this.refreshing ? "refreshing" : "R refresh", "esc close"]
      : [error, primary, stop, "esc close"];
    if (width >= 40) return [fg(this.theme, SUBAGENT_UI.theme.tertiary, parts.filter(Boolean).join(" · "))];
    return [
      ...[error, primary].filter((part): part is string => Boolean(part)),
      [stop, "esc close"].filter(Boolean).join(" · "),
    ].map((line) => fg(this.theme, SUBAGENT_UI.theme.tertiary, line));
  }

  private totalCost(): string | undefined {
    const costs = this.rows.map((row) => row.cost).filter((cost): cost is number => cost !== undefined);
    if (!costs.length) return undefined;
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    if (total === 0) return "$0";
    if (total < 0.01) return `$${total.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
    return `$${total.toFixed(2)}`;
  }
}

export function createSubagentsView(rows: SubagentViewRow[], theme: Theme, hooks: SubagentsViewHooks, options: SubagentsViewOptions = {}): SubagentsViewComponent {
  return new SubagentsViewComponent(rows, theme, hooks, options);
}
