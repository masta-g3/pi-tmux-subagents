# subagent-peek-observability

Implemented optional `/subagents peek` observability for tmux subagents.

## Implemented

- Added `src/session-summary.ts` to read fresh `pi-session-summary` metadata from Agent Hub state when available.
- Added `formatSubagentPeekWidget(statuses, summaries?)` to render the existing per-child table with task, fresh summary, and result basename detail lines.
- Added `/subagents peek` command support while keeping `/subagents`, `/subagents show`, `/subagents hide`, `alt+s`, and `ctrl+alt+s` behavior intact.
- Made summary reads best-effort and freshness-filtered.
- Kept `pi-tmux-subagents` read-only with respect to semantic summaries: no model calls, no pane scraping, and no raw prompt/output persistence.

## Verification

- Added session summary parsing tests for valid metadata, missing/invalid/stale files, control states, and disabled Agent Hub env.
- Added formatter tests for peek task/summary/result rendering and stale summary suppression.
- Ran full test suite successfully during the implementation sequence.
