import { Text } from "@earendil-works/pi-tui";
import { formatUserStatus, formatUserStatusList } from "./format.js";
import type { SubagentStatusResult, TmuxSubagentStatus } from "./types.js";

type ThemeLike = {
  bold(text: string): string;
  fg(token: string, text: string): string;
};

const STATUS_COLOR: Record<TmuxSubagentStatus, string> = {
  starting: "warning",
  running: "warning",
  waiting: "success",
  stopped: "muted",
  error: "error",
};

export function renderToolCall(args: { action?: string; agent?: string }, theme: ThemeLike): Text {
  const detail = args.action ?? (args.agent ? `launch ${args.agent}` : undefined);
  const line = [theme.fg("toolTitle", theme.bold("tmux_subagent")), detail ? theme.fg("muted", detail) : undefined].filter(Boolean).join(" ");
  return new Text(line, 0, 0);
}

export function renderToolResult(result: { content?: Array<{ type?: string; text?: string }>; details?: unknown }, _options: unknown, theme: ThemeLike): Text {
  if (isStatusResult(result.details)) return renderStatus(result.details, theme);
  if (isStatusListResult(result.details)) return renderStatusList(result.details.statuses, result.details.hiddenStopped ?? 0, theme);
  return new Text(result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "", 0, 0);
}

export function renderStatus(status: SubagentStatusResult, theme: ThemeLike): Text {
  const color = STATUS_COLOR[status.status];
  const lines = formatUserStatus(status).split("\n").map((line, index) => colorStatusLine(line, index, status, color, theme));
  return new Text(lines.join("\n"), 0, 0);
}

function isStatusResult(value: unknown): value is SubagentStatusResult {
  return typeof value === "object" && value !== null && "job" in value && "status" in value;
}

function isStatusListResult(value: unknown): value is { statuses: SubagentStatusResult[]; hiddenStopped?: number } {
  return typeof value === "object" && value !== null && Array.isArray((value as { statuses?: unknown }).statuses);
}

function renderStatusList(statuses: SubagentStatusResult[], hiddenStopped: number, theme: ThemeLike): Text {
  const lines = formatUserStatusList(statuses, hiddenStopped).split("\n").map((line, index) => {
    if (index === 0 || index === 1) return theme.fg("muted", line);
    return colorStatusListLine(line, theme);
  });
  return new Text(lines.join("\n"), 0, 0);
}

function colorStatusListLine(line: string, theme: ThemeLike): string {
  return line.replace(/^ (\S+) (.+?)\s{2,}(\S+)\s{2,}(.+)$/, (_match, glyph: string, name: string, state: string, rest: string) => {
    const color = STATUS_COLOR[state as keyof typeof STATUS_COLOR] ?? (state === "idle" || state === "done" ? "success" : "muted");
    return ` ${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)}  ${theme.fg(color, state)}  ${theme.fg("muted", rest)}`;
  });
}

function colorStatusLine(line: string, index: number, status: SubagentStatusResult, color: string, theme: ThemeLike): string {
  if (index === 0) return theme.fg("muted", line);
  if (index === 1) return line.replace(/^ (\S+) (.+)$/, (_match, glyph: string, rest: string) => ` ${theme.fg(color, glyph)} ${theme.fg("muted", rest)}`);
  if (line.startsWith("   ✓")) return line.replace("✓", theme.fg("success", "✓")).replace(/→ (.+)$/, (_match, file: string) => `→ ${theme.fg("mdCode", file)}`);
  if (line.startsWith("   inspect result")) return line.replace(/→ (.+)$/, (_match, file: string) => `→ ${theme.fg("mdCode", file)}`);
  if (line.startsWith("   error:")) return colorMetadataLine(line, theme);
  if (line.startsWith("   ⎿")) return line.replace("⎿", theme.fg("muted", "⎿")).replace(/(Done|Ready|Running|Starting|Stopped|Error)$/, (text) => theme.fg(color, text));
  if (line.trim() === "Task:" || line.trim() === "Pane preview:") return `      ${theme.fg("muted", line.trim())}`;
  if (line.startsWith("      ")) return `      ${theme.fg("toolOutput", line.slice(6))}`;
  if (line.startsWith("   ")) return colorMetadataLine(line, theme);
  return line;
}

function colorMetadataLine(line: string, theme: ThemeLike): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  const colon = trimmed.indexOf(":");
  if (colon === -1) return theme.fg("muted", line);

  const label = trimmed.slice(0, colon + 1);
  const value = trimmed.slice(colon + 1).trimStart();
  const separator = trimmed.slice(colon + 1, colon + 1 + trimmed.slice(colon + 1).length - value.length);
  const valueToken = label === "output:" || label === "attach:" ? "mdCode" : "muted";

  return `${indent}${theme.fg("dim", label)}${separator}${theme.fg(valueToken, value)}`;
}
