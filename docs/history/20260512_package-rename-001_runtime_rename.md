# package-rename-001 — pi-tmux-subagents runtime rename

Completed: 2026-05-12

## Summary

Renamed remaining runtime/internal identifiers to the canonical `pi-tmux-subagents` name. The package/tool/env surface remains intentionally small: package name stays `pi-tmux-subagents`, tool name stays `tmux_subagent`, and `PI_TMUX_SUBAGENTS_*` env vars remain unchanged. Before the first public npm release, pre-publication legacy state migration was removed so v0.1.0 ships without backward-compatibility code for private local state.

## Implemented

- Added `src/names.ts` for canonical runtime names.
- Changed the default state root to `<PI_CODING_AGENT_DIR>/pi-tmux-subagents`.
- Changed parent status key to `pi-tmux-subagents`.
- Changed standalone tmux session names to `pi-tmux-subagents-*`.
- Kept mirrored `pi-agent-hub-*` tmux names for dashboard integration.
- Updated README and structure docs with the canonical default state root.
- Updated tests and fixtures for canonical naming and process env isolation.

## Public Release Cleanup

- Removed pre-publication legacy migration code and tests.
- Removed migration-only constants and adapter helpers.
- Kept `PI_TMUX_SUBAGENTS_DIR` as the only state-root override.

## Verification

- `npm test` passed during implementation.
- `npm pack --dry-run` passed during implementation.
