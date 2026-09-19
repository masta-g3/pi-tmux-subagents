# pi-tmux-subagents

Pi extension for launching Markdown-defined subagents as real tmux-backed Pi sessions. Use it to delegate focused coding-agent tasks to parallel child Pi sessions, track their results, and optionally mirror them inside `pi-agent-hub`.

## Requirements

- Pi coding agent 0.80.5 or newer.
- `tmux` available on `PATH`.
- Node.js 22.19.0 or newer.

## Install

Install from npm:

```bash
pi install npm:pi-tmux-subagents
```

Reload or restart parent Pi sessions after installing or updating. Running children keep their loaded code; finish or stop them before relaunching to use an update.

Local development install:

```bash
git clone https://github.com/masta-g3/pi-tmux-subagents.git
cd pi-tmux-subagents
npm install
npm test
pi install "$PWD"
```

Re-run `npm run build` after local changes, then run `/reload` or restart the parent Pi session. Reloading a child does not update the parent's widget or manager. If both `npm:pi-tmux-subagents` and a local-path install are enabled, the npm-installed copy self-disables so the local checkout can register `tmux_subagent` without a duplicate-tool conflict.

## Agent files

The package ships with three built-in agents:

- `scout` — fast read-only codebase recon, pinned to `openai-codex/gpt-5.6-luna`.
- `worker` — focused implementation agent, pinned to `openai-codex/gpt-5.6-sol`.
- `delegate` — lightweight general helper that inherits the parent model.

Subagent final answers are captured automatically into the control-plane result files; agents only need `edit`/`write` tools when their task should modify or create project files.

User agents are discovered from:

```text
~/.pi/agent/agents/*.md
```

User/project agents with the same name override built-ins. Project agents are opt-in via `agentScope: "project"` or `"both"` and are discovered from the nearest:

```text
.pi/agents/*.md
```

Example:

```md
---
name: scout
description: Fast codebase recon
model: openai-codex/gpt-5.6-sol
thinking: low
tools: read, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are a focused scouting agent. Report findings clearly and stop.
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The launcher passes the selected value explicitly with `--thinking`, including `off`. A recognized thinking suffix on `model`, such as `openai-codex/gpt-5.6-sol:high`, takes precedence over the separate `thinking` field; the suffix is removed from the model argument and passed as the thinking level. An unrecognized suffix remains part of the model name.

## Tool usage

```ts
tmux_subagent({ action: "list" })
tmux_subagent({ action: "get", agent: "scout" })
tmux_subagent({ agent: "scout", task: "Inspect auth flow", label: "scout-auth", background: true })
tmux_subagent({ agent: "scout", task: "Inspect auth flow", model: "openai-codex/gpt-5.6-sol" }) // one-launch model override
tmux_subagent({ agent: "code-critic", task: "Review these files", label: "code-critic-api" }) // auto-stops after clean completion by default
tmux_subagent({ agent: "scout", task: "Inspect auth and await follow-up", autoStopOnComplete: false }) // 15-minute idle expiry
tmux_subagent({ agent: "scout", task: "Keep open until stopped", autoStopOnComplete: false, idleTimeoutMs: 0 })
tmux_subagent({ agent: "worker", task: "Review with approved specialists", allowNestedSubagents: true, nestedAgentAllowlist: ["code-critic", "plan-critic"] })
tmux_subagent({ action: "send", childId: "abc123", message: "Now check edge cases." }) // wait defaults to false
tmux_subagent({ action: "resume", childId: "abc123", message: "Now check edge cases." }) // stopped resumable child; wait defaults to false
tmux_subagent({ action: "wait", childId: "abc123", timeoutMs: 600000 }) // one bounded wait, only when blocked
tmux_subagent({ action: "wait", timeoutMs: 600000 }) // wait for any active child to complete
tmux_subagent({ action: "status" }) // active/error jobs plus recent stopped jobs
tmux_subagent({ action: "status", includeStopped: true }) // first history page (20 jobs)
tmux_subagent({ action: "status", childId: "abc123" })
tmux_subagent({ action: "stop", childId: "abc123" }) // or action: "cancel"
```

New children close themselves without a parent status query, even if the parent exits or reloads. Completion waits until automatic retries, compaction, and queued follow-ups finish and results are saved.

| Launch options | Lifetime after successful completion |
| --- | --- |
| Default | Close automatically |
| `autoStopOnComplete: false` | Stay open for follow-up; close after 15 continuously idle minutes |
| `autoStopOnComplete: false, idleTimeoutMs: 0` | Stay open until explicitly stopped |

Set a positive integer `idleTimeoutMs` at launch to change the reusable child's idle window in milliseconds. It does not delay one-shot closure. New work cancels the idle deadline; the next successful completion starts a fresh window. Child reload preserves the deadline.

Running and input-waiting children stay open. Failed or aborted runs and result-write failures also keep a child open. A finished child also stays open while any nested worker session remains open. Automatic closure never stops those workers. Explicit `action: "stop"` cascades through the child's descendants.

Successful closure removes the child's Agent Hub row and heartbeat but keeps its result files. If teardown reports a file or permission error, Pi may exit while stale records remain. Resolve the error, then use `action: "stop"` with the child ID to retry cleanup.

Existing jobs do not acquire this lifetime policy, even after a child reload. Stop them explicitly when no longer needed.

Persistent children support generic follow-up turns through `action: "send"`. By default `send` returns after pasting the message into the live child; `wait` defaults to `false` for both `send` and `resume`. Pass `wait: true` only when blocked and bound it with `timeoutMs`. Multiline messages are bracket-pasted with newlines preserved, then submitted once. When a child invokes Pi's explicit `ask_question` flow, the heartbeat carries first-class attention metadata so `send` can answer that running child without treating all busy children as replyable.

A stopped child can continue its saved Pi conversation with `action: "resume"`. Resume requires a nonblank `message`; there is no implicit resume. It keeps the same child ID, tmux session name, Pi session, and numbered result history, while assigning ownership and optional Hub mirroring to the parent that resumes it. Resume is available only for jobs created with saved session metadata. The extension does not scan legacy Pi sessions or backfill old jobs. Resume reuses the saved exact model, thinking level, agent configuration, system prompt, working directory, and lifecycle settings; it accepts no launch overrides. Use `send` instead while the child is live.

Prefer efficient asynchronous orchestration: launch with `background: true`, do useful parent-side work, then inspect status. If progress is impossible without a result, use one useful bounded `wait` rather than repeated short waits or status loops. Reusable-child defaults are unchanged: set `autoStopOnComplete: false` for a 15-minute idle window, or also set `idleTimeoutMs: 0` to keep the child open until stopped. Use the optional launch-only `model` parameter for ephemeral model selection; durable model changes belong in the Markdown agent definition or a same-name user/project override. `action: "wait"` with `childId` waits for that child to return to an idle/completed state and returns immediately if it is already idle. `action: "wait"` without `childId` waits until any currently active child completes. Both forms support `timeoutMs`. A timeout leaves the existing child alive for a later status check, follow-up send when idle, or explicit stop; it does not restart, resume, or relaunch the child. Do not assume a resumed process has a warm provider cache.

Use `label` when launching multiple similar agents so dashboards and status output stay distinguishable. Prefer short labels prefixed with the agent type, such as `worker-auth`, `worker-billing`, `scout-api`, or `code-critic-plan`. Labels are display names only; `agent` still selects the underlying agent definition.

Global `action: "status"` returns at most 20 jobs by default (`limit`: 1–50), prioritizing saved running/starting states, then waiting, error, and stopped states. Default selection includes only the 5 most recently stopped jobs; `includeStopped: true` makes all history eligible without bypassing the page cap. Use the returned `offset` hint to continue. Pages reflect current registry order, not a frozen snapshot. Each polling batch uses one constant registry snapshot for row selection and observation, then reconciles observed state against current storage; reconciliation and status mutations can require additional registry reads. Only displayed jobs are refreshed, so saved states outside the page may be stale. Normal polls read control metadata only. They do not capture tmux panes or read result bodies. The manager reads one result body only when its result disclosure is expanded. If a live child cannot be refreshed, global status still returns the saved state and a warning. A `childId` lookup remains unchanged.

`Subagent background refresh stopped` means automatic parent polling has stopped. Resolve the reported error, then use `/subagents refresh` to retry. A child reporting `Subagent heartbeat stopped` is no longer publishing periodic status; treat its displayed status as potentially stale until the file error is resolved and the child is relaunched.

The user-facing surfaces are split by purpose. Tool cards stay lean and immutable in scrollback: they show one identity line, state, elapsed time, last activity for active children, compact real token/cost usage when Pi reports it, and a short result filename for terminal states. New jobs report lifetime usage for their persisted Pi session, including resumed executions. Legacy jobs retain latest-run accounting. Individual values are labeled `lifetime` or `latest run`; aggregate costs are labeled lifetime, latest-run, mixed, or partial so a mixed page never claims that all usage is lifetime. Full paths, model names, cleanup reminders, attach/stop commands, and pane previews stay in structured details/debug text for agents and inspection. The parent session publishes one compact, width-aware below-editor widget for active, errored, persistent-idle, attention-needed, or briefly retained completed children. Questions and errors sort first and receive semantic color; routine states stay neutral. Fresh Agent Hub `session-metadata/<child-id>.json` can provide compatible `pi-session-summary` fields (`goal`, `status`, `nextStep`, `stage`), with turn/result/task text as fallback. Ages continue updating even after active polling stops. The extension still never generates summaries, calls a model, scrapes panes, or persists raw prompts/output for summaries.

Each successfully settled child run captures its final assistant message into a numbered result file under `jobs/<id>/turns/`, and `jobs/<id>/result.md` is updated to the latest result for compatibility with existing tooling. This control-plane capture is handled by the child bootstrap and does not require the agent to have project file write access. Terminal tool results keep the rendered card compact, but the model-visible text includes the absolute result path plus a ready-to-use `read({ path, limit: 2000 })` hint; idle children with indefinite or legacy lifetime policies also include a `stop` reminder.

Nested tmux subagents are disabled by default. Set `allowNestedSubagents: true` plus `nestedAgentAllowlist` to expose `tmux_subagent` inside the child for explicitly requested specialist agents; nested children do not receive nested-launch permission by default. Use `maxNestedDepth` to cap allowed child launch depth. The interactive manager keeps parent lineage available in selected-row details when the job has a `parentId`; full tree rendering is intentionally deferred so attention and errors remain top-level scannable.

Foreground runs and explicit status calls render a compact parent-session summary:

```text
tmux subagent scout
 ✓ done · 2m39s · 1.1k out · $0.01
   ✓ result ready → 001-result.md
```

The widget shows children launched by this Pi session, not every job on the machine. Reload restores ownership from recorded launch results, including launches on other branches of the same session. Inspecting or messaging another session's child does not add it to this widget. Cleanly stopped history does not reappear on reload.

While this session's children are active, errored, persistent-idle, or briefly retained after clean auto-stop, the widget appears below the editor:

```text
─ Subagents ────── 1 needs input · 1 running · 1 idle · $0.04 ─
✸ scout-auth   Choose auth migration path?                  2m
⟳ worker-ui    testing · Updating widget tests               8s
✓ scout-docs   result 001-result.md                           4m
```

The widget caps visible rows and links to `/subagents` only when jobs are hidden. Its ages show time since the row was updated, not total run time. At narrow widths it gives identity and intervention text priority over age and usage. It hides while the manager is open so the same jobs are never rendered twice, then returns when the manager closes.

`/subagents` is the main command. `/subagents view`, `alt+s`, and `ctrl+alt+s` open the same manager. It separates **This session** from **Other sessions / unassigned**; the latter includes jobs without a recorded launch in this session. Header counts cover both sections. This session's completions take priority in the limited history list.

```text
Subagents · 1 running · 1 idle
────────────────────────────────────────────────────────────────────────────────────────

  Agent                 Status       Activity
This session
> worker-ui             Running      Updating widget tests
Other sessions / unassigned
  scout-docs            Idle         Result ready

↑↓ select · enter show details · s stop · esc close
```

Use ↑↓ to select a child. Enter answers a question, sends a new task to an idle child, shows running/error details, or shows a completed result. The footer names the action before you press it. Use `d` for details when Enter offers an answer or task. At narrow widths, activity appears below the list for the selected child.

Details expose secondary action hints: `o` shows the result path, and `a` prepares an attach command in the editor rather than opening the child. `s` stops the selected child after confirmation; `esc` closes the panel. Check the session heading before acting on a job from another session.

The manager refreshes every three seconds and preserves the selected child when rows reorder. `R` refreshes immediately. `/subagents library` is a separate read-only browser of agent definitions.

Result bodies load only when expanded, not during normal refresh. Expanded content is discarded on collapse, close, selection changes, or a new turn/execution.

Related slash commands:

```text
/subagents
/subagents view
/subagents library
/subagents reply <id> [message]
/subagents stop <id>
/subagents attach <id>
/subagents result <id>
/subagents refresh
```

`/subagents attach <id>` prepares `!tmux attach-session -t <session>` in the editor; it does not run an interactive attach inside the Pi TUI.

State is stored in `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/pi-tmux-subagents` when unset.

## pi-agent-hub integration

The extension is standalone. When launched from a managed `pi-agent-hub` parent with `PI_AGENT_HUB_DIR` and `PI_AGENT_HUB_SESSION_ID`, it mirrors child rows into the hub registry and writes dashboard-compatible heartbeats. Without those env vars, no hub state is created or required.

## Development

```bash
npm install
npm test
npm publish --dry-run
```
