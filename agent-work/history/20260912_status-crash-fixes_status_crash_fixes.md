# Status crash fixes

Completed 2026-09-12. Untracked task; no feature registry entry or worktree.

## Outcome

Fixed three confirmed reliability defects without redesigning the status system:

- Parent background refresh failures stop polling and report an error instead of escaping as unhandled rejections. Status reads reject malformed usage before rendering.
- Child completion and result capture use Pi's native `agent_settled` event with idle checks. Failed or aborted runs and result-write failures remain alive as errors. Agent Hub retains the failure message and clears its mirrored error when the child runs again.
- Child heartbeat writes run in order, preventing stale snapshots from overwriting newer states. Periodic write failures stop the heartbeat timer and notify the child.

The package requires Pi >=0.80.5 and Node >=22.19.0. Development dependencies use Pi/TUI 0.85.1. README and architecture guidance cover requirements, completion boundaries, update activation, and background error recovery.

## Validation

- Regression tests reproduced the refresh crash, malformed usage, premature completion, heartbeat ordering, and missing mirrored error before their fixes.
- Final `npm test`: 113 tests passed. `git diff --check`: passed.
- Isolated functional tests used real Pi 0.85.1, tmux 3.5a, and a deterministic local provider. Verified automatic continuation, successful result capture and auto-stop, failed/aborted child preservation, and malformed-usage isolation. Provider retry itself was not exercised.
- No paid model calls or live-state access in functional tests. Temporary scripts and test sessions were removed.
- Final code-critic and docs-critic passes: LGTM.
