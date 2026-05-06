import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectAgentsDir, userAgentsDir } from "./paths.js";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentSource, AgentTools, SystemPromptMode, ThinkingLevel } from "./types.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + "\n---".length).trim();
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    data[key] = value;
  }
  return { data, body };
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseTools(value: string | undefined): AgentTools | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "builtins" || normalized === "none") return normalized;
  const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
  return tools.length ? tools : undefined;
}

function parsePromptMode(value: string | undefined): SystemPromptMode {
  return value === "append" ? "append" : "replace";
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  return value && THINKING_LEVELS.has(value) ? value as ThinkingLevel : undefined;
}

export function parseAgentMarkdown(content: string, filePath: string, source: AgentSource): AgentConfig | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const name = parsed.data.name?.trim();
  const description = parsed.data.description?.trim();
  if (!name || !description) return null;
  if (boolValue(parsed.data.disabled, false)) return null;

  return {
    name,
    description,
    systemPrompt: parsed.body,
    source,
    filePath,
    model: parsed.data.model?.trim() || undefined,
    thinking: parseThinking(parsed.data.thinking),
    tools: parseTools(parsed.data.tools),
    systemPromptMode: parsePromptMode(parsed.data.systemPromptMode),
    inheritProjectContext: boolValue(parsed.data.inheritProjectContext, true),
    inheritSkills: boolValue(parsed.data.inheritSkills, false),
    maxDepth: Number.parseInt(parsed.data.maxDepth ?? "0", 10) || 0,
  };
}

function builtinAgentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!existsSync(dir)) return [];
  const agents: AgentConfig[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(dir, entry.name);
    const agent = parseAgentMarkdown(readFileSync(filePath, "utf8"), filePath, source);
    if (agent) agents.push(agent);
  }
  return agents;
}

export function discoverAgents(cwd: string, scope: AgentScope = "user"): AgentDiscoveryResult {
  const projectAgentsDir = findProjectAgentsDir(cwd);
  const builtinAgents = loadAgentsFromDir(builtinAgentsDir(), "builtin");
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir(), "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
  const byName = new Map<string, AgentConfig>();

  for (const agent of builtinAgents) byName.set(agent.name, agent);
  if (scope === "both") {
    for (const agent of userAgents) byName.set(agent.name, agent);
    for (const agent of projectAgents) byName.set(agent.name, agent);
  } else {
    for (const agent of scope === "project" ? projectAgents : userAgents) byName.set(agent.name, agent);
  }

  return { agents: [...byName.values()], projectAgentsDir };
}

export function findAgent(cwd: string, name: string, scope: AgentScope = "user"): AgentConfig | undefined {
  return discoverAgents(cwd, scope).agents.find((agent) => agent.name === name);
}
