# subagent-agent-view-ux — Agent View UX

## Summary

Implemented an Agent View-inspired management surface for `pi-tmux-subagents` while preserving the compact widget and tmux-native workflows.

Key outcomes:

- Added explicit child attention metadata for Pi `ask_question` tool calls, including deterministic clear behavior on matching tool result or the next agent turn.
- Added per-turn `messagePreview` storage for dashboard/activity summaries.
- Added attention-aware replies so explicit child prompts can be answered while the child heartbeat still reports `running`, without making all busy children replyable.
- Added a shared pure view model for subagent grouping, sorting, activity, result, usage, attach command, and nested lineage metadata.
- Added `/subagents view`, a custom TUI manager grouped by operational state (`Needs input`, `Running`, `Idle`, `Done`, `Error`) with bounded historical rows to avoid crashes on large registries.
- Added `/subagents library`, a read-only browser for discovered Markdown agents with a non-TUI text fallback.
- Added slash actions: `/subagents reply`, `/subagents stop`, `/subagents attach`, `/subagents result`, and `/subagents refresh`.
- Updated the compact below-editor widget to surface explicit `needs input` and advertise `/subagents view` without exposing full paths or tmux commands.
- Kept high-risk single-key destructive actions out of the custom view after live testing showed focused views can capture normal typing; actions remain available through slash commands.
- Added a stronger titled top divider to visually separate `/subagents view` from the main transcript after UX feedback.
- Updated `README.md` and `docs/STRUCTURE.md` with the new commands, state flow, attention semantics, view/library components, and nested lineage behavior.

## Validation

- Baseline `npm test` passed before implementation.
- Final `npm test` passed with 89 tests.
- `git diff --check` passed.
- Smoke-rendered `/subagents view` against a live registry with 4k+ historical jobs; the bounded query rendered quickly and avoided the prior crash/hang.
- Consulted `frontend-designer` and `second-opinion` subagents during planning/implementation. Follow-up Opus UX feedback recommended a top boundary/header, which was implemented.

## Important implementation notes

- `needs input` is intentionally driven only by explicit `heartbeat.attention`; final prose, punctuation, idle state, and pane text do not create attention state.
- `/subagents view` intentionally shows active/error jobs plus a small recent stopped set instead of all historical stopped jobs.
- The custom view now uses safe keyboard controls only: select, enter result/attach, refresh, and close. Reply/stop/attach/result remain available as slash commands.
- Nested children are not rendered as a tree yet, but `parentId` is carried through the view model and shown in peek/details.

## Deferred follow-ups

- True nested tree rendering once nested use is common.
- Optional live refresh inside `/subagents view` with lifecycle-safe timer disposal.
- Agent library create/edit/delete flows.
- Stronger visual polish for selected rows and section boundaries if the Pi TUI host adds more layout primitives.
