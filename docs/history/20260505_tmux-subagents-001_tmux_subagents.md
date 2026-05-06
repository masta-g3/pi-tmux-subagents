# tmux-subagents-001 — tmux-backed Pi subagents

## Summary

Created `pi-tmux-subagents`, a standalone Pi extension that launches Markdown-defined subagents as real tmux-backed Pi sessions. The tool is intentionally minimal: it supports agent discovery, `list`/`get`, launch, foreground wait, status, and explicit shutdown via `stop`/`cancel`. It skips chains, worktrees, intercom, fallback model orchestration, and complex scheduling.

## Implemented

- New package at `/Users/manager/code/agents/pi-tmux-subagents` with TypeScript build/test setup and Pi extension metadata.
- `tmux_subagent` tool:
  - `action: "list"` / `"get"` for Markdown agent discovery.
  - Launch with `{ agent, task, background }`.
  - `action: "status"` for heartbeat/result/pane preview.
  - `action: "stop"` plus `"cancel"` alias to shut down child tmux sessions.
- Agent format compatible with existing local Markdown agents: frontmatter `name`, `description`, `model`, `thinking`, `tools`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `maxDepth`, and `disabled`.
- Standalone state under `PI_TMUX_SUBAGENTS_DIR` or `<PI_CODING_AGENT_DIR>/tmux-subagents`:
  - `jobs.json`
  - `jobs/<child-id>/task.md`
  - `jobs/<child-id>/agent-system.md`
  - `jobs/<child-id>/heartbeat.json`
  - `jobs/<child-id>/result.md`
  - `jobs/<child-id>/metadata.json`
- Child bootstrap extension writes standalone heartbeats and optional `pi-sessions` heartbeat metadata.
- Child sessions intentionally stay alive after completion (`waiting` after `running`) so parent/human operators can inspect or follow up; callers stop them explicitly when done.
- Foreground waits return `result.md` when present, otherwise pane preview; dead child tmux sessions are marked `stopped`.
- Recursion guard using `PI_SUBAGENT_DEPTH` and agent `maxDepth`.

## Optional pi-sessions compatibility

Updated `pi-command-center`/`pi-sessions` to support optional mirrored subagent rows without making `pi-tmux-subagents` depend on it:

- `ManagedSession` and `Heartbeat` accept optional `kind`, `parentId`, `agentName`, `taskPreview`, `resultPath`, and `resultSummary` fields.
- Registry mutations can use a lock-protected `updateRegistry` path so mirrored rows are not clobbered by dashboard refresh/session commands.
- Added `src/core/session-tree.ts` to centralize nested visible row order, filtering, and depth.
- Dashboard renders `kind: "subagent"` rows nested under their parent with a short agent-name label; task text stays in details/filtering.
- Disabled normal session lifecycle/group/order actions for subagent rows in the dashboard and command helpers.
- Parent group moves update direct child rows to the same group.

## Validation

- `pi-tmux-subagents`: `npm test` passed with 14 tests.
- `pi-command-center`: `npm test` passed with 197 tests.
- Manual smoke tests covered:
  - local install with `pi install`
  - agent discovery from `~/.pi/agent/agents/*.md`
  - standalone tmux launch/status/stop using a fake child Pi executable
  - optional `pi-sessions` mirrored registry row and heartbeat
  - live smoke agent launch after granting the child `write` tool access for `result.md`

## Durable notes

- Restart already-running parent Pi sessions after rebuilding/installing `pi-tmux-subagents`; extension code is loaded at Pi process start.
- Agent files must start frontmatter at column 1 with `---`.
- If a child must write `result.md`, its agent config needs a write-capable tool policy such as `tools: write`.
