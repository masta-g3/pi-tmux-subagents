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
  ViewModel --> AgentView[/subagents]
  Agents --> Library[/subagents library]
```

Standalone state is the source of truth under `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/pi-tmux-subagents` when unset. `pi-agent-hub` mirroring is optional and adapter-based; normal operation must not require hub state.

A parent process can supply up to 8,192 characters of opaque child guidance through `PI_TMUX_SUBAGENTS_SYSTEM_PROMPT_APPEND`. The launcher appends a bounded nonblank value after the normal child system instructions and forwards it in the child's explicit environment so nested launches enabled by the package's nesting policy receive the same guidance. This package does not parse the text or depend on Hub; without the variable, prompt generation and launch behavior are unchanged.

Agent frontmatter supports thinking levels `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. `buildPiArgs` emits the resolved value as an explicit `--thinking` argument, including `off`. A recognized `:<thinking>` suffix on the configured model takes precedence over the separate `thinking` field and is stripped from the `--model` value. Unknown suffixes remain part of the model string.

## Lifecycle

The child owns automatic closure. Parent polling and manager refresh observe status; they do not stop completed children or run cleanup sweeps. Successful completion requires `agent_settled` while Pi is idle and results have been saved. `agent_end` alone is not completion because retries, compaction or follow-ups may still run. Failed or aborted runs, result-write failures and pending input keep a child open. Running children and parents with open descendants must also stay alive. See [Tool usage](../README.md#tool-usage) for launch lifetime options.

A persisted `idleTimeoutMs` identifies a new-policy job. Do not infer or backfill policy for older jobs. Reuse the existing heartbeat interval for expiry checks; no separate idle timer or cleanup service is needed. New work cancels the idle deadline. Start a fresh deadline only after successful completion, and preserve it across child reload.

Reload emits a shutdown event without ending the tmux session. An observer-written `stopped` status is therefore not proof of automatic completion. Preserve the deadline independently of that status, and keep new-policy live sessions observable through reload. Use the persisted `autoStopped` marker for automatic completion, including when finalization races with an otherwise unchanged status read.

Automatic teardown must drain heartbeat writes before finalizing the job and removing its Hub row and heartbeat. Do not publish an early shutdown heartbeat that lets the parent stop polling before the completion marker exists, or allow a queued write to recreate a removed Hub heartbeat. Native shutdown cannot be cancelled once started. File or permission failures may leave stale records requiring operator cleanup; do not add a competing parent cleanup path to hide that limit.

Persistent sessions capture each successfully settled run's final assistant message into per-turn result files under `jobs/<id>/turns/` and update `jobs/<id>/result.md` to the latest completed result for compatibility; this is child-bootstrap control-plane output and does not require project file write access. New jobs carry `accountingVersion: 1` and report lifetime usage from the exact persisted Pi session across executions. Legacy jobs without that marker keep latest-run semantics; they are not migrated. UI rows label individual usage as lifetime or latest run, and total costs as lifetime, latest-run, mixed, or partial rather than presenting a mixed set as fully lifetime. The child bootstrap publishes heartbeat and turn-registry JSON through same-filesystem atomic replacement so status readers see complete control records. Heartbeat writes also run in order, preventing an older snapshot from replacing a newer state. Status output prefers the latest turn result and renders persistent waiting sessions as idle/ready rather than one-shot done. Completed turns store a short `messagePreview` for dashboards. Follow-up messages are bracket-pasted with newlines preserved so multiline prompts submit as one turn. Parent agents should prefer `background: true` launches plus useful work and later status checks over blocking waits. When genuinely blocked, use one useful bounded `wait` rather than repeated short waits or polling loops. `send` and `resume` default to `wait: false`; their optional wait uses the same bounded guidance. A timeout leaves the existing child alive and never restarts or relaunches it. Reusable-child lifecycle defaults remain unchanged (`autoStopOnComplete: false` uses the default finite idle window unless `idleTimeoutMs` overrides it). Launches can pass `model` for a one-off override of the Markdown agent's configured model; durable model changes remain file-based through same-name user/project agent overrides. When a child emits Pi's explicit `ask_question` tool call, `child-bootstrap` records `heartbeat.attention` with the prompt and clears it on the matching tool result or the next agent turn; this is the only source of `needs input` presentation. Stopped jobs with saved session metadata can be continued explicitly with `resume`. A nonblank message is required; no status, wait, or send path resumes a child implicitly. Resume keeps the child ID, tmux session name, exact Pi session, and result/turn history, but transfers parent/Hub ownership to the current caller. It reuses the recorded exact model and thinking level plus saved agent/system-prompt, cwd, nesting, and lifecycle configuration. Resume accepts no launch overrides and provides no guarantee of a warm provider cache. Only newly recorded `sessionFile`, `sessionId`, resolved-model, and resolved-thinking metadata is eligible. The implementation does not scan Pi session storage to discover or backfill legacy jobs.

Global status without `childId` is paginated: 20 jobs by default, a hard cap of 50 via `limit`, and `offset` for subsequent pages. Saved running/starting states precede waiting, error, and stopped states. The default selection includes only the 5 most recently stopped jobs; `includeStopped: true` includes all history in the paginated selection. Only the displayed page is refreshed; ordering reflects saved registry state and can change between calls. A poll uses one constant registry snapshot to select and observe its rows. Final reconciliation compares observations with current state and can perform additional registry reads or a lock-protected mutation read. Routine polls read heartbeat, turn, result-availability, and tmux liveness control data only; they do not capture panes or hydrate result bodies. List task previews are single-line and capped at 160 characters. Stopped history rows project saved registry state without tmux, turn-registry, or result-file reads. Live rows use canonical status reads, but an unreadable live child falls back to saved registry state with a warning instead of rejecting the complete status call. User-facing tool cards omit operational commands, previews, full paths, cleanup notes, and routine model names while showing one identity line, state, elapsed time, last activity for active children, compact real token/cost usage when available, and short result filenames for terminal states. Model-visible tool text for terminal child results additionally includes the absolute result path and a `read({ path, limit: 2000 })` hint, and indefinite or legacy idle children include a `stop` reminder so parent agents can retrieve and clean up results without guessing filesystem locations.

The parent UI has two monitoring surfaces backed by one canonical row projection. A width-aware component in the single below-editor `setWidget` slot renders a capped process ledger for active, errored, attention-needed, persistent-idle, and briefly retained clean auto-stop completions. Signal precedence is error, explicit attention, fresh semantic metadata, latest turn, result, then task. Questions/errors receive semantic color while routine states remain neutral; age is derived from row timestamps at render time and a parent-owned boundary timer keeps it current after active polling stops. Fresh optional Agent Hub metadata from `${PI_AGENT_HUB_DIR}/session-metadata/<child-id>.json` can provide compatible `pi-session-summary` fields (`goal`, `status`, `nextStep`, `stage`). The extension only reads those records and does not call a model, scrape panes, or persist raw prompts/outputs to produce summaries. Parent polling continues through finite idle windows. Clean auto-stopped completions remain visible for about 10 seconds; repeated observations must not renew that retention.

The manager can inspect jobs across sessions; the ambient widget belongs to one native Pi session. Global inspection must not adopt foreign jobs into that widget or its polling and summary state. Ownership follows recorded launches and resumes across the session's branches, not only the active branch. Changing branches does not stop its children. Reload must restore live children without replaying completed history. Within the manager's history limit, this session's completions take priority over foreign completions.

The manager separates this session's jobs from other or unassigned jobs and suppresses the ambient widget while open, preventing duplicate lists. See [the README](../README.md#tool-usage) for commands, controls, and layout. Parent polling and the manager share serialized status refreshes while preserving the ownership boundary. Background refreshes handle their own promise rejections, stop polling, and notify the user; Pi's event-handler error protection does not cover timer callbacks.

Result hydration occurs only on expansion, not during ordinary polling or `R` refresh. The component holds only the active disclosure content, clears it and invalidates in-flight reads on selection, turn, execution, collapse, or close, and ignores stale responses.

Nested launches are opt-in per parent launch with `allowNestedSubagents`, `nestedAgentAllowlist`, and `maxNestedDepth`. The launcher injects `tmux_subagent` into explicit child tool allowlists only when enabled, exports the allowlist/depth policy to the child, and does not propagate nested-launch permission to nested children by default. The shared view model carries `parentId` through to rows so the manager can show lineage in selected-row details; full tree rendering is intentionally deferred.

Optional `pi-agent-hub` mirror rows use the child ID and tmux session name, render under their parent, and keep the left-column label short (`displayName`/`label` when provided, otherwise `agentName`). `taskPreview` belongs in metadata/details/filtering, not in the row title. Launch labels should be short and prefixed with the agent type, e.g. `worker-auth` or `scout-api`, so parallel children remain distinguishable. Manual stop cascades through descendants and removes their mirrored Hub rows and heartbeats. Automatic closure finalizes only the child itself and waits for open descendants to close. Determine descendant liveness from actual tmux sessions, not saved status; a failed liveness query must block closure and be retried on the next heartbeat tick.

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

For isolated builds, preserve the package layout: compile into `<temp>/dist` and copy or link `agents/` and `node_modules/` into `<temp>`. Bundled agent discovery depends on that layout; compiling directly into the temporary root can make launch tests report an unknown agent. Do not replace shared `dist` while a functional test is using it.
