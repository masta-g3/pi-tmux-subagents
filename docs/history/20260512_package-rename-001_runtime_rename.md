# package-rename-001 — pi-tmux-subagents runtime rename

Completed: 2026-05-12

## Summary

Renamed remaining runtime/internal identifiers to the canonical `pi-tmux-subagents` name while preserving existing local state with a one-time migration. The package/tool/env surface remains intentionally small: package name stays `pi-tmux-subagents`, tool name stays `tmux_subagent`, and `PI_TMUX_SUBAGENTS_*` env vars remain unchanged.

## Implemented

- Added `src/names.ts` for canonical runtime names and migration-only old names.
- Changed the default state root from `<PI_CODING_AGENT_DIR>/tmux-subagents` to `<PI_CODING_AGENT_DIR>/pi-tmux-subagents`.
- Changed parent status key to `pi-tmux-subagents`.
- Changed new standalone tmux session names from `pi-tmux-subagent-*` to `pi-tmux-subagents-*`.
- Added `src/migration.ts` to migrate the old default root to the new one, create a best-effort symlink for live child processes, rewrite stored job/result metadata, and safely rename live non-mirrored tmux sessions when possible.
- Preserved mirrored `pi-sessions-*` tmux names and added best-effort mirror row `resultPath` rewrites.
- Updated README and structure docs with the new default state root and migration behavior.
- Updated tests and fixtures for canonical naming, migration behavior, tmux lookup failure safety, and process env isolation.

## Review Fixes

- Made tmux migration safer: a broken `tmux` lookup no longer rewrites stored sessions as if the old session were absent.
- Isolated `PI_CODING_AGENT_DIR`, `PI_TMUX_SUBAGENTS_DIR`, `PI_SESSIONS_DIR`, and `PI_SESSIONS_SESSION_ID` in extension tests that invoke startup/tool execution.
- Removed the proposed `AGENTS.md` guidance as unnecessary bloat.

## Verification

- `npm test` passed: 37/37 tests.
- `npm pack --dry-run` passed.
- Stale-name grep checks passed, with remaining old names limited to migration constants/tests/docs.
