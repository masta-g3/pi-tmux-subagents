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
  return `Task: ${task}

Context:
- Parent session id: ${job.parentId ?? "unknown"}
- Child session id: ${job.id}
- Agent: ${job.agentName}
- Result path: ${job.resultPath}

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
  await mkdir(dirname(systemPath), { recursive: true });
  await writeFile(systemPath, `${CHILD_BOUNDARY}\n\n${agent.systemPrompt.trim()}\n`, "utf8");
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

export function buildPiArgs(input: {
  agent: AgentConfig;
  taskPath: string;
  agentSystemPath: string;
  childBootstrapPath: string;
}): string[] {
  const args: string[] = [];
  const model = applyThinkingSuffix(input.agent.model, input.agent.thinking);
  if (model) args.push("--model", model);
  addToolArgs(args, input.agent.tools);
  if (!input.agent.inheritProjectContext) args.push("--no-context-files");
  if (!input.agent.inheritSkills) args.push("--no-skills");
  args.push("--extension", input.childBootstrapPath);
  args.push(input.agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", input.agentSystemPath);
  args.push(`@${input.taskPath}`);
  return args;
}

export function taskPreview(task: string): string {
  const compact = task.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}
