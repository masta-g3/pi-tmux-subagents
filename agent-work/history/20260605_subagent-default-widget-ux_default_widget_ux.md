# subagent-default-widget-ux

Implemented an adaptive default below-editor widget for `pi-tmux-subagents` that answers what visible subagents are doing while keeping the UI compact and single-slot.

## Implemented

- Replaced the count-only default widget with adaptive summary mode:
  - single visible child renders a compact card with status, activity, usage, task, and optional fresh summary.
  - multiple visible children render a capped tree/list ordered by severity and activity.
- Added explicit `task:`, `summary:`, and terminal `result:` detail labels plus a subtle bottom hint/separator for `/subagents details` and `/subagents peek`.
- Added read-only `pi-session-summary` integration:
  - reads `${PI_AGENT_HUB_DIR}/session-summary/<child-id>.json` when available.
  - validates source/version/state/freshness.
  - suppresses stale/control summaries.
  - never generates summaries, calls a model, scrapes panes, or stores raw prompts/output.
- Added summary cache refresh and expiry timers so stale summaries disappear even for idle children that no longer poll.
- Added brief parent-local retention for clean auto-stopped completions so they stay visible for about 10 seconds, then clear without keeping polling alive.
- Kept `/subagents` details mode and added/kept `/subagents peek` as opt-in modes sharing the same below-editor widget slot.
- Centralized widget tone mapping in `src/index.ts` while keeping formatter output plain text and testable.
- Sanitized widget task/summary detail lines to avoid full paths and other forbidden default UI content.

## Verification

- Added formatter tests for single-child cards, multi-child capped rows, summary freshness, hidden forbidden content, and peek details.
- Added parent UI tests for widget command modes, theme binding, retained completion expiry, and stale summary expiry while idle.
- Ran `npm test` successfully: 73 tests passed.
- Ran `git diff --check` and residue scan successfully.
- Live-smoked launched one and multiple subagents after reload; user approved the general layout and requested the final label/separator tweak.

## Documentation

- Updated `README.md` with adaptive widget examples, detail/peek commands, summary/task behavior, and completion retention.
- Updated `docs/STRUCTURE.md` with parent widget modes, summary reader behavior, timers, and `src/session-summary.ts`.
