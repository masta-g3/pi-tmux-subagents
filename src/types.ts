export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project";
export type SystemPromptMode = "replace" | "append";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentTools = "all" | "builtins" | "none" | string[];

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: AgentTools;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  maxDepth: number;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export type TmuxSubagentStatus = "starting" | "running" | "waiting" | "stopped" | "error";

export interface TmuxSubagentJob {
  id: string;
  agentName: string;
  taskPreview: string;
  cwd: string;
  tmuxSession: string;
  status: TmuxSubagentStatus;
  parentId?: string;
  parentTmuxSession?: string;
  model?: string;
  resultPath: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  autoStopOnComplete?: boolean;
}

export interface TmuxSubagentsRegistry {
  version: 1;
  jobs: TmuxSubagentJob[];
}

export interface TmuxSubagentHeartbeat {
  jobId: string;
  cwd: string;
  state: "starting" | "running" | "waiting" | "error" | "shutdown";
  stateSince: number;
  message?: string;
  updatedAt: number;
  seenRunning?: boolean;
}

export interface SubagentStatusResult {
  job: TmuxSubagentJob;
  status: TmuxSubagentStatus;
  heartbeat?: TmuxSubagentHeartbeat;
  result?: string;
  preview?: string;
  autoStopped?: boolean;
  autoStopError?: string;
}
