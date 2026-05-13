**Feature:** tmux-subagents-002 → Render compact parent-session progress summaries for tmux subagent runs

## Summary

Implemented compact plain-text status output for foreground `tmux_subagent` runs and explicit status calls. The output now resembles the concise `pi-subagents` style while preserving this extension's tmux-native identity and lifecycle behavior.

Example shape:

```text
tmux subagent scout
 ✓ scout · done · 2m39s
   ⎿  Done
      <result preview>
   tmux: pi-agent-hub-abc123
   attach: tmux attach-session -t pi-agent-hub-abc123
   output: /path/to/result.md
   stop: tmux_subagent({ action: "stop", childId: "..." })
```

## Decisions

- Kept the implementation to plain text formatting only.
- Did not add token counts, tool-use counts, turn counts, custom renderers, or Pi session log parsing.
- Preserved existing child lifecycle: `waiting` still means the child session remains alive for inspection/follow-up, but it is presented as `done` in parent-facing output.
- Left background launch output unchanged to avoid widening scope.

## Changes

- Added `src/format.ts` with:
  - status glyph/label/title presentation
  - elapsed duration formatting
  - capped result/pane-preview snippets
  - tmux attach, result path, and stop-command lines
- Updated `src/index.ts` to use the shared formatter for foreground updates, final results, and explicit status responses.
- Added `test/format.test.ts` pure formatter coverage for:
  - compact done summary
  - tmux attach/result/stop lines
  - result-over-preview precedence
  - snippet truncation
  - running preview output
- Updated `docs/STRUCTURE.md` to include `src/format.ts`.
- Updated `README.md` with the compact output example.

## Validation

```text
npm test → 18 pass
```

## Discovered Work

None.
