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

The package ships with three built-in agents:

- `scout` — fast read-only codebase recon, pinned to `openai-codex/gpt-5.4-mini`.
- `worker` — focused implementation agent, pinned to `openai-codex/gpt-5.5`.
- `delegate` — lightweight general helper that inherits the parent model.

User agents are discovered from:

```text
~/.pi/agent/agents/*.md
```

User/project agents with the same name override built-ins. Project agents are opt-in via `agentScope: "project"` or `"both"` and are discovered from the nearest:

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
tmux_subagent({ agent: "code-critic", task: "Review these files" }) // auto-stops after clean completion by default
tmux_subagent({ agent: "scout", task: "Keep alive for follow-up", autoStopOnComplete: false })
tmux_subagent({ action: "status", childId: "abc123" })
tmux_subagent({ action: "stop", childId: "abc123" }) // or action: "cancel"
```

Child sessions auto-stop after clean completion by default so completed subagents do not clutter tmux or `pi-agent-hub` dashboards. Pass `autoStopOnComplete: false` when you want to inspect, attach, or ask follow-up questions after completion, then use `action: "stop"` when done. Auto-stop only applies after clean completion; failed or interrupted sessions stay alive for inspection. Background jobs auto-stop when a later `status` call observes clean completion.

Foreground runs and explicit status calls render a compact parent-session summary:

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

State is stored in `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/pi-tmux-subagents` when unset. On first run after upgrading, the old default `<PI_CODING_AGENT_DIR>/tmux-subagents` directory is moved to the new default and replaced with a symlink when possible so already-running children can keep writing heartbeats/results.

## pi-agent-hub integration

The extension is standalone. When launched from a managed `pi-agent-hub` parent with `PI_AGENT_HUB_DIR` and `PI_AGENT_HUB_SESSION_ID`, it mirrors child rows into the hub registry and writes dashboard-compatible heartbeats. Without those env vars, no hub state is created or required.
