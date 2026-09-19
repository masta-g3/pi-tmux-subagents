# Subagent efficiency and saved-session resume

- **Feature:** `subagent-efficiency-001`
- **Branch:** `subagent-efficiency-001`
- **Worktree:** `agent-work/worktrees/subagent-efficiency-001/pi-tmux-subagents`
- **Base:** local `main` at `20f4e9b`; **PR target:** `main`

## Delivered

- Emit explicit `--thinking`, including `off` without a model. Recognized model thinking suffixes take precedence; unrelated colons remain unchanged.
- Mark new children for lifetime accounting from persisted Pi session entries, including reported retry, error, tool, compaction, and branch-summary usage. Preserve latest-run deltas through reload; label legacy and mixed totals accurately. Heartbeat timers do not recompute session totals.
- Add explicit `resume` with a required follow-up message. Preserve child/session identity, conversation, result numbering, saved configuration, and lifetime usage. Transfer ownership to the resuming parent; enforce nested ownership, allowlist, and depth limits. Missing saved metadata causes an error rather than historical discovery or a fresh conversation.
- Serialize resume claims, spawn, stop, result publication, and Hub mutations with the existing state lock. Execution identities reject stale writers and observations. Pending claims require explicit stop after an interrupted launcher; no automatic replay. Resume waits require a fresh result from the requested execution.
- Batch status observations around shared registry reads. Ordinary polling skips pane capture and result-body reads. The manager hydrates only an explicitly expanded result and discards stale asynchronous responses.
- Update caller guidance and README/structure docs for reusable children, bounded waits, usage scope, and resume. Preserve one-shot auto-stop, reusable idle expiry, scheduling, and timeout defaults.

## Verification

- Baseline: `npm ci`, then **124/124 tests passed**.
- Final review: `npm test` (TypeScript build and Node tests), **154/154 passed**, no failures or skips. `git diff --check` passed.
- Real tmux regression with a deterministic Pi fixture covers launch → send → stop → resume, exact saved-session continuity, single follow-up submission, result numbering, usage totals, and one-shot auto-close. No paid provider calls were used for testing.
- A 7,300-job fixture verifies a stable 20-child page uses two shared registry reads, no result-body reads, and no pane captures.
- Race and failure coverage includes competing resumes, poll/stop during spawn, stale publication, reload baselines, missing configuration/session identity, tmux query errors, failed spawn and explicit retry, nested authorization, Hub transfers, early exit, and replacement executions.
- Minimum Pi 0.80.5 API compatibility checked; reasoning uses `pi.getThinkingLevel()`.

## Review and reflection

Review corrected resume waits that could return an old result after an early exit. Regression tests bind completion to the resumed execution. Focused second code-critic pass: **PASS**.

Retained publication and mirror locks to prevent stale overwrites and ownership races. Retained manager metadata reads needed for results and usage; global-status stopped-history projection remains lightweight.

Reflection required no further documentation changes: existing operator guidance and regression tests cover the relevant behavior. Temporary fixtures/processes were removed; durable integration tests remain.

## Boundaries and deferred work

No provider/cache changes, dependency additions, UI redesign, historical usage migration, automatic resume/retry, or history pruning. No original-checkout implementation changes or unapproved integration of its later `aa4b896` commit.

Separate future work, if requested: investigate provider cache misses, legacy usage/session discovery, manager resume controls, history storage/pruning, or heartbeat-lock scaling without weakening publication safety.
