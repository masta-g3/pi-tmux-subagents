**Feature:** tmux-subagents-persistent-followups → Add clean persistent-session follow-up support and per-turn result handling for tmux subagents.

## Summary

Implemented generic persistent child-session support for `pi-tmux-subagents` without adding workflow-specific concepts. The tool now supports public `send` and `wait` actions, turn-aware result capture, latest-result compatibility, timeout handling, and clearer idle status for persistent sessions.

## Implemented

- Added `tmux_subagent` actions:
  - `action: "send"` with `message`, optional `wait`, and optional `timeoutMs`.
  - `action: "wait"` with optional `timeoutMs`.
- Added safe tmux message delivery through named temporary tmux buffers.
- Added per-turn result artifacts:
  - `jobs/<id>/turns/001-result.md`
  - `jobs/<id>/turns/turns.json`
- Kept `jobs/<id>/result.md` as a compatibility alias for the latest completed result.
- Updated status handling so:
  - `result` falls back to legacy `result.md`.
  - `latestResult` reflects only the latest numbered turn result.
  - persistent `waiting` sessions with `autoStopOnComplete: false` render as idle/ready.
  - stopped/error sessions return immediately from waits.
- Preserved explicit `autoStopOnComplete: false` in job metadata.
- Updated README and `docs/STRUCTURE.md` for the new persistent-session control path.

## Review fixes

Code review identified and fixed high-impact issues:

- Preserve explicit `autoStopOnComplete: false` instead of dropping it.
- Make `wait` use a turn boundary so it does not return stale pre-send results.
- Return stopped/error waits immediately even when waiting for a later turn.
- Keep `latestResult` scoped to numbered turn results, not legacy fallback output.
- Protect tmux buffer commands from messages beginning with option-like text.

## Validation

- `npm test` passed with 41 tests.
- Added tests for per-turn result writing, latest-result semantics, send command construction, busy-session rejection, turn-boundary waits, timeout behavior, terminal wait behavior, and persistent idle formatting.
