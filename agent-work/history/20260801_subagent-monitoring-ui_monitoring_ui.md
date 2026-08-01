# Subagent Monitoring UI

**Feature:** `subagent-monitoring-ui`

**Completed:** 2026-08-01

## Outcome

Replaced the extension's overlapping summary/details/peek monitoring modes with two complementary surfaces:

1. A quiet, width-aware below-editor widget for ambient triage.
2. One live `/subagents` manager for inspection and action.

The redesign preserves the existing tmux lifecycle, state format, tool API, agent library, tool-card rendering, result capture, and Agent Hub integration.

## Product Decisions

- `/subagents`, `/subagents view`, `alt+s`, and `ctrl+alt+s` open the same manager.
- Removed the user-selectable `show`, `hide`, `details`, `peek`, `on`, and `off` widget modes rather than retaining parallel compatibility behavior.
- The ambient widget has a hard three-row limit and only advertises `/subagents` when rows are hidden.
- The manager refreshes every three seconds, supports immediate in-place refresh with `R`, and preserves selection by child ID when rows reorder.
- Enter performs the selected row's primary workflow:
  - needs input or persistent idle: reply;
  - done: toggle a bounded inline result excerpt;
  - running or error: toggle contextual details.
- Routine states remain neutral. Semantic color is reserved for questions, errors, and selection.
- The ambient widget is hidden while the manager is mounted so the same jobs are not rendered twice.

## Architecture

### Canonical presentation model

`src/view-model.ts` is the single owner of presentation grouping, sorting, detail precedence, primary actions, timestamps, result metadata, capabilities, and usage. Both monitoring surfaces consume `SubagentViewRow` values.

Detail precedence is:

1. Error cause.
2. Explicit child question.
3. Fresh Agent Hub semantic metadata.
4. Latest completed turn preview.
5. Available result filename.
6. Task preview.

### Ambient widget

`src/subagents-widget.ts` renders a capped process ledger using centralized limits and theme roles from `src/ui-tokens.ts`. It derives age from `updatedAt` during rendering rather than storing a frozen label. A parent-owned boundary timer requests renders when displayed age labels should change and is cleared when the widget empties or the session shuts down.

Obsolete summary/peek formatters and mode state were removed from `src/format.ts` and `src/index.ts`. Explicit tool status formatting remains intact.

### Live manager

`src/subagents-view.ts` now owns local selection, detail/result disclosure, stop confirmation, contextual footer state, responsive layout, and render invalidation. Wide layouts retain activity, age, and metrics; narrow layouts prioritize identity while moving full context into the selected detail panel.

Result excerpts are sanitized, width-bounded, line-bounded, and character-bounded. Full result paths remain available through the secondary `o` action.

### Refresh and lifecycle

`src/index.ts` routes parent polling and manager refreshes through one serialized coordinator. The coordinator reads statuses, applies auto-stop and completion retention, refreshes semantic metadata, updates ambient tracking, and returns one canonical row snapshot.

The custom-view lifecycle owns its three-second timer and idempotent disposer. Timers stop on close, action handoff, refresh failure, and session shutdown. Actions requiring Pi dialogs or editor access temporarily leave the custom component; reply, stop, and result-path actions reopen the manager on the same child, while attach prepares the editor command and exits.

## Files

- `src/index.ts` — command simplification, serialized refresh coordination, widget scheduling, manager lifecycle, and action reopen loop.
- `src/view-model.ts` — canonical row projection and detail/action precedence.
- `src/subagents-widget.ts` — responsive ambient widget.
- `src/subagents-view.ts` — responsive live manager and local disclosure workflows.
- `src/ui-tokens.ts` — shared refresh, layout, excerpt, and theme constants.
- `src/format.ts` — removed obsolete summary/peek formatting.
- `test/` — durable behavior and lifecycle regression coverage.
- `README.md` and `docs/STRUCTURE.md` — updated two-surface workflow and architecture.

## Validation

- `npm test`: 101 tests passed.
- `git diff --check`: passed.
- Representative manager/widget rendering is covered at 20, 44, 88, and 120 columns.
- Tests cover contextual Enter behavior, immediate refresh, result sanitization, auto-stop observation, selection preservation, timer disposal, widget suppression while the manager is open, and age updates after active polling stops.

## Preserved Boundaries

No tmux launch, stop cascade, heartbeat, result capture, registry schema, Agent Hub mirror, nested-subagent, or auto-stop semantics changed. The agent library and tool call/result rendering remain separate and unchanged.
