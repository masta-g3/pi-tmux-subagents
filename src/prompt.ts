import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { agentSystemPath, taskPath } from "./paths.js";
import type { AgentConfig, AgentTools, ThinkingLevel, TmuxSubagentJob } from "./types.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const CHILD_BOUNDARY = `You are a child subagent launched from a parent Pi session.
The parent owns orchestration, scope decisions, and follow-up work.
Complete only the assigned task using the tools available to you.
Do not spawn subagents unless explicitly allowed.
If blocked on an unapproved product, architecture, or scope decision, write the blocker clearly and stop.
Write your final answer to the requested result path when one is provided.`;

export interface PromptFiles {
  agentSystemPath: string;
  taskPath: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: ThinkingLevel | undefined): string | undefined {
  if (!model || !thinking || thinking === "off") return model;
  const colonIndex = model.lastIndexOf(":");
  if (colonIndex !== -1 && THINKING_LEVELS.has(model.slice(colonIndex + 1))) return model;
  return `${model}:${thinking}`;
}

function taskContract(job: TmuxSubagentJob, task: string): string {
  const nested = job.allowNestedSubagents
    ? `\nNested subagents:\n- You may launch nested subagents only when the parent prompt or active skill explicitly asks for a specialist subagent.\n- Allowed nested agents: ${(job.nestedAgentAllowlist?.length ? job.nestedAgentAllowlist.join(", ") : "none")}.\n- Nested subagents must not orchestrate tickets/workflows, stage, commit, merge, push, or modify files unless explicitly allowed.\n- Report nested agent used/skipped, job ID/result path, and feedback accepted/rejected.\n`
    : "";
  return `Task: ${task}

Context:
- Parent session id: ${job.parentId ?? "unknown"}
- Child session id: ${job.id}
- Agent: ${job.agentName}
- Dashboard label: ${job.displayName ?? job.agentName}
- Result path: ${job.resultPath}
${nested}
Output:
- Direct answer or implementation summary.
- Files changed, if any.
- Validation run, if any.
- Blockers or risks.

Before finishing, write your final response to:
${job.resultPath}

This result file is subagent control-plane output, not a project file change.
`;
}

export async function writePromptFiles(root: string, job: TmuxSubagentJob, agent: AgentConfig, task: string): Promise<PromptFiles> {
  const systemPath = agentSystemPath(root, job.id);
  const taskFile = taskPath(root, job.id);
  const nestedInstruction = job.allowNestedSubagents
    ? `\nNested subagent launches are allowed only for explicitly requested specialist review/delegation, and only for: ${(job.nestedAgentAllowlist?.length ? job.nestedAgentAllowlist.join(", ") : "none")}. The parent remains the top-level orchestrator.\n`
    : "";
  await mkdir(dirname(systemPath), { recursive: true });
  await writeFile(systemPath, `${CHILD_BOUNDARY}\n\n${agent.systemPrompt.trim()}${nestedInstruction}\n`, "utf8");
  await writeFile(taskFile, taskContract(job, task), "utf8");
  return { agentSystemPath: systemPath, taskPath: taskFile };
}

function addToolArgs(args: string[], tools: AgentTools | undefined): void {
  if (!tools || tools === "all" || tools === "builtins") return;
  if (tools === "none") {
    args.push("--no-tools");
    return;
  }
  if (tools.length) args.push("--tools", tools.join(","));
}

function withNestedTool(agent: AgentConfig, allowNestedSubagents: boolean | undefined): AgentConfig {
  if (!allowNestedSubagents) return agent;
  if (agent.tools === "none") return { ...agent, tools: ["tmux_subagent"] };
  if (!Array.isArray(agent.tools) || agent.tools.includes("tmux_subagent")) return agent;
  return { ...agent, tools: [...agent.tools, "tmux_subagent"] };
}

export function buildPiArgs(input: {
  agent: AgentConfig;
  taskPath: string;
  agentSystemPath: string;
  childBootstrapPath: string;
  allowNestedSubagents?: boolean;
}): string[] {
  const agent = withNestedTool(input.agent, input.allowNestedSubagents);
  const args: string[] = [];
  const model = applyThinkingSuffix(agent.model, agent.thinking);
  if (model) args.push("--model", model);
  addToolArgs(args, agent.tools);
  if (!agent.inheritProjectContext) args.push("--no-context-files");
  if (!agent.inheritSkills) args.push("--no-skills");
  args.push("--approve");
  args.push("--extension", input.childBootstrapPath);
  args.push(agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", input.agentSystemPath);
  args.push(`@${input.taskPath}`);
  return args;
}

export function taskPreview(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
