# Idle child cleanup

- Feature: `subagent-status-002`
- Completed: 2026-09-12
- Branch: `main`; no worktree

## Outcome

New children own automatic closure without a live parent or status query. One-shot children close after successful settlement and result publication. Reusable children default to 15 continuously idle minutes; launch-only `idleTimeoutMs: 0` disables expiry. New work cancels the deadline, a later success starts a fresh window, and child reload preserves it.

Running, failed, aborted, input-waiting children and result-write failures remain open. A finished child waits for all live descendants. Automatic closure finalizes only itself; manual stop retains descendant cascading. Results remain on disk. Existing jobs without the persisted lifetime policy receive no policy backfill or new automatic cleanup.

## Implementation and decisions

- Reused the child heartbeat interval and native Pi shutdown. Removed parent automatic-stop functions, cleanup sweeps, wrappers and obsolete result fields. Added no service, idle timer, dependency or registry.
- Shared locked job finalization and Hub removal with manual cancellation. Automatic teardown drains heartbeat writes, persists `stopped` and `autoStopped`, then removes the Hub row and heartbeat.
- Descendant checks use actual tmux session names. Query failures block closure and retry on a later heartbeat; they do not imply workers are gone.
- Native shutdown cannot be cancelled. The user approved best-effort teardown: file or permission failures can leave stale records requiring explicit cleanup.
- Parent polling observes finite idle windows and retains completion once. A live new-policy child's reload shutdown heartbeat is not terminal. Child eligibility uses `autoStopped`, not observer-written status. Changed and unchanged status observations preserve concurrent finalization.

## Verification and review

- Baseline: 113/113 tests passed. Final reviewed build and suite: 124/124 passed. `git diff --check` passed.
- Regression tests reproduced and fixed reload deadline loss, premature parent polling termination, and missing concurrent completion markers. Coverage includes protected states, follow-up races, descendant-query recovery, result and teardown failures, manual-finalization races and legacy policy boundaries.
- Isolated real Pi 0.85.1/tmux 3.5a checks passed with a deterministic local provider. Verified parent exit/reload independence, child reload, finite expiry and reset, indefinite mode, protected failures/input, descendant protection, process exit, record cleanup and retained results. Injected native teardown permission failure also exited and reported incomplete cleanup correctly.
- Functional details remain in `agent-work/tickets/subagent-status-002/validation.md`. Temporary providers, scripts, sessions and outputs were removed; live jobs were not used for testing.
- Three code-critic passes ended in LGTM. Approved reflection updated `README.md` and `docs/STRUCTURE.md`; docs-critic returned LGTM. The isolated-build layout warning moved into developer guidance, so its temporary papercut note was removed.

No discovered tickets or unresolved blockers. Cleanup of existing inactive jobs remains outside this ticket.
