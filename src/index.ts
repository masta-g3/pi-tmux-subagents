import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, findAgent } from "./agents.js";
import { formatStatus } from "./format.js";
import { renderToolCall, renderToolResult } from "./render.js";
import { STATUS_KEY } from "./names.js";
import { stateRoot } from "./paths.js";
import { autoStopCompletedSubagent, cancelSubagent, cleanupCompletedSubagents, getSubagentStatus, launchSubagent, sendSubagentMessage, waitForAnySubagent, waitForSubagent, type CleanupCompletedResult } from "./run.js";
import { loadJobs } from "./state.js";
import type { AgentScope, SubagentStatusResult } from "./types.js";

type ToolParams = {
  action?: "list" | "get" | "status" | "cancel" | "stop" | "send" | "wait";
  agent?: string;
  task?: string;
  label?: string;
  message?: string;
  wait?: boolean;
  timeoutMs?: number;
  background?: boolean;
  childId?: string;
  id?: string;
  agentScope?: AgentScope;
  cwd?: string;
  autoStopOnComplete?: boolean;
  allowNestedSubagents?: boolean;
  nestedAgentAllowlist?: string[];
  maxNestedDepth?: number;
};

type PiContext = { cwd: string; ui?: { setStatus?: (key: string, text: string | undefined) => void } };

const activeJobs = new Map<string, { agentName: string; status: string }>();
let setStatus: ((text: string | undefined) => void) | undefined;

function refreshParentStatus() {
  const active = [...activeJobs.values()].filter((job) => !["waiting", "stopped", "error"].includes(job.status));
  setStatus?.(active.length ? `subagents: ${active.map((job) => `${job.agentName} ${job.status}`).join(" · ")}` : undefined);
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const label = value?.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "").replace(/-+/g, "-").slice(0, 48);
  return label || undefined;
}

function jobDisplayName(job: { agentName: string; displayName?: string }): string {
  return job.displayName ?? job.agentName;
}

const TmuxSubagentParams = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "status", "cancel", "stop", "send", "wait"], description: "Management action. Omit to launch an agent. stop is an alias for cancel." },
    agent: { type: "string", description: "Agent name for launch/get." },
    task: { type: "string", description: "Task for launch." },
    label: { type: "string", description: "Optional short dashboard label for launch; prefix with agent type, e.g. worker-auth or scout-api." },
    message: { type: "string", description: "Message to send for action=send." },
    wait: { type: "boolean", description: "For action=send, wait for the next completed turn before returning. Prefer false unless blocked. Default false." },
    timeoutMs: { type: "number", description: "Optional timeout for action=send with wait=true or action=wait; wait leaves children alive on timeout." },
    background: { type: "boolean", description: "Return immediately after spawning the tmux child. Default false." },
    childId: { type: "string", description: "Child job ID or unique prefix. For action=wait, omit to return when any active child completes." },
    id: { type: "string", description: "Alias for childId." },
    agentScope: { type: "string", enum: ["user", "project", "both"], description: "Agent discovery scope. Default user." },
    cwd: { type: "string", description: "Working directory for the child. Defaults to parent cwd." },
    autoStopOnComplete: { type: "boolean", default: true, description: "Stop the tmux session automatically after a clean completion. Default true; set false to keep sessions alive for follow-up. Failures and attention-needed sessions stay alive." },
    allowNestedSubagents: { type: "boolean", default: false, description: "Expose tmux_subagent inside the child for explicitly approved nested specialist agents. Default false." },
    nestedAgentAllowlist: { type: "array", items: { type: "string" }, description: "Agent names the child may launch when allowNestedSubagents is true." },
    maxNestedDepth: { type: "number", default: 2, description: "Maximum PI_SUBAGENT_DEPTH allowed for launched nested tmux_subagents. Default 2." }
  }
} as const;

function text(content: string, details?: unknown, isError?: boolean) {
  return { content: [{ type: "text" as const, text: content }], details, isError };
}

type ToolTextResult = ReturnType<typeof text>;

function cleanupNote(cleanup: CleanupCompletedResult): string | undefined {
  const notes = [
    cleanup.autoStopped.length ? `auto-stopped ${cleanup.autoStopped.length} completed child${cleanup.autoStopped.length === 1 ? "" : "ren"}` : undefined,
    cleanup.idlePersistent.length ? `${cleanup.idlePersistent.length} idle persistent child${cleanup.idlePersistent.length === 1 ? " needs" : "ren need"} stop when no longer needed` : undefined,
    cleanup.errors.length ? `${cleanup.errors.length} cleanup error${cleanup.errors.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  return notes.length ? `${notes.join("; ")}.` : undefined;
}

function withCleanupNote(result: ToolTextResult, cleanup: CleanupCompletedResult): ToolTextResult {
  const note = cleanupNote(cleanup);
  if (!note) return result;
  if (isStatusResult(result.details)) {
    const details = { ...result.details, hygieneNote: note };
    return text(formatStatus(details), details, result.isError);
  }
  return text(`${result.content[0]?.text ?? ""}\n\nSubagent cleanup: ${note}`, result.details, result.isError);
}

function isStatusResult(value: unknown): value is SubagentStatusResult {
  return typeof value === "object" && value !== null && "job" in value && "status" in value;
}

export function resolveAutoStopOnComplete(value: boolean | undefined): boolean {
  return value ?? true;
}

function nestedAllowlist(): string[] {
  return (process.env.PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST ?? "").split(",").map((agent) => agent.trim()).filter(Boolean);
}

function maxNestedDepth(): number {
  return Number.parseInt(process.env.PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH ?? "", 10) || 0;
}

function currentDepth(): number {
  return Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
}

function nestedSessionPolicy(): { depth: number; childId?: string; allowlist: string[] } {
  return { depth: currentDepth(), childId: process.env.PI_TMUX_SUBAGENTS_JOB_ID, allowlist: nestedAllowlist() };
}

function nestedDisabledMessage(): string {
  return "Nested tmux_subagent launches are not enabled in this child session.";
}

function nestedCanAccessJob(job: { parentId?: string }, childId: string | undefined): boolean {
  return Boolean(childId && job.parentId === childId);
}

export default function tmuxSubagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    setStatus = (ctx as PiContext).ui?.setStatus ? (text) => (ctx as PiContext).ui?.setStatus?.(STATUS_KEY, text) : undefined;
    refreshParentStatus();
  });
  pi.on("session_shutdown", async () => {
    setStatus?.(undefined);
    setStatus = undefined;
    activeJobs.clear();
  });

  pi.registerTool({
    name: "tmux_subagent",
    label: "tmux subagent",
    description: "Launch and manage Markdown-defined subagents as real tmux-backed Pi sessions. Prefer background launches plus useful parent-side work and later status checks over blocking waits; use wait only when the parent is truly blocked. Use label for parallel workers/scouts, prefixed by agent type (for example worker-auth).",
    parameters: TmuxSubagentParams,
    renderCall: renderToolCall,
    renderResult: renderToolResult,
    async execute(_toolCallId: string, params: ToolParams, signal?: AbortSignal, onUpdate?: (result: any) => void, ctx?: PiContext) {
      const cwd = params.cwd ?? ctx?.cwd ?? process.cwd();
      const scope = params.agentScope ?? "user";
      const root = stateRoot();
      const nestedPolicy = nestedSessionPolicy();
      const inNestedSession = nestedPolicy.depth > 0;
      const requestedId = params.childId ?? params.id;
      const cleanup = await cleanupCompletedSubagents(root, undefined, {
        jobFilter: (job) => {
          if (inNestedSession && !nestedCanAccessJob(job, nestedPolicy.childId)) return false;
          return requestedId ? !job.id.startsWith(requestedId) : true;
        },
      });
      const reply = (content: string, details?: unknown, isError?: boolean) => withCleanupNote(text(content, details, isError), cleanup);

      if (params.action === "list") {
        if (inNestedSession && !nestedPolicy.allowlist.length) return reply(nestedDisabledMessage(), undefined, true);
        const discovery = discoverAgents(cwd, scope);
        const agents = inNestedSession ? discovery.agents.filter((agent) => nestedPolicy.allowlist.includes(agent.name)) : discovery.agents;
        const lines = agents.length
          ? agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n")
          : "No agents found.";
        return reply(lines, { ...discovery, agents });
      }

      if (params.action === "get") {
        if (!params.agent) return reply("Missing agent for get action.", undefined, true);
        if (inNestedSession && !nestedPolicy.allowlist.includes(params.agent)) return reply(nestedPolicy.allowlist.length ? `Nested agent ${params.agent} is not allowed. Allowed agents: ${nestedPolicy.allowlist.join(", ")}.` : nestedDisabledMessage(), undefined, true);
        const agent = findAgent(cwd, params.agent, scope);
        if (!agent) return reply(`Unknown agent: ${params.agent}`, { available: discoverAgents(cwd, scope).agents.map((a) => a.name) }, true);
        return reply([
          `# ${agent.name}`,
          `Source: ${agent.source}`,
          `Description: ${agent.description}`,
          agent.model ? `Model: ${agent.model}` : undefined,
          agent.thinking ? `Thinking: ${agent.thinking}` : undefined,
          `Tools: ${Array.isArray(agent.tools) ? agent.tools.join(", ") : agent.tools ?? "all"}`,
          `File: ${agent.filePath}`,
          "",
          agent.systemPrompt,
        ].filter(Boolean).join("\n"), agent);
      }

      if (params.action === "status") {
        const id = params.childId ?? params.id;
        if (!id) {
          const jobs = await loadJobs(root);
          const visibleJobs = inNestedSession ? jobs.jobs.filter((job) => nestedCanAccessJob(job, nestedPolicy.childId)) : jobs.jobs;
          return reply(visibleJobs.map((job) => `${job.id.slice(0, 12)} ${job.status} ${jobDisplayName(job)}: ${job.taskPreview}`).join("\n") || "No tmux subagent jobs.", { ...jobs, jobs: visibleJobs });
        }
        const initialStatus = await getSubagentStatus(root, id);
        if (inNestedSession && !nestedCanAccessJob(initialStatus.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
        const status = initialStatus.job.autoStopOnComplete ? await autoStopCompletedSubagent(root, initialStatus) : initialStatus;
        activeJobs.set(status.job.id, { agentName: jobDisplayName(status.job), status: status.status });
        refreshParentStatus();
        return reply(formatStatus(status), status);
      }

      if (params.action === "send") {
        const id = params.childId ?? params.id;
        if (!id) return reply("Missing childId for send action.", undefined, true);
        if (!params.message) return reply("Missing message for send action.", undefined, true);
        try {
          const before = await getSubagentStatus(root, id);
          if (inNestedSession && !nestedCanAccessJob(before.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
          let status = await sendSubagentMessage(root, before.job.id, params.message);
          if (params.wait) {
            status = await waitForSubagent(root, before.job.id, undefined, { signal, timeoutMs: params.timeoutMs, afterTurnIndex: before.latestTurn?.index ?? 0, cancelOnAbort: false });
          }
          activeJobs.set(status.job.id, { agentName: jobDisplayName(status.job), status: status.status });
          refreshParentStatus();
          return reply(formatStatus(status), status, status.status === "error");
        } catch (error) {
          return reply(error instanceof Error ? error.message : String(error), undefined, true);
        }
      }

      if (params.action === "wait") {
        const id = params.childId ?? params.id;
        try {
          let status;
          if (id) {
            const before = await getSubagentStatus(root, id);
            if (inNestedSession && !nestedCanAccessJob(before.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
            status = await waitForSubagent(root, before.job.id, undefined, { signal, timeoutMs: params.timeoutMs, cancelOnAbort: false });
          } else {
            status = await waitForAnySubagent(root, undefined, {
              signal,
              timeoutMs: params.timeoutMs,
              cancelOnAbort: false,
              jobFilter: inNestedSession ? (job) => nestedCanAccessJob(job, nestedPolicy.childId) : undefined,
            });
          }
          activeJobs.set(status.job.id, { agentName: jobDisplayName(status.job), status: status.status });
          refreshParentStatus();
          return reply(formatStatus(status), status, status.status === "error");
        } catch (error) {
          return reply(error instanceof Error ? error.message : String(error), undefined, true);
        }
      }

      if (params.action === "cancel" || params.action === "stop") {
        const id = params.childId ?? params.id;
        if (!id) return reply(`Missing childId for ${params.action} action.`, undefined, true);
        if (inNestedSession) {
          const before = await getSubagentStatus(root, id);
          if (!nestedCanAccessJob(before.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
        }
        const job = await cancelSubagent(root, id);
        activeJobs.set(job.id, { agentName: jobDisplayName(job), status: job.status });
        refreshParentStatus();
        return reply(`Stopped ${job.id} (${job.tmuxSession}).`, job);
      }

      if (!params.agent || !params.task) return reply("Missing agent or task. Provide both to launch, or set action to list/get/status/cancel/stop/send/wait.", undefined, true);
      const agent = findAgent(cwd, params.agent, scope);
      if (!agent) return reply(`Unknown agent: ${params.agent}`, { available: discoverAgents(cwd, scope).agents.map((a) => a.name) }, true);
      const nestedLaunch = inNestedSession;
      if (nestedLaunch) {
        if (!nestedPolicy.allowlist.length) return reply(nestedDisabledMessage(), undefined, true);
        if (!nestedPolicy.allowlist.includes(agent.name)) return reply(`Nested agent ${agent.name} is not allowed. Allowed agents: ${nestedPolicy.allowlist.join(", ")}.`, undefined, true);
        const launchedDepth = nestedPolicy.depth + 1;
        const depthLimit = maxNestedDepth();
        if (launchedDepth > depthLimit) return reply(`Nested agent ${agent.name} cannot launch at subagent depth ${launchedDepth}; maxNestedDepth is ${depthLimit}.`, undefined, true);
      } else if (nestedPolicy.depth > agent.maxDepth) {
        return reply(`Agent ${agent.name} cannot launch at subagent depth ${nestedPolicy.depth}; maxDepth is ${agent.maxDepth}.`, undefined, true);
      }

      const autoStopOnComplete = resolveAutoStopOnComplete(params.autoStopOnComplete);
      const job = await launchSubagent({
        stateRoot: root,
        cwd,
        agent,
        task: params.task,
        background: params.background ?? false,
        autoStopOnComplete,
        allowNestedSubagents: params.allowNestedSubagents && !nestedLaunch,
        nestedAgentAllowlist: params.nestedAgentAllowlist,
        maxNestedDepth: params.maxNestedDepth,
        displayName: normalizeDisplayName(params.label),
      });
      activeJobs.set(job.id, { agentName: jobDisplayName(job), status: job.status });
      refreshParentStatus();
      if (params.background) {
        return reply([
          `Launched ${jobDisplayName(job)}${job.displayName ? ` (${job.agentName})` : ""} as ${job.id}`,
          `tmux: ${job.tmuxSession}`,
          `Result: ${job.resultPath}`,
          `Attach: tmux attach-session -t ${job.tmuxSession}`,
          autoStopOnComplete ? "Auto-stop: enabled when status observes clean completion" : `Stop when done: tmux_subagent({ action: "stop", childId: "${job.id}" })`,
        ].join("\n"), job);
      }

      const waited = await waitForSubagent(root, job.id, undefined, {
        signal,
        onUpdate: onUpdate ? (status) => {
          activeJobs.set(status.job.id, { agentName: jobDisplayName(status.job), status: status.status });
          refreshParentStatus();
          onUpdate(text(formatStatus(status), status));
        } : undefined,
      });
      const final = autoStopOnComplete ? await autoStopCompletedSubagent(root, waited) : waited;
      activeJobs.set(final.job.id, { agentName: jobDisplayName(final.job), status: final.status });
      refreshParentStatus();
      return reply(formatStatus(final), final, final.status === "error");
    },
  });
}
