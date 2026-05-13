import type { SubagentStatusResult, TmuxSubagentStatus } from "./types.js";

const STATUS_PRESENTATION: Record<TmuxSubagentStatus, { glyph: string; label: string; title: string }> = {
  starting: { glyph: "⟳", label: "starting", title: "Starting" },
  running: { glyph: "⟳", label: "running", title: "Running" },
  waiting: { glyph: "✓", label: "done", title: "Done" },
  stopped: { glyph: "■", label: "stopped", title: "Stopped" },
  error: { glyph: "✗", label: "error", title: "Error" },
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function snippet(text: string | undefined, maxLines = 8): string[] {
  const trimmed = text?.trim();
  if (!trimmed) return [];
  const allLines = trimmed.split(/\r?\n/);
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) lines.push("…");
  return lines;
}

export function formatStatus(status: SubagentStatusResult): string {
  const presentation = STATUS_PRESENTATION[status.status];
  const elapsed = formatDuration((status.heartbeat?.updatedAt ?? status.job.updatedAt) - status.job.createdAt);
  const result = snippet(status.result);
  const preview = result.length ? [] : snippet(status.preview);
  const error = result.length || preview.length ? [] : snippet(status.job.error);
  const lines = [
    `tmux subagent ${status.job.agentName}`,
    ` ${presentation.glyph} ${status.job.agentName} · ${presentation.label} · ${elapsed}`,
    `   ⎿  ${presentation.title}`,
  ];

  if (result.length) lines.push(...result.map((line) => `      ${line}`));
  else if (preview.length) lines.push("      Pane preview:", ...preview.map((line) => `      ${line}`));
  else if (error.length) lines.push(...error.map((line) => `      ${line}`));

  lines.push(
    `   tmux: ${status.job.tmuxSession}`,
    `   attach: tmux attach-session -t ${status.job.tmuxSession}`,
    `   output: ${status.job.resultPath}`,
  );
  if (status.autoStopped) {
    lines.push("   auto-stopped after completion");
    if (status.mirrorCleanupError) lines.push(`   pi-agent-hub cleanup failed: ${status.mirrorCleanupError}`);
  } else {
    if (status.autoStopError) lines.push(`   auto-stop failed: ${status.autoStopError}`);
    lines.push(`   stop: tmux_subagent({ action: "stop", childId: "${status.job.id}" })`);
  }
  return lines.join("\n");
}
