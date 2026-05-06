# pi-tmux-subagents

Minimal Pi extension for launching Markdown-defined subagents as real tmux-backed Pi sessions.

## Install

```bash
cd /Users/manager/code/agents/pi-tmux-subagents
npm install
npm test
pi install /Users/manager/code/agents/pi-tmux-subagents
```

Restart any already-running parent Pi sessions after rebuilding or installing; Pi loads extension code at process start.

## Agent files

User agents are discovered from:

```text
~/.pi/agent/agents/*.md
```

Project agents are opt-in via `agentScope: "project"` or `"both"` and are discovered from the nearest:

```text
.pi/agents/*.md
```

Example:

```md
---
name: scout
description: Fast codebase recon
model: openai-codex/gpt-5.5
thinking: low
tools: read, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are a focused scouting agent. Report findings clearly and stop.
```

## Tool usage

```ts
tmux_subagent({ action: "list" })
tmux_subagent({ action: "get", agent: "scout" })
tmux_subagent({ agent: "scout", task: "Inspect auth flow", background: true })
tmux_subagent({ action: "status", childId: "abc123" })
tmux_subagent({ action: "stop", childId: "abc123" }) // or action: "cancel"
```

Child sessions stay alive after completing so the parent can inspect or follow up. Use `action: "stop"` when no follow-up is needed.

State is stored in `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/tmux-subagents` when unset.

## pi-sessions compatibility

The extension is standalone. When launched from a managed [`pi-sessions`](https://github.com/masta-g3/pi-sessions) parent with explicit `PI_SESSIONS_DIR` and `PI_SESSIONS_SESSION_ID`, it mirrors child rows into the existing `pi-sessions` registry and writes dashboard-compatible heartbeats. Without those env vars, no `pi-sessions` state is created or required.
