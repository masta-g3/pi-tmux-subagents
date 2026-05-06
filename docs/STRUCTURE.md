# pi-tmux-subagents Structure

`pi-tmux-subagents` is a minimal Pi extension that launches Markdown-defined subagents as real tmux-backed Pi sessions.

## Architecture

```mermaid
flowchart TD
  Parent[Parent Pi session] --> Tool[tmux_subagent tool]
  Tool --> Agents[Agent discovery]
  Tool --> State[jobs.json + jobs/id files]
  Tool --> Tmux[tmux new-session]
  Tmux --> Child[Child Pi process]
  Child --> Bootstrap[child-bootstrap extension]
  Bootstrap --> Heartbeat[jobs/id/heartbeat.json]
```

Standalone state is the source of truth. Optional `pi-sessions` compatibility is adapter-based and must not be required for normal operation.

## Lifecycle

Child Pi sessions stay alive after the assigned task completes so the parent can inspect, attach, or ask follow-up questions. Completion is represented as `waiting` after the child has been `running`; use `tmux_subagent({ action: "stop", childId })` when no follow-up is needed. `cancel` remains as a compatibility alias for the same shutdown behavior.

Optional `pi-sessions` mirror rows use the child ID and tmux session name, render under their parent, and keep the left-column label short (`agentName` only). `taskPreview` belongs in metadata/details/filtering, not in the row title.

## Layout

- `agents/` — packaged built-in agents (`scout`, `worker`, `delegate`) loaded at lowest priority.
- `src/index.ts` — Pi extension entry point and `tmux_subagent` tool.
- `src/agents.ts` — Markdown frontmatter discovery for built-in, user, and project agents.
- `src/paths.ts` — state, job, and agent directory path helpers.
- `src/state.ts` — `jobs.json`, per-job metadata, and lock-protected mutation helpers.
- `src/prompt.ts` — child boundary prompt, task contract, Pi CLI argument builder.
- `src/run.ts` — tmux launch/status/cancel/foreground wait behavior.
- `src/tmux.ts` — small tmux command wrapper.
- `src/child-bootstrap.ts` — child-side heartbeat extension.
- `src/pi-sessions-adapter.ts` — optional dashboard compatibility detection/mirroring.
- `test/` — Node test runner tests compiled through TypeScript.

## Development

```bash
npm install
npm test
```

Use temporary `PI_TMUX_SUBAGENTS_DIR` values for manual smoke tests to avoid touching live jobs.
