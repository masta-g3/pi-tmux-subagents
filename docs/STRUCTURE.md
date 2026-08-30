# pi-tmux-subagents Structure

`pi-tmux-subagents` is a minimal Pi extension that launches Markdown-defined subagents as real tmux-backed Pi sessions.

## Architecture

```mermaid
flowchart TD
  Parent[Parent Pi session] --> Tool[tmux_subagent tool]
  Tool --> Agents[Agent discovery]
  Tool --> State[jobs.json + jobs/id files]
  Tool --> Tmux[tmux new-session]
  Tmux --> Child[Child Pi process]
  Child --> Bootstrap[child-bootstrap extension]
  Bootstrap --> Heartbeat[jobs/id/heartbeat.json]
  Bootstrap --> Turns[jobs/id/turns/*]
  Bootstrap --> HubHeartbeat[optional pi-agent-hub heartbeat]
  State --> ViewModel[shared view model]
  Heartbeat --> ViewModel
  Turns --> ViewModel
  ViewModel --> Widget[below-editor widget]
  ViewModel --> AgentView[/subagents view]
  Agents --> Library[/subagents library]
```

Standalone state is the source of truth under `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/pi-tmux-subagents` when unset. `pi-agent-hub` mirroring is optional and adapter-based; normal operation must not require hub state.

A parent process can supply up to 8,192 characters of opaque child guidance through `PI_TMUX_SUBAGENTS_SYSTEM_PROMPT_APPEND`. The launcher appends a bounded nonblank value after the normal child system instructions and forwards it in the child's explicit environment so nested launches enabled by the package's nesting policy receive the same guidance. This package does not parse the text or depend on Hub; without the variable, prompt generation and launch behavior are unchanged.

## Lifecycle

Child Pi sessions auto-stop after clean completion by default so completed subagents do not clutter tmux or `pi-agent-hub` dashboards. Completion is represented as `waiting` after the child has been `running`; foreground runs then stop automatically, and background runs stop when a later `status` call or parent UI poll observes clean completion. Successful auto-stop also removes the mirrored `pi-agent-hub` subagent row. Pass `autoStopOnComplete: false` to keep a child alive for inspection, attach, or follow-up turns, then use `tmux_subagent({ action: "send", childId, message, wait })`, `tmux_subagent({ action: "wait", childId })`, `tmux_subagent({ action: "wait" })` to wait for any active child, and finally `tmux_subagent({ action: "stop", childId })` when done. Failed/interrupted sessions stay alive for inspection. `cancel` remains as a compatibility alias for the same shutdown behavior.

Persistent sessions capture each completed final assistant message into per-turn result files under `jobs/<id>/turns/` and update `jobs/<id>/result.md` to the latest completed result for compatibility; this is child-bootstrap control-plane output and does not require project file write access. The child bootstrap publishes heartbeat and turn-registry JSON through same-filesystem atomic replacement so status readers see complete control records. Status output prefers the latest turn result and renders persistent waiting sessions as idle/ready rather than one-shot done. Completed turns store a short `messagePreview` for dashboards. Follow-up messages are bracket-pasted with newlines preserved so multiline prompts submit as one turn. Parent agents should prefer background launches plus useful work and later status checks over blocking waits; `wait` is intended for moments when the parent is genuinely blocked. Launches can pass `model` for a one-off override of the Markdown agent's configured model; durable model changes remain file-based through same-name user/project agent overrides. When a child emits Pi's explicit `ask_question` tool call, `child-bootstrap` records `heartbeat.attention` with the prompt and clears it on the matching tool result or the next agent turn; this is the only source of `needs input` presentation. Each `tmux_subagent` call runs a lightweight hygiene sweep that auto-stops completed auto-stop jobs and keeps idle persistent-child cleanup reminders in structured details instead of prominent user-facing text. Global status without `childId` stays compact by showing active/error jobs plus the 5 most recently stopped jobs; pass `includeStopped: true` to inspect full history. Stopped history rows project saved registry state without tmux, turn-registry, or result-file reads. Live rows use canonical status reads, but an unreadable live child falls back to saved registry state with a warning instead of rejecting the complete status call. User-facing tool cards omit operational commands, previews, full paths, cleanup notes, and routine model names while showing one identity line, state, elapsed time, last activity for active children, compact real token/cost usage when available, and short result filenames for terminal states. Model-visible tool text for terminal child results additionally includes the absolute result path and a `read({ path, limit: 2000 })` hint, and idle persistent children include a `stop` reminder so parent agents can retrieve and clean up results without guessing filesystem locations.

The parent UI has two monitoring surfaces backed by one canonical row projection. A width-aware component in the single below-editor `setWidget` slot renders a capped process ledger for active, errored, attention-needed, persistent-idle, and briefly retained clean auto-stop completions. Signal precedence is error, explicit attention, fresh semantic metadata, latest turn, result, then task. Questions/errors receive semantic color while routine states remain neutral; age is derived from row timestamps at render time and a parent-owned boundary timer keeps it current after active polling stops. Fresh optional Agent Hub metadata from `${PI_AGENT_HUB_DIR}/session-metadata/<child-id>.json` can provide compatible `pi-session-summary` fields (`goal`, `status`, `nextStep`, `stage`). The extension only reads those records and does not call a model, scrape panes, or persist raw prompts/outputs to produce summaries. Clean auto-stopped completions remain visible for about 10 seconds.

`/subagents`, `/subagents view`, `alt+s`, and `ctrl+alt+s` open one custom TUI manager grouped by Needs input, Error, Running, Idle, and Done. The ambient widget is suppressed while this manager is mounted and restored on every close or action exit, preventing duplicate job lists. A serialized refresh coordinator applies the same status, auto-stop, retention, summary, and widget updates for parent polling and the manager. While mounted, the manager refreshes every three seconds, preserves selection by child ID, and disposes its timer on action handoff, close, or session shutdown. Enter replies to needs-input/persistent-idle rows, toggles details for running/error rows, or toggles a bounded sanitized result excerpt for completed rows. `R` refreshes in place; guarded stop, attach, and result-path actions remain available contextually. `/subagents library` remains a separate read-only browser for Markdown-defined agent files.

Nested launches are opt-in per parent launch with `allowNestedSubagents`, `nestedAgentAllowlist`, and `maxNestedDepth`. The launcher injects `tmux_subagent` into explicit child tool allowlists only when enabled, exports the allowlist/depth policy to the child, and does not propagate nested-launch permission to nested children by default. The shared view model carries `parentId` through to rows so the manager can show lineage in selected-row details; full tree rendering is intentionally deferred.

Optional `pi-agent-hub` mirror rows use the child ID and tmux session name, render under their parent, and keep the left-column label short (`displayName`/`label` when provided, otherwise `agentName`). `taskPreview` belongs in metadata/details/filtering, not in the row title. Launch labels should be short and prefixed with the agent type, e.g. `worker-auth` or `scout-api`, so parallel children remain distinguishable. Stopping or auto-stopping a subagent cascades to its nested descendants and removes their mirrored hub rows/heartbeats so completed child trees do not linger in the dashboard.

## Layout

- `agents/` — packaged built-in agents (`scout`, `worker`, `delegate`) loaded at lowest priority.
- `src/index.ts` — Pi extension entry point, npm/local duplicate-install guard, `tmux_subagent` tool, slash-command actions, serialized status refresh, widget timers, and live-manager lifecycle.
- `src/agents.ts` — Markdown frontmatter discovery for built-in, user, and project agents.
- `src/view-model.ts` — canonical pure grouping, sorting, detail precedence, primary action, result, usage, and lineage projection shared by both monitoring surfaces.
- `src/subagents-widget.ts` — width-aware ambient process ledger with exception-first ordering and render-time age calculation.
- `src/subagents-view.ts` — adaptive live TUI manager with contextual actions and inline detail/result disclosure.
- `src/ui-tokens.ts` — shared monitoring layout limits and semantic Pi theme roles.
- `src/subagents-library-view.ts` — read-only custom TUI browser/fallback formatter for available Markdown agents.
- `src/format.ts` — compact plain-text tool status cards and explicit status-list output.
- `src/render.ts` — theme-aware TUI rendering for `tmux_subagent` call/result rows.
- `src/names.ts` — canonical package/runtime names.
- `src/paths.ts` — state, job, turn, result, and agent directory path helpers.
- `src/state.ts` — `jobs.json`, per-job metadata, and lock-protected mutation helpers.
- `src/prompt.ts` — child boundary prompt, task contract, Pi CLI argument builder.
- `src/run.ts` — tmux launch/status/cancel/foreground wait behavior, including attention-aware replies to explicit child prompts.
- `src/session-summary.ts` — best-effort reader for fresh Agent Hub session metadata used by the widget and manager.
- `src/tmux.ts` — small tmux command wrapper, including safe paste/send helpers.
- `src/child-bootstrap.ts` — child-side heartbeat extension; writes per-turn result files plus the latest compatibility `result.md` from final assistant messages, captures message previews, and records/clears explicit question attention.
- `src/pi-agent-hub-adapter.ts` — optional dashboard mirroring detection and cleanup.
- `test/` — Node test runner tests compiled through TypeScript.

## Development

```bash
npm install
npm test
```

Use temporary `PI_TMUX_SUBAGENTS_DIR` values for manual smoke tests to avoid touching live jobs.
