import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, findAgent } from "./agents.js";
import { formatAgentStatus } from "./format.js";
import { renderToolCall, renderToolResult } from "./render.js";
import { STATUS_KEY } from "./names.js";
import { stateRoot } from "./paths.js";
import { autoStopCompletedSubagent, cancelSubagent, cleanupCompletedSubagents, getSubagentStatus, launchSubagent, sendSubagentAttentionReply, sendSubagentMessage, waitForAnySubagent, waitForSubagent, type CleanupCompletedResult } from "./run.js";
import { isFreshSessionSummary, readSessionSummaries, SESSION_SUMMARY_STALE_MS, type SessionSummaryMetadata } from "./session-summary.js";
import { loadJobs } from "./state.js";
import { createSubagentsLibraryView, formatAgentLibraryList } from "./subagents-library-view.js";
import { createSubagentsView, type SubagentsViewAction } from "./subagents-view.js";
import { createSubagentsWidget, nextWidgetAgeRefreshMs } from "./subagents-widget.js";
import { SUBAGENT_UI } from "./ui-tokens.js";
import { toSubagentViewRows, type SubagentViewRow } from "./view-model.js";
import type { AgentScope, SubagentStatusResult, TmuxSubagentJob } from "./types.js";

type ToolParams = {
  action?: "list" | "get" | "status" | "cancel" | "stop" | "send" | "wait";
  agent?: string;
  task?: string;
  label?: string;
  message?: string;
  wait?: boolean;
  timeoutMs?: number;
  background?: boolean;
  includeStopped?: boolean;
  childId?: string;
  id?: string;
  agentScope?: AgentScope;
  cwd?: string;
  autoStopOnComplete?: boolean;
  allowNestedSubagents?: boolean;
  nestedAgentAllowlist?: string[];
  maxNestedDepth?: number;
  model?: string;
};

type PiContext = {
  cwd: string;
  mode?: string;
  ui?: {
    theme?: { fg?: (token: any, text: string) => string; bg?: (token: any, text: string) => string; bold?: (text: string) => string };
    setStatus?: (key: string, text: string | undefined) => void;
    setWidget?: ExtensionContext["ui"]["setWidget"];
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    input?: (title: string, placeholder?: string, opts?: any) => Promise<string | undefined>;
    confirm?: (title: string, message: string, opts?: any) => Promise<boolean>;
    custom?: any;
    setEditorText?: (text: string) => void;
  };
};

const RECENT_STOPPED_STATUS_LIMIT = 5;
const PACKAGE_NAME = "pi-tmux-subagents";
const activeJobs = new Map<string, SubagentStatusResult>();
let setStatus: ((text: string | undefined) => void) | undefined;
let setWidget: ((rows: SubagentViewRow[] | undefined) => void) | undefined;
let lastStatusText: string | undefined;
let lastWidgetText: string | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let pollRoot: string | undefined;
let refreshQueue: Promise<unknown> = Promise.resolve();
let refreshGeneration = 0;
let activeViewDispose: (() => void) | undefined;

const COMPLETION_RETENTION_MS = 10_000;
const retainedCompletions = new Map<string, { status: SubagentStatusResult; expiresAt: number }>();
let completionRetentionTimer: NodeJS.Timeout | undefined;
let summaryCache = new Map<string, SessionSummaryMetadata>();
let summaryRefreshSequence = 0;
let summaryExpiryTimer: NodeJS.Timeout | undefined;
let widgetAgeTimer: NodeJS.Timeout | undefined;
let widgetRows: SubagentViewRow[] = [];
let requestWidgetRender: (() => void) | undefined;
let widgetSuppressionDepth = 0;

function visibleStatuses(now = Date.now()): SubagentStatusResult[] {
  pruneCompletionRetentions(now);
  const statuses = [...activeJobs.values()].filter((status) => {
    if (status.status === "starting" || status.status === "running" || status.status === "error") return true;
    return status.status === "waiting" && status.job.autoStopOnComplete === false;
  });
  const visibleIds = new Set(statuses.map((status) => status.job.id));
  for (const [id, retained] of retainedCompletions) {
    if (retained.expiresAt > now && !visibleIds.has(id)) statuses.push(retained.status);
  }
  return statuses;
}

function hasActiveStatuses(): boolean {
  return visibleStatuses().some((status) => status.status === "starting" || status.status === "running");
}

function visibleStatusIds(statuses: SubagentStatusResult[]): string[] {
  return statuses.map((status) => status.job.id).sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function pruneCompletionRetentions(now = Date.now()) {
  for (const [id, retained] of retainedCompletions) {
    if (retained.expiresAt <= now) retainedCompletions.delete(id);
  }
}

function clearCompletionRetentionTimer() {
  if (completionRetentionTimer) clearTimeout(completionRetentionTimer);
  completionRetentionTimer = undefined;
}

function scheduleCompletionRetentionClear(now = Date.now()) {
  clearCompletionRetentionTimer();
  let nextExpiry: number | undefined;
  for (const retained of retainedCompletions.values()) {
    if (retained.expiresAt <= now) continue;
    nextExpiry = Math.min(nextExpiry ?? retained.expiresAt, retained.expiresAt);
  }
  if (nextExpiry === undefined) return;
  completionRetentionTimer = setTimeout(() => {
    completionRetentionTimer = undefined;
    pruneCompletionRetentions();
    refreshParentStatus();
    scheduleCompletionRetentionClear();
  }, Math.max(1, nextExpiry - now));
  completionRetentionTimer.unref?.();
}

function rememberCompletion(status: SubagentStatusResult, now = Date.now()) {
  if (!status.autoStopped) return;
  retainedCompletions.set(status.job.id, { status, expiresAt: now + COMPLETION_RETENTION_MS });
  scheduleCompletionRetentionClear(now);
}

function pruneSummaryCache(now = Date.now()) {
  for (const [id, summary] of summaryCache) {
    if (!isFreshSessionSummary(summary, now)) summaryCache.delete(id);
  }
}

function clearSummaryExpiryTimer() {
  if (summaryExpiryTimer) clearTimeout(summaryExpiryTimer);
  summaryExpiryTimer = undefined;
}

function scheduleSummaryExpiryRefresh(now = Date.now()) {
  clearSummaryExpiryTimer();
  pruneSummaryCache(now);
  const visibleIds = new Set(visibleStatusIds(visibleStatuses(now)));
  let nextExpiry: number | undefined;
  for (const [id, summary] of summaryCache) {
    if (!visibleIds.has(id)) continue;
    const expiry = summary.updatedAt + SESSION_SUMMARY_STALE_MS + 1;
    if (expiry <= now) continue;
    nextExpiry = Math.min(nextExpiry ?? expiry, expiry);
  }
  if (nextExpiry === undefined) return;
  summaryExpiryTimer = setTimeout(() => {
    summaryExpiryTimer = undefined;
    pruneSummaryCache();
    refreshParentStatus();
    scheduleSummaryExpiryRefresh();
  }, Math.max(1, nextExpiry - now));
  summaryExpiryTimer.unref?.();
}

function clearWidgetAgeTimer() {
  if (widgetAgeTimer) clearTimeout(widgetAgeTimer);
  widgetAgeTimer = undefined;
}

function scheduleWidgetAgeRefresh(now = Date.now()) {
  clearWidgetAgeTimer();
  const delay = nextWidgetAgeRefreshMs(widgetRows, now);
  if (delay === undefined) return;
  widgetAgeTimer = setTimeout(() => {
    widgetAgeTimer = undefined;
    requestWidgetRender?.();
    scheduleWidgetAgeRefresh();
  }, delay);
  widgetAgeTimer.unref?.();
}

function widgetKey(rows: SubagentViewRow[]): string | undefined {
  if (!rows.length) return undefined;
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    group: row.group,
    glyph: row.glyph,
    name: row.name,
    detail: row.detail,
    updatedAt: row.updatedAt,
    usage: row.usage,
    cost: row.cost,
    resultFile: row.resultFile,
  })));
}

function applyParentUi() {
  const rows = toSubagentViewRows(visibleStatuses(), { summaries: summaryCache });
  const nextWidgetText = widgetSuppressionDepth > 0 ? undefined : widgetKey(rows);
  widgetRows = rows;

  if (lastStatusText !== undefined) {
    setStatus?.(undefined);
    lastStatusText = undefined;
  }
  if (nextWidgetText !== lastWidgetText) {
    setWidget?.(nextWidgetText ? rows : undefined);
    lastWidgetText = nextWidgetText;
  }
  if (widgetSuppressionDepth > 0) clearWidgetAgeTimer();
  else scheduleWidgetAgeRefresh();
}

function suppressAmbientWidget(): () => void {
  let released = false;
  widgetSuppressionDepth += 1;
  if (widgetSuppressionDepth === 1) refreshParentStatus();
  return () => {
    if (released) return;
    released = true;
    widgetSuppressionDepth = Math.max(0, widgetSuppressionDepth - 1);
    if (widgetSuppressionDepth === 0) refreshParentStatus();
  };
}

async function refreshSummaryCacheFor(statuses: SubagentStatusResult[]) {
  const ids = visibleStatusIds(statuses);
  const sequence = ++summaryRefreshSequence;
  const summaries = await readSessionSummaries(ids).catch(() => new Map<string, SessionSummaryMetadata>());
  if (sequence !== summaryRefreshSequence || !sameIds(ids, visibleStatusIds(visibleStatuses()))) return;
  summaryCache = summaries;
  scheduleSummaryExpiryRefresh();
  refreshParentStatus();
}

function trackStatus(status: SubagentStatusResult) {
  activeJobs.set(status.job.id, status);
  rememberCompletion(status);
  refreshParentStatus();
  void refreshSummaryCacheFor(visibleStatuses());
  if (pollRoot) startStatusPolling(pollRoot);
}

function trackJob(job: TmuxSubagentJob) {
  trackStatus({ job, status: job.status });
}

function startStatusPolling(root: string) {
  if (pollTimer || !hasActiveStatuses()) return;
  pollTimer = setInterval(() => {
    if (!hasActiveStatuses()) {
      stopStatusPolling();
      return;
    }
    void refreshSubagentSnapshot(root, "parent");
  }, 3000);
  pollTimer.unref?.();
}

function stopStatusPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

function refreshParentStatus() {
  applyParentUi();
  if (!hasActiveStatuses()) stopStatusPolling();
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const label = value?.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "").replace(/-+/g, "-").slice(0, 48);
  return label || undefined;
}

function jobDisplayName(job: { agentName: string; displayName?: string }): string {
  return job.displayName ?? job.agentName;
}

function compareRecentJobs(a: TmuxSubagentJob, b: TmuxSubagentJob): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

function formatJobSummary(job: TmuxSubagentJob): string {
  return `${job.id.slice(0, 12)} ${job.status} ${jobDisplayName(job)}: ${job.taskPreview}`;
}

function selectStatusJobs(jobs: TmuxSubagentJob[], includeStopped: boolean): { jobs: TmuxSubagentJob[]; hiddenStopped: number } {
  const sorted = [...jobs].sort(compareRecentJobs);
  if (includeStopped) return { jobs: sorted, hiddenStopped: 0 };

  const active = sorted.filter((job) => job.status !== "stopped");
  const stopped = sorted.filter((job) => job.status === "stopped");
  const recentStopped = stopped.slice(0, RECENT_STOPPED_STATUS_LIMIT);
  return { jobs: [...active, ...recentStopped].sort(compareRecentJobs), hiddenStopped: stopped.length - recentStopped.length };
}

type PackageSettingsEntry = string | { source?: string; extensions?: unknown[] };

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function isNpmPackageRoot(root: string): boolean {
  return root.split(sep).includes("npm") && root.split(sep).includes("node_modules") && root.endsWith(`${sep}${PACKAGE_NAME}`);
}

function packageNameAt(root: string): string | undefined {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  return (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string }).name;
}

function settingsPaths(cwd = process.cwd()): string[] {
  const userDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
  return [join(userDir, "settings.json"), join(cwd, ".pi", "settings.json")];
}

function packageSource(entry: PackageSettingsEntry): string | undefined {
  return typeof entry === "string" ? entry : entry.source;
}

function packageExtensionsEnabled(entry: PackageSettingsEntry): boolean {
  return typeof entry === "string" || !Array.isArray(entry.extensions) || entry.extensions.length > 0;
}

function isLocalSource(source: string): boolean {
  return isAbsolute(source) || source.startsWith("./") || source.startsWith("../");
}

function enabledLocalPackageRoot(entry: PackageSettingsEntry, settingsPath: string): string | undefined {
  const source = packageSource(entry);
  if (!source || !isLocalSource(source) || !packageExtensionsEnabled(entry)) return undefined;
  return isAbsolute(source) ? source : resolve(dirname(settingsPath), source);
}

export function shouldSkipNpmPackageForLocalDev(input: { currentRoot: string; settingsFiles: string[] }): boolean {
  if (!isNpmPackageRoot(input.currentRoot) || packageNameAt(input.currentRoot) !== PACKAGE_NAME) return false;
  for (const settingsPath of input.settingsFiles) {
    if (!existsSync(settingsPath)) continue;
    const entries = (JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: PackageSettingsEntry[] }).packages ?? [];
    for (const entry of entries) {
      const root = enabledLocalPackageRoot(entry, settingsPath);
      if (root && root !== input.currentRoot && packageNameAt(root) === PACKAGE_NAME) return true;
    }
  }
  return false;
}

function shouldSkipCurrentNpmPackageForLocalDev(): boolean {
  return shouldSkipNpmPackageForLocalDev({ currentRoot: packageRoot(), settingsFiles: settingsPaths() });
}

function formatJobsStatus(jobs: TmuxSubagentJob[], includeStopped: boolean): string {
  const { jobs: selected, hiddenStopped } = selectStatusJobs(jobs, includeStopped);
  const lines = selected.map(formatJobSummary);
  if (hiddenStopped > 0) lines.push(`${hiddenStopped} older stopped child${hiddenStopped === 1 ? "" : "ren"} hidden; pass includeStopped: true for full history.`);
  return lines.join("\n") || "No tmux subagent jobs.";
}

const TmuxSubagentParams = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "status", "cancel", "stop", "send", "wait"], description: "Management action. Omit to launch an agent. get reads an agent definition; status/wait/send/stop manage launched child jobs. stop is an alias for cancel." },
    agent: { type: "string", description: "Agent definition name for launch/get, e.g. scout or code-critic. Not a launched child job id." },
    task: { type: "string", description: "Task for launch." },
    label: { type: "string", description: "Optional short dashboard label for launch; prefix with agent type, e.g. worker-auth or scout-api." },
    message: { type: "string", description: "Message to send for action=send." },
    wait: { type: "boolean", description: "For action=send, wait for the next completed turn before returning. Prefer false unless blocked. Default false." },
    timeoutMs: { type: "number", description: "Optional timeout for action=send with wait=true or action=wait; wait leaves children alive on timeout." },
    background: { type: "boolean", description: "Return immediately after spawning the tmux child. Default false." },
    includeStopped: { type: "boolean", default: false, description: "For action=status without childId, include all stopped historical jobs. Default false shows active/error jobs plus the 5 most recently stopped jobs." },
    childId: { type: "string", description: "Launched child job ID or unique prefix for status/send/wait/stop. For action=wait, omit to return when any active child completes." },
    id: { type: "string", description: "Alias for childId." },
    agentScope: { type: "string", enum: ["user", "project", "both"], description: "Agent discovery scope. Default user." },
    cwd: { type: "string", description: "Working directory for the child. Defaults to parent cwd." },
    autoStopOnComplete: { type: "boolean", default: true, description: "Stop the tmux session automatically after a clean completion. Default true; set false to keep sessions alive for follow-up. Failures and attention-needed sessions stay alive." },
    allowNestedSubagents: { type: "boolean", default: false, description: "Expose tmux_subagent inside the child for explicitly approved nested specialist agents. Default false." },
    nestedAgentAllowlist: { type: "array", items: { type: "string" }, description: "Agent names the child may launch when allowNestedSubagents is true." },
    maxNestedDepth: { type: "number", default: 2, description: "Maximum PI_SUBAGENT_DEPTH allowed for launched nested tmux_subagents. Default 2." },
    model: { type: "string", description: "Override the agent's configured model for this launch only, e.g. openai-codex/gpt-5.6-sol. Omit to use the agent definition." }
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

function trackCleanupCompletions(cleanup: CleanupCompletedResult) {
  for (const status of cleanup.autoStopped) {
    if (!activeJobs.has(status.job.id)) continue;
    activeJobs.set(status.job.id, status);
    rememberCompletion(status);
  }
  if (cleanup.autoStopped.length) {
    refreshParentStatus();
    void refreshSummaryCacheFor(visibleStatuses());
  }
}

function withCleanupNote(result: ToolTextResult, cleanup: CleanupCompletedResult): ToolTextResult {
  const note = cleanupNote(cleanup);
  if (!note) return result;
  if (typeof result.details === "object" && result.details !== null) {
    const details = { ...result.details, hygieneNote: note };
    return isStatusResult(details) ? text(formatAgentStatus(details), details, result.isError) : text(result.content[0]?.text ?? "", details, result.isError);
  }
  return text(result.content[0]?.text ?? "", { details: result.details, hygieneNote: note }, result.isError);
}

function isStatusResult(value: unknown): value is SubagentStatusResult {
  return typeof value === "object" && value !== null && "job" in value && "status" in value;
}

function statusResultPath(status: SubagentStatusResult): string | undefined {
  if (!status.latestTurn && !status.latestResult && !status.result) return undefined;
  return status.latestTurn?.resultPath ?? status.job.resultPath;
}

function statusReadCall(status: SubagentStatusResult): string | undefined {
  const path = statusResultPath(status);
  return path ? `read({ path: ${JSON.stringify(path)}, limit: 2000 })` : undefined;
}

function formatChildGetHint(status: SubagentStatusResult): string {
  return [
    "`get` reads agent definitions, not launched child jobs.",
    `For this child, use: tmux_subagent({ action: "status", childId: "${status.job.id}" })`,
    statusReadCall(status),
  ].filter(Boolean).join("\n");
}

function formatStoppedSendHint(status: SubagentStatusResult): string {
  const path = statusResultPath(status);
  return [
    `Cannot send to stopped subagent: ${status.job.id}`,
    path ? `Result is available at: ${path}` : undefined,
    statusReadCall(status),
  ].filter(Boolean).join("\n");
}

function formatBusySendHint(status: SubagentStatusResult): string {
  return [
    `Cannot send to busy subagent ${status.job.id}; wait until it is idle.`,
    `Check later with: tmux_subagent({ action: "status", childId: "${status.job.id}" })`,
  ].join("\n");
}

function formatTimeoutHint(error: unknown, childId?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!/Timed out/.test(message)) return message;
  return childId
    ? [`Timed out; child is still alive: ${childId}`, `Check later with: tmux_subagent({ action: "status", childId: "${childId}" })`].join("\n")
    : ["Timed out; child subagents are still alive.", "Check later with: tmux_subagent({ action: \"status\" })"].join("\n");
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

export interface ParsedSubagentsCommand {
  verb: string;
  id?: string;
  message?: string;
}

export function parseSubagentsCommand(args: string): ParsedSubagentsCommand {
  const trimmed = args.trim();
  if (!trimmed) return { verb: "toggle" };
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { verb: trimmed.toLowerCase() };
  const verb = trimmed.slice(0, firstSpace).toLowerCase();
  const rest = trimmed.slice(firstSpace).trimStart();
  if (verb !== "reply") {
    const [id] = rest.split(/\s+/, 1);
    return { verb, id };
  }
  const idMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { verb, id: idMatch?.[1], message: idMatch?.[2] };
}

type RefreshScope = "parent" | "manager";
type SubagentSnapshot = { statuses: SubagentStatusResult[]; summaries: Map<string, SessionSummaryMetadata>; rows: SubagentViewRow[] };

async function refreshSubagentSnapshot(root: string, scope: RefreshScope): Promise<SubagentSnapshot> {
  const generation = refreshGeneration;
  const run = async (): Promise<SubagentSnapshot> => {
    const jobs = scope === "manager"
      ? selectStatusJobs((await loadJobs(root)).jobs, false).jobs
      : [...activeJobs.values()].map((status) => status.job);
    const ids = [...new Set(jobs.map((job) => job.id))];
    const refreshed = await Promise.all(ids.map(async (id) => {
      const status = await getSubagentStatus(root, id).catch(() => undefined);
      if (!status) return undefined;
      return status.job.autoStopOnComplete ? autoStopCompletedSubagent(root, status) : status;
    }));
    const statuses = refreshed.filter((status): status is SubagentStatusResult => Boolean(status));
    const summaries = await readSessionSummaries(statuses.map((status) => status.job.id)).catch(() => new Map<string, SessionSummaryMetadata>());
    const rows = toSubagentViewRows(statuses, { summaries });

    if (generation === refreshGeneration) {
      for (const status of statuses) {
        activeJobs.set(status.job.id, status);
        rememberCompletion(status);
      }
      summaryCache = summaries;
      scheduleSummaryExpiryRefresh();
      refreshParentStatus();
      pollRoot = root;
      if (hasActiveStatuses()) startStatusPolling(root);
    }
    return { statuses, summaries, rows };
  };

  const scheduled = refreshQueue.then(run, run);
  refreshQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

async function handleSubagentsAction(action: SubagentsViewAction | undefined, root: string, ctx: PiContext): Promise<boolean> {
  if (!action || action.type === "close") return false;
  let status: SubagentStatusResult;
  try {
    status = await getSubagentStatus(root, action.id);
  } catch {
    ctx.ui?.notify?.(`Unknown subagent: ${action.id}`, "error");
    return true;
  }
  if (action.type === "attach") {
    const command = `!tmux attach-session -t ${status.job.tmuxSession}`;
    ctx.ui?.setEditorText?.(command);
    ctx.ui?.notify?.(`Attach command ready: ${command}`, "info");
    return false;
  }
  if (action.type === "result") {
    const path = status.latestTurn?.resultPath ?? status.job.resultPath;
    ctx.ui?.notify?.(`Result: ${path}`, "info");
    return true;
  }
  if (action.type === "stop") {
    if (!action.confirmed) {
      const ok = await (ctx.ui?.confirm?.("Stop subagent", `Stop ${status.job.displayName ?? status.job.agentName}?`, { defaultValue: false }) ?? Promise.resolve(true));
      if (!ok) return true;
    }
    await cancelSubagent(root, status.job.id);
    ctx.ui?.notify?.(`Stopped ${status.job.id}.`, "info");
    return true;
  }
  if (action.type === "reply") {
    const message = await ctx.ui?.input?.(`Reply to ${status.job.displayName ?? status.job.agentName}`);
    if (!message) return true;
    await sendSubagentAttentionReply(root, status.job.id, message);
    ctx.ui?.notify?.(`Sent reply to ${status.job.id}.`, "info");
    return true;
  }
  return true;
}

async function openSubagentsView(root: string, ctx: PiContext) {
  if (!ctx.ui?.custom) {
    ctx.ui?.notify?.("/subagents view requires TUI mode.", "error");
    return;
  }
  let selectedId: string | undefined;
  const restoreAmbientWidget = suppressAmbientWidget();
  try {
    while (true) {
      const initial = await refreshSubagentSnapshot(root, "manager");
      let disposeView = () => {};
      let action: unknown;
      try {
        action = await ctx.ui.custom((tui: { requestRender?: () => void }, theme: any, _kb: unknown, done: (value: unknown) => void) => {
          let disposed = false;
          let refreshPromise: Promise<void> | undefined;
          let component: ReturnType<typeof createSubagentsView>;
          const refresh = () => {
            if (refreshPromise) return refreshPromise;
            refreshPromise = refreshSubagentSnapshot(root, "manager")
              .then((snapshot) => {
                if (!disposed) component.updateRows(snapshot.rows);
              })
              .finally(() => { refreshPromise = undefined; });
            return refreshPromise;
          };
          component = createSubagentsView(initial.rows, theme, {
            finish: done as (value: SubagentsViewAction | undefined) => void,
            requestRender: () => tui.requestRender?.(),
            refreshNow: refresh,
          }, { selectedId });
          const timer = setInterval(() => {
            void refresh().catch((error) => {
              clearInterval(timer);
              if (!disposed) ctx.ui?.notify?.(`Subagent live refresh stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
            });
          }, SUBAGENT_UI.refreshMs);
          timer.unref?.();
          disposeView = () => {
            if (disposed) return;
            disposed = true;
            clearInterval(timer);
            if (activeViewDispose === disposeView) activeViewDispose = undefined;
          };
          activeViewDispose?.();
          activeViewDispose = disposeView;
          return component;
        });
      } finally {
        disposeView();
      }
      const viewAction = action as SubagentsViewAction | undefined;
      if (viewAction && "id" in viewAction) selectedId = viewAction.id;
      if (!await handleSubagentsAction(viewAction, root, ctx)) return;
    }
  } finally {
    restoreAmbientWidget();
  }
}

async function openSubagentsLibrary(cwd: string, ctx: PiContext) {
  const agents = discoverAgents(cwd, "both").agents;
  if (!ctx.ui?.custom) {
    ctx.ui?.notify?.(formatAgentLibraryList(agents), "info");
    return;
  }
  await ctx.ui.custom((_tui: any, theme: any, _kb: unknown, done: (value: unknown) => void) => createSubagentsLibraryView(agents, theme, done as (value: unknown) => void));
}

async function handleSubagentsSlashCommand(args: string, ctx: PiContext) {
  const root = stateRoot();
  const parsed = parseSubagentsCommand(args);
  if (parsed.verb === "toggle" || parsed.verb === "view") return openSubagentsView(root, ctx);
  if (parsed.verb === "library") return openSubagentsLibrary(ctx.cwd, ctx);
  if (parsed.verb === "refresh") {
    await refreshSubagentSnapshot(root, "manager");
    ctx.ui?.notify?.("Subagent statuses refreshed.", "info");
    return;
  }
  if (parsed.verb === "attach") {
    if (!parsed.id) return ctx.ui?.notify?.("Usage: /subagents attach <id>", "error");
    const status = await getSubagentStatus(root, parsed.id);
    const command = `!tmux attach-session -t ${status.job.tmuxSession}`;
    ctx.ui?.setEditorText?.(command);
    ctx.ui?.notify?.(`Attach command ready: ${command}`, "info");
    return;
  }
  if (parsed.verb === "result") {
    if (!parsed.id) return ctx.ui?.notify?.("Usage: /subagents result <id>", "error");
    const status = await getSubagentStatus(root, parsed.id);
    ctx.ui?.notify?.(`Result: ${status.latestTurn?.resultPath ?? status.job.resultPath}`, "info");
    return;
  }
  if (parsed.verb === "stop") {
    if (!parsed.id) return ctx.ui?.notify?.("Usage: /subagents stop <id>", "error");
    const status = await getSubagentStatus(root, parsed.id);
    const ok = await (ctx.ui?.confirm?.("Stop subagent", `Stop ${status.job.displayName ?? status.job.agentName}?`, { defaultValue: false }) ?? Promise.resolve(true));
    if (!ok) return;
    const job = await cancelSubagent(root, status.job.id);
    trackJob(job);
    ctx.ui?.notify?.(`Stopped ${job.id}.`, "info");
    return;
  }
  if (parsed.verb === "reply") {
    if (!parsed.id) return ctx.ui?.notify?.("Usage: /subagents reply <id> [message]", "error");
    let message = parsed.message;
    if (!message) message = await ctx.ui?.input?.(`Reply to ${parsed.id}`);
    if (!message) return ctx.ui?.notify?.("No reply sent.", "warning");
    const status = await sendSubagentAttentionReply(root, parsed.id, message);
    trackStatus(status);
    ctx.ui?.notify?.(`Sent reply to ${status.job.id}.`, "info");
    return;
  }

  ctx.ui?.notify?.(`Unknown subagents command: ${parsed.verb}. Use /subagents, /subagents library, reply, stop, attach, result, or refresh.`, "error");
}

export default function tmuxSubagentsExtension(pi: ExtensionAPI) {
  if (shouldSkipCurrentNpmPackageForLocalDev()) {
    pi.on("session_start", async (_event, ctx) => {
      (ctx as PiContext).ui?.notify?.("Skipped npm pi-tmux-subagents because a local dev install is enabled.", "warning");
    });
    return;
  }

  pi.on("session_start", async (_event, ctx) => {
    const ui = (ctx as PiContext).ui;
    setStatus = ui?.setStatus ? (text) => ui.setStatus?.(STATUS_KEY, text) : undefined;
    setWidget = ui?.setWidget ? (rows) => {
      if (!rows) {
        requestWidgetRender = undefined;
        return ui.setWidget?.(STATUS_KEY, undefined);
      }
      return ui.setWidget?.(STATUS_KEY, (tui: { requestRender?: () => void }, theme: any) => {
        requestWidgetRender = () => tui.requestRender?.();
        return createSubagentsWidget(rows, theme);
      }, { placement: "belowEditor" });
    } : undefined;
    lastStatusText = "";
    lastWidgetText = "";
    refreshParentStatus();
  });
  pi.on("session_shutdown", async () => {
    refreshGeneration += 1;
    activeViewDispose?.();
    activeViewDispose = undefined;
    setStatus?.(undefined);
    setWidget?.(undefined);
    setStatus = undefined;
    setWidget = undefined;
    requestWidgetRender = undefined;
    widgetRows = [];
    widgetSuppressionDepth = 0;
    lastStatusText = undefined;
    lastWidgetText = undefined;
    summaryCache = new Map();
    summaryRefreshSequence++;
    clearSummaryExpiryTimer();
    clearWidgetAgeTimer();
    clearCompletionRetentionTimer();
    retainedCompletions.clear();
    stopStatusPolling();
    activeJobs.clear();
  });

  pi.registerCommand?.("subagents", {
    description: "Open the tmux subagent manager, browse the library, or run reply, stop, attach, result, and refresh actions",
    handler: async (args, ctx) => handleSubagentsSlashCommand(args, ctx as unknown as PiContext),
  });

  const openManagerShortcut = {
    description: "Open the tmux subagent manager",
    handler: async (ctx: ExtensionContext) => openSubagentsView(stateRoot(), ctx as unknown as PiContext),
  };
  pi.registerShortcut?.("alt+s", openManagerShortcut);
  pi.registerShortcut?.("ctrl+alt+s", openManagerShortcut);

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
      pollRoot = root;
      const nestedPolicy = nestedSessionPolicy();
      const inNestedSession = nestedPolicy.depth > 0;
      const requestedId = params.childId ?? params.id;
      const cleanup = await cleanupCompletedSubagents(root, undefined, {
        jobFilter: (job) => {
          if (inNestedSession && !nestedCanAccessJob(job, nestedPolicy.childId)) return false;
          return requestedId ? !job.id.startsWith(requestedId) : true;
        },
      });
      trackCleanupCompletions(cleanup);
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
        if (!params.agent) {
          if (requestedId) {
            const status = await getSubagentStatus(root, requestedId);
            if (inNestedSession && !nestedCanAccessJob(status.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
            return reply(formatChildGetHint(status), status, true);
          }
          return reply('Missing agent for get action. Use action: "get" with agent: "code-critic" to inspect an agent definition. To inspect a launched child/result, use action: "status" with childId.', undefined, true);
        }
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
          const selected = selectStatusJobs(visibleJobs, params.includeStopped ?? false);
          const statuses = await Promise.all(selected.jobs.map((job) => getSubagentStatus(root, job.id)));
          return reply(formatJobsStatus(visibleJobs, params.includeStopped ?? false), { ...jobs, jobs: selected.jobs, statuses, hiddenStopped: selected.hiddenStopped });
        }
        const initialStatus = await getSubagentStatus(root, id);
        if (inNestedSession && !nestedCanAccessJob(initialStatus.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
        const status = initialStatus.job.autoStopOnComplete ? await autoStopCompletedSubagent(root, initialStatus) : initialStatus;
        trackStatus(status);
        return reply(formatAgentStatus(status), status);
      }

      if (params.action === "send") {
        const id = params.childId ?? params.id;
        if (!id) return reply("Missing childId for send action.", undefined, true);
        if (!params.message) return reply("Missing message for send action.", undefined, true);
        try {
          const before = await getSubagentStatus(root, id);
          if (inNestedSession && !nestedCanAccessJob(before.job, nestedPolicy.childId)) return reply(`Nested child sessions can only manage jobs they launched.`, undefined, true);
          if (before.status === "stopped") return reply(formatStoppedSendHint(before), before, true);
          if ((before.status === "starting" || before.status === "running") && !before.heartbeat?.attention) return reply(formatBusySendHint(before), before, true);
          let status = before.heartbeat?.attention ? await sendSubagentAttentionReply(root, before.job.id, params.message) : await sendSubagentMessage(root, before.job.id, params.message);
          if (params.wait) {
            status = await waitForSubagent(root, before.job.id, undefined, { signal, timeoutMs: params.timeoutMs, afterTurnIndex: before.latestTurn?.index ?? 0, cancelOnAbort: false });
          }
          trackStatus(status);
          return reply(formatAgentStatus(status), status, status.status === "error");
        } catch (error) {
          return reply(formatTimeoutHint(error, id), undefined, true);
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
          trackStatus(status);
          return reply(formatAgentStatus(status), status, status.status === "error");
        } catch (error) {
          return reply(formatTimeoutHint(error, id), undefined, true);
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
        trackJob(job);
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
      const modelOverride = params.model?.trim();
      const job = await launchSubagent({
        stateRoot: root,
        cwd,
        agent: modelOverride ? { ...agent, model: modelOverride } : agent,
        task: params.task,
        background: params.background ?? false,
        autoStopOnComplete,
        allowNestedSubagents: params.allowNestedSubagents && !nestedLaunch,
        nestedAgentAllowlist: params.nestedAgentAllowlist,
        maxNestedDepth: params.maxNestedDepth,
        displayName: normalizeDisplayName(params.label),
      });
      trackJob(job);
      if (params.background) {
        return reply([
          `Launched ${jobDisplayName(job)}${job.displayName ? ` (${job.agentName})` : ""} as ${job.id}`,
          `state: ${job.status}`,
        ].join("\n"), job);
      }

      const waited = await waitForSubagent(root, job.id, undefined, {
        signal,
        onUpdate: onUpdate ? (status) => {
          trackStatus(status);
          onUpdate(text(formatAgentStatus(status), status));
        } : undefined,
      });
      const final = autoStopOnComplete ? await autoStopCompletedSubagent(root, waited) : waited;
      trackStatus(final);
      return reply(formatAgentStatus(final), final, final.status === "error");
    },
  });
}
