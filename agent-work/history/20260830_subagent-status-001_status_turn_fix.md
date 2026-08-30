# Status Turn Abort

**Feature:** `subagent-status-001`
**Completed:** 2026-08-30
**Worktree:** none

## Outcome

Global `tmux_subagent({ action: "status", includeStopped: true })` now returns a valid result after background launches instead of leaving an orphaned tool call that requires the user to send `continue`.

The public status API and full-history behavior remain unchanged.

## Cause

Full-history status hydrated every historical job with `getSubagentStatus()` in one `Promise.all()`. That path parsed heartbeat and turn JSON, read result files, and invoked tmux for every stopped job. One failed read rejected the complete status call. Child heartbeat and turn-registry JSON also used direct final-path writes, so readers could observe incomplete JSON during concurrent updates.

## Implementation

- `src/index.ts`
  - Projects stopped history rows directly from saved registry state.
  - Hydrates only non-stopped jobs through canonical live status reads.
  - Falls back to saved state for an unreadable live child and returns a compact warning plus structured warning details.
- `src/child-bootstrap.ts`
  - Publishes local heartbeats, mirrored Agent Hub heartbeats, and turn registries through uniquely named sibling files followed by same-filesystem atomic rename.
  - Cleans up temporary files without changing Markdown result-file behavior.
- `test/index.test.ts`
  - Covers 200 stopped history rows without stopped-job tmux calls.
  - Covers partial global results when an active heartbeat is malformed.
- `test/child-bootstrap.test.ts`
  - Uses concurrent readers and overlapping lifecycle writes to prove control JSON is never partially visible and temporary files do not leak.
  - Keeps shutdown inside the isolated environment so test state cannot reach a live Agent Hub heartbeat.

## Documentation

- `README.md` documents that global status returns saved state with a warning when a live child cannot be refreshed.
- `docs/STRUCTURE.md` documents lightweight stopped-history projection, best-effort live refresh, and atomic child control-record publication.

## Review

The code review found one test-isolation issue: deferred child shutdown ran after environment restoration and could write test state to a live Agent Hub heartbeat. Shutdown now runs in an inner `finally` block before restoration. The second code-critic pass returned `LGTM`.

The docs review removed internal stopped-row hydration detail from the user guide while retaining the user-facing fallback contract.

## Validation

- `npm test`: 107 tests passed.
- Focused concurrent JSON publication test passed.
- Isolated smoke test returned 201 statuses in the same turn with only 5 tmux calls.
- `git diff --check`: passed.
