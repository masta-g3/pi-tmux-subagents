# subagent-visibility-ui — Subagent Visibility UI

Implemented an attention-first visibility pass for `pi-tmux-subagents` so parent sessions can more quickly understand what child agents need, what failed, what is running, and what output is ready.

## Implemented

- Updated the default summary widget to prioritize actionable causes:
  - explicit `heartbeat.attention.message` renders as `question: ...`.
  - job errors render as `error: ...` before task/result fallbacks.
  - attention and error rows stay ahead of routine running/idle/done rows.
- Added fresh session metadata stage display for running/starting rows, while keeping stale summaries suppressed.
- Made activity wording less alarming by using `active ...` for short silence and `no activity for ...` only after longer heartbeat silence.
- Improved `/subagents view` as the richer triage surface:
  - header includes count and total cost summary.
  - groups are ordered Needs input, Error, Running, Idle, Done and show group counts.
  - idle/done rows with results show result filename plus usage/cost.
  - `p`, `r`, `s`, `a`, Enter, `R`, and Escape are wired to real actions.
  - stop from running/attention rows requires inline confirmation before dispatching.
  - done rows are bounded with a low-salience overflow line.
  - peek text is sanitized/truncated and no longer prints raw attach commands.
- Tightened view model activity precedence and safety:
  - error causes override stale attention.
  - reply affordance is limited to idle persistent rows or active needs-input rows.
  - path-like text is sanitized in view activity.
- Updated `README.md` and `docs/STRUCTURE.md` to describe the final UI contract and examples.
- Created `agent-work/decks/subagent-visibility-ui.html` as a discussion artifact for the design direction.

## Deferred

- Transition notifications for newly attention-needed or errored children were intentionally deferred to avoid adding notification noise before the widget/view improvements are validated in use.

## Validation

- `npm test` passed with 96 tests.
- `git diff --check` passed.
- Code review found and fixed three issues before commit:
  - `/subagents peek` now sanitizes path-like metadata/task text.
  - errored rows no longer show stale attention messages.
  - reply affordance no longer appears on completed one-shot or stopped/error rows.
