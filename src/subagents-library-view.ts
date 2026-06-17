import { basename } from "node:path";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./types.js";

export type SubagentsLibraryAction = { type: "close" };

type Theme = { fg?: (token: string, text: string) => string; bold?: (text: string) => string };
type Done = (action: SubagentsLibraryAction | undefined) => void;

function fg(theme: Theme, token: string, text: string): string {
  return theme.fg ? theme.fg(token, text) : text;
}

function bold(theme: Theme, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

function toolsLabel(agent: AgentConfig): string {
  if (Array.isArray(agent.tools)) return agent.tools.join(", ") || "none";
  return agent.tools ?? "all";
}

function compact(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export class SubagentsLibraryViewComponent {
  private selected = 0;
  private showDetails = true;

  constructor(private agents: AgentConfig[], private theme: Theme, private done: Done) {}

  invalidate() {}

  handleInput(data: string) {
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, this.agents.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.escape) || data === "\u0003") this.done({ type: "close" });
    else if (data === " ") this.showDetails = !this.showDetails;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines = [truncateToWidth(`${fg(this.theme, "accent", bold(this.theme, "subagents library"))} ${fg(this.theme, "muted", `· ${this.agents.length} agents`)}`, safeWidth), ""];
    if (!this.agents.length) {
      lines.push(fg(this.theme, "muted", "No agents found."));
      lines.push("");
      lines.push(fg(this.theme, "dim", "esc close"));
      return lines.map((line) => truncateToWidth(line, safeWidth));
    }

    this.agents.forEach((agent, index) => {
      const selected = index === this.selected;
      const row = `${selected ? ">" : " "} ${agent.name.padEnd(20)} ${agent.source.padEnd(7)} ${compact(agent.description, Math.max(20, safeWidth - 34))}`;
      lines.push(selected ? fg(this.theme, "accent", row) : truncateToWidth(row, safeWidth));
    });

    if (this.showDetails) {
      const agent = this.agents[this.selected]!;
      lines.push("", fg(this.theme, "borderMuted", "─".repeat(Math.min(80, safeWidth))));
      lines.push(`${fg(this.theme, "accent", agent.name)} (${agent.source})`);
      lines.push(`  description: ${agent.description}`);
      lines.push(`  tools: ${toolsLabel(agent)}`);
      if (agent.model) lines.push(`  model: ${agent.model}`);
      if (agent.thinking) lines.push(`  thinking: ${agent.thinking}`);
      lines.push(`  file: ${basename(agent.filePath)} (${agent.filePath})`);
      lines.push(`  prompt: ${compact(agent.systemPrompt, 220)}`);
    }
    lines.push("", fg(this.theme, "dim", "↑↓ select • space details • esc close"));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }
}

export function createSubagentsLibraryView(agents: AgentConfig[], theme: Theme, done: Done): SubagentsLibraryViewComponent {
  return new SubagentsLibraryViewComponent([...agents].sort((a, b) => a.name.localeCompare(b.name)), theme, done);
}

export function formatAgentLibraryList(agents: AgentConfig[]): string {
  return agents.length ? agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n") : "No agents found.";
}
