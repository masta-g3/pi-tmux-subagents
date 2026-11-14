/**
 * Hub's producer-neutral heartbeat fields for a child session: its workflow position and step lens, read from
 * the latest `workflow-runtime` entry in the child's branch, and its tool calls. Hub validates and bounds them;
 * this module only maps the producer entry onto the documented heartbeat shape (pi-agent-hub docs/CONFIG.md).
 */

const WORKFLOW_RUNTIME_ENTRY = "workflow-runtime";
// Display fields Hub reads from a positioned workflow; producer-private run state stays in the child.
const WORKFLOW_DISPLAY_FIELDS = ["ticketId", "currentStepComplete", "activity", "lens", "activeMode"] as const;

export const ACTIVITY_RECENT_MAX = 6;
const ACTION_DETAIL_MAX = 100;
const ACTION_TOOL_MAX = 40;
const PATH_TOOLS = new Set(["read", "edit", "write"]);
/** Short names for common tools, so they fit the dashboard's tool column. */
const TOOL_LABELS: Record<string, string> = { tmux_subagent: "agent", web_search: "search", fetch_content: "fetch" };
/** Questions and handoffs already show as the session's request; they are not work to log. */
const CONVERSATION_TOOLS = new Set(["ask_question", "ask_user_question", "hand_off"]);

export type HubAction = { tool: string; detail?: string; at: number };

type Entry = { type?: unknown; customType?: unknown; data?: unknown };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function hubWorkflowFields(entries: readonly unknown[] | undefined): { workflow?: Record<string, unknown>; lens?: unknown } {
  const entry = [...(entries ?? [])].reverse().find((item): item is Entry => isObject(item) && item.type === "custom" && item.customType === WORKFLOW_RUNTIME_ENTRY);
  const data = entry?.data;
  if (!isObject(data)) return {};
  if (data.activeStep === undefined) return data.lens === undefined ? {} : { lens: data.lens };
  const steps = Array.isArray(data.steps) ? data.steps : undefined;
  const activeIndex = steps?.findIndex((step) => isObject(step) && step.id === data.activeStep) ?? -1;
  if (!steps || activeIndex < 0 || typeof data.updatedAt !== "number") return {};
  const display = Object.fromEntries(WORKFLOW_DISPLAY_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
  return { workflow: { steps, activeIndex, updatedAt: data.updatedAt, ...display } };
}

/** Whether a tool call is the child's own work to log. */
export function loggedTool(toolName: string, parentToolCallId: unknown): boolean {
  return !parentToolCallId && !CONVERSATION_TOOLS.has(toolName);
}

export function hubAction(toolName: string, args: unknown, cwd: string): HubAction {
  const detail = actionDetail(toolName, args, cwd);
  return { tool: (TOOL_LABELS[toolName] ?? toolName.replace(/^mcp__.*__/u, "")).slice(0, ACTION_TOOL_MAX), ...(detail ? { detail } : {}), at: Date.now() };
}

/** One short argument that says what a tool call is for: a path, a command's first line, or its first text field. */
function actionDetail(toolName: string, args: unknown, cwd: string): string | undefined {
  if (!isObject(args)) return undefined;
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  let detail: string | undefined;
  if (PATH_TOOLS.has(toolName)) {
    const path = text(args.path) ?? text(args.file_path);
    detail = path?.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  } else if (toolName === "bash") {
    // The first line, without a leading `cd <dir> &&` that only says where the command runs.
    detail = text(args.command)?.split(/\r?\n/u).find((line) => line.trim())?.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/u, "");
  } else {
    detail = ["action", "agent", "label", "query", "url", "name", "task", "message", "prompt"].map((key) => text(args[key])).filter(Boolean).slice(0, 2).join(" ")
      || text(Object.values(args).find((value) => typeof value === "string" && value.trim()));
  }
  // Terminal controls never reach the heartbeat; Hub sanitizes again on read.
  const clean = detail?.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  const chars = [...clean];
  return chars.length <= ACTION_DETAIL_MAX ? clean : `${chars.slice(0, ACTION_DETAIL_MAX - 1).join("")}…`;
}
