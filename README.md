# pi-tmux-subagents

Pi extension for launching Markdown-defined subagents as real tmux-backed Pi sessions. Use it to delegate focused coding-agent tasks to parallel child Pi sessions, track their results, and optionally mirror them inside `pi-agent-hub`.

## Requirements

- Pi coding agent with package support.
- `tmux` available on `PATH`.
- Node.js 20 or newer for local development and npm installs.

## Install

Install from npm:

```bash
pi install npm:pi-tmux-subagents
```

Restart any already-running parent Pi sessions after installing or updating; Pi loads extension code at process start.

Local development install:

```bash
git clone https://github.com/masta-g3/pi-tmux-subagents.git
cd pi-tmux-subagents
npm install
npm test
pi install "$PWD"
```

Re-run `npm run build` after local changes, then restart parent Pi sessions that should use the updated extension. If both `npm:pi-tmux-subagents` and a local-path install are enabled, the npm-installed copy self-disables so the local checkout can register `tmux_subagent` without a duplicate-tool conflict.

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

## Tool usage

```ts
tmux_subagent({ action: "list" })
tmux_subagent({ action: "get", agent: "scout" })
tmux_subagent({ agent: "scout", task: "Inspect auth flow", label: "scout-auth", background: true })
tmux_subagent({ agent: "scout", task: "Inspect auth flow", model: "openai-codex/gpt-5.6-sol" }) // one-launch model override
tmux_subagent({ agent: "code-critic", task: "Review these files", label: "code-critic-api" }) // auto-stops after clean completion by default
tmux_subagent({ agent: "scout", task: "Keep alive for follow-up", autoStopOnComplete: false })
tmux_subagent({ agent: "worker", task: "Review with approved specialists", allowNestedSubagents: true, nestedAgentAllowlist: ["code-critic", "plan-critic"] })
tmux_subagent({ action: "send", childId: "abc123", message: "Now check edge cases.", wait: true })
tmux_subagent({ action: "wait", childId: "abc123", timeoutMs: 600000 }) // only when blocked
tmux_subagent({ action: "wait", timeoutMs: 600000 }) // wait for any active child to complete
tmux_subagent({ action: "status" }) // active/error jobs plus recent stopped jobs
tmux_subagent({ action: "status", includeStopped: true }) // full historical list
tmux_subagent({ action: "status", childId: "abc123" })
tmux_subagent({ action: "stop", childId: "abc123" }) // or action: "cancel"
```

Child sessions auto-stop after clean completion by default so completed subagents do not clutter tmux or `pi-agent-hub` dashboards. Pass `autoStopOnComplete: false` when you want to inspect, attach, or send follow-up messages after completion, then use `action: "stop"` when done. Auto-stop only applies after clean completion; failed or interrupted sessions stay alive for inspection. Background jobs auto-stop when a later `status` call or parent UI poll observes clean completion.

Persistent children support generic follow-up turns through `action: "send"`. By default `send` returns after pasting the message into the live child; pass `wait: true` to wait for the next completed turn. Multiline messages are bracket-pasted with newlines preserved, then submitted once. When a child invokes Pi's explicit `ask_question` flow, the heartbeat carries first-class attention metadata so `send` can answer that running child without treating all busy children as replyable.

Prefer not to block on asynchronous/background subagents. Launch them, do useful parent-side work while they run, then check `status` or use a bounded `wait` only when the parent is truly blocked. Use the optional launch-only `model` parameter for ephemeral model selection; durable model changes belong in the Markdown agent definition or a same-name user/project override. `action: "wait"` with `childId` waits for that child to return to an idle/completed state and returns immediately if it is already idle. `action: "wait"` without `childId` waits until any currently active child completes. Both forms support `timeoutMs`; timeouts leave children alive for later inspection or stopping.

Use `label` when launching multiple similar agents so dashboards and status output stay distinguishable. Prefer short labels prefixed with the agent type, such as `worker-auth`, `worker-billing`, `scout-api`, or `code-critic-plan`. Labels are display names only; `agent` still selects the underlying agent definition.

Every `tmux_subagent` call also performs a lightweight cleanup sweep: completed children with auto-stop enabled are stopped, while persistent idle children are kept in structured details as reminders for agents to stop them when no longer needed.

Unfiltered `action: "status"` is intentionally compact: it shows active/error jobs plus the 5 most recently stopped jobs, then reports how many older stopped jobs are hidden. Pass `includeStopped: true` to inspect the full historical list.

The user-facing surfaces are split by purpose. Tool cards stay lean and immutable in scrollback: they show one identity line, state, elapsed time, last activity for active children, compact real token/cost usage when Pi reports it, and a short result filename for terminal states. Full paths, model names, cleanup reminders, attach/stop commands, and pane previews stay in structured details/debug text for agents and inspection. The parent session publishes one compact below-editor widget by default for active, errored, persistent-idle, attention-needed, or briefly retained completed children. It uses an attention-first hierarchy: explicit child questions and errors get the primary detail line, fresh Agent Hub `session-metadata/<child-id>.json` can add compatible `pi-session-summary` fields (`goal`, `status`, `nextStep`, `stage`), and task/result text remains the fallback. Long-running children keep heartbeat-age wording conservative (`active …` before later `no activity …` labels); the extension still never generates summaries, calls a model, scrapes panes, or persists raw prompts/output for summaries. Toggle the per-child details table with `/subagents`, `alt+s`, or `ctrl+alt+s`; use `/subagents show` and `/subagents hide` to set it explicitly. Use `/subagents peek` for the wider task/status/result view. Use `/subagents view` for the interactive manager with grouped rows, sanitized peek/details, reply, guarded stop, result, and attach actions. Use `/subagents library` to browse available Markdown agents read-only. These widget modes share the same below-editor slot to avoid duplicate status. Widget text refreshes only when displayed text changes.

Each completed child turn captures the final assistant message into a numbered result file under `jobs/<id>/turns/`, and `jobs/<id>/result.md` is updated to the latest result for compatibility with existing tooling. This control-plane capture is handled by the child bootstrap and does not require the agent to have project file write access. Terminal tool results keep the rendered card compact, but the model-visible text includes the absolute result path plus a ready-to-use `read({ path, limit: 2000 })` hint; idle persistent children also include a `stop` reminder.

Nested tmux subagents are disabled by default. Set `allowNestedSubagents: true` plus `nestedAgentAllowlist` to expose `tmux_subagent` inside the child for explicitly requested specialist agents; nested children do not receive nested-launch permission by default. Use `maxNestedDepth` to cap allowed child launch depth. The interactive view keeps parent lineage available in row details/peek when the job has a `parentId`; full tree rendering is intentionally deferred so attention and errors remain top-level scannable.

Foreground runs and explicit status calls render a compact parent-session summary:

```text
tmux subagent scout
 ✓ done · 2m39s · 1.1k out · $0.01
   ✓ result ready → 001-result.md
```

While tracked subagents are active, errored, persistent-idle, or briefly retained after clean auto-stop, the parent session shows the adaptive below-editor widget by default:

```text
tmux subagents · 1 needs input · 1 running · 1 idle · $0.04
├─ ✸ scout-auth · needs input
│  ⎿ question: Choose auth migration path?
├─ ⟳ worker-ui · running · testing · active 8s ago
│  ⎿ status: Updating widget rendering tests.
└─ ✓ scout-docs · idle · result 001-result.md · $0.03
   ⎿ task: Check docs coverage
╰─ /subagents view · /subagents details · /subagents peek
```

A single child uses the same default widget with a compact card:

```text
tmux subagent · background
⟳ scout-auth · running · implementing · active 4s ago · 1.4k out · $0.08
  ⎿ goal: Inspect auth flow
  ⎿ status: Reviewing session handling and auth middleware.
  ⎿ next: Check token refresh.
╰─ /subagents view · /subagents details · /subagents peek
```

Toggle details with `/subagents`, `alt+s`, or `ctrl+alt+s` to replace the adaptive widget with the per-child table:

```text
tmux subagents
⟳ scout-render  running  1m12s  5s ago  9.2k/1.1k  $0.01
✓ scout-cost    idle     58s    —       16.7k/912  $0.02
```

Use `/subagents peek` for a wider opt-in task/status/result view. Use `/subagents view` to open the interactive manager; its header carries the same count/cost summary as the widget, and idle/done rows surface result filenames plus usage when available:

```text
subagents view · 1 needs input · 1 running · 1 idle · $0.04 ─────────── R refresh

Needs input (1)
> ✸ scout-auth          Choose auth migration path                         2m

Running (1)
  ⟳ worker-ui           testing · Updating widget rendering tests          47s

Idle (1)
  ✓ scout-docs          result 001-result.md · 638 out · $0.0092           4m

Peek: scout-auth (scout) · needs input · 2m
  question: Choose auth migration path
  task: Inspect auth flow
  result: —

↑↓ select • p peek • r reply • s stop • a attach • enter result/attach • R refresh • esc close
```

Related slash commands:

```text
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
