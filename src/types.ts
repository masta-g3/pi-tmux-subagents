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

export interface TmuxSubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TmuxSubagentJob {
  id: string;
  /** New jobs use persisted-session lifetime accounting. Absence preserves legacy latest-run semantics. */
  accountingVersion?: 1;
  executionId?: string;
  launchPending?: boolean;
  sessionFile?: string;
  sessionId?: string;
  /** Exact provider/model pair selected by Pi, for example `anthropic/claude-sonnet-4`. */
  resolvedModel?: string;
  resolvedThinking?: ThinkingLevel;
  depth?: number;
  hubDir?: string;
  agentName: string;
  displayName?: string;
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
  idleTimeoutMs?: number;
  autoStopped?: boolean;
  allowNestedSubagents?: boolean;
  nestedAgentAllowlist?: string[];
  maxNestedDepth?: number;
}

export interface TmuxSubagentsRegistry {
  version: 1;
  jobs: TmuxSubagentJob[];
}

export interface TmuxSubagentAttention {
  kind: "question" | "permission" | "blocked";
  message: string;
  updatedAt: number;
  toolCallId?: string;
}

export interface TmuxSubagentHeartbeat {
  jobId: string;
  executionId?: string;
  cwd: string;
  state: "starting" | "running" | "waiting" | "error" | "shutdown";
  stateSince: number;
  message?: string;
  updatedAt: number;
  seenRunning?: boolean;
  idleSince?: number;
  /** Latest logical run. Legacy readers continue to use this field. */
  usage?: TmuxSubagentUsage;
  /** All persisted usage in the exact Pi session. */
  lifetimeUsage?: TmuxSubagentUsage;
  /** Persisted lifetime total at the start of the active/latest logical run. */
  runUsageBaseline?: TmuxSubagentUsage;
  /** True while retries/continuations still belong to one logical user run. */
  runActive?: boolean;
  attention?: TmuxSubagentAttention;
}

export interface TmuxSubagentTurn {
  index: number;
  executionId?: string;
  status: "running" | "waiting" | "error";
  startedAt: number;
  completedAt?: number;
  resultPath: string;
  messagePreview?: string;
  usage?: TmuxSubagentUsage;
  lifetimeUsage?: TmuxSubagentUsage;
}

export interface TmuxSubagentTurnsRegistry {
  version: 1;
  turns: TmuxSubagentTurn[];
}

export interface SubagentStatusResult {
  job: TmuxSubagentJob;
  status: TmuxSubagentStatus;
  heartbeat?: TmuxSubagentHeartbeat;
  result?: string;
  /** Confirmed result availability without hydrating the result body. */
  resultPath?: string;
  latestResult?: string;
  latestTurn?: TmuxSubagentTurn;
  preview?: string;
  autoStopped?: boolean;
  usage?: TmuxSubagentUsage;
  usageScope?: "lifetime" | "latest-run";
}
