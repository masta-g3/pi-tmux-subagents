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
  Bootstrap --> HubHeartbeat[optional pi-agent-hub heartbeat]
```

Standalone state is the source of truth under `PI_TMUX_SUBAGENTS_DIR`, or `<PI_CODING_AGENT_DIR>/pi-tmux-subagents` when unset. `pi-agent-hub` mirroring is optional and adapter-based; normal operation must not require hub state.

## Lifecycle

Child Pi sessions auto-stop after clean completion by default so completed subagents do not clutter tmux or `pi-agent-hub` dashboards. Completion is represented as `waiting` after the child has been `running`; foreground runs then stop automatically, and background runs stop when a later `status` call observes clean completion. Successful auto-stop also removes the mirrored `pi-agent-hub` subagent row. Pass `autoStopOnComplete: false` to keep a child alive for inspection, attach, or follow-up turns, then use `tmux_subagent({ action: "send", childId, message, wait })`, `tmux_subagent({ action: "wait", childId })`, and finally `tmux_subagent({ action: "stop", childId })` when done. Failed/interrupted sessions stay alive for inspection. `cancel` remains as a compatibility alias for the same shutdown behavior.

Persistent sessions keep per-turn result files under `jobs/<id>/turns/` and update `jobs/<id>/result.md` to the latest completed result for compatibility. Status output prefers the latest turn result and renders persistent waiting sessions as idle/ready rather than one-shot done.

Optional `pi-agent-hub` mirror rows use the child ID and tmux session name, render under their parent, and keep the left-column label short (`agentName` only). `taskPreview` belongs in metadata/details/filtering, not in the row title.

## Layout

- `agents/` — packaged built-in agents (`scout`, `worker`, `delegate`) loaded at lowest priority.
- `src/index.ts` — Pi extension entry point and `tmux_subagent` tool.
- `src/agents.ts` — Markdown frontmatter discovery for built-in, user, and project agents.
- `src/format.ts` — compact plain-text parent-session status/progress text for subagent jobs.
- `src/render.ts` — theme-aware TUI rendering for `tmux_subagent` call/result rows.
- `src/names.ts` — canonical package/runtime names.
- `src/paths.ts` — state, job, turn, result, and agent directory path helpers.
- `src/state.ts` — `jobs.json`, per-job metadata, and lock-protected mutation helpers.
- `src/prompt.ts` — child boundary prompt, task contract, Pi CLI argument builder.
- `src/run.ts` — tmux launch/status/cancel/foreground wait behavior.
- `src/tmux.ts` — small tmux command wrapper, including safe paste/send helpers.
- `src/child-bootstrap.ts` — child-side heartbeat extension; writes per-turn result files plus the latest compatibility `result.md` from final assistant messages.
- `src/pi-agent-hub-adapter.ts` — optional dashboard mirroring detection and cleanup.
- `test/` — Node test runner tests compiled through TypeScript.

## Development

```bash
npm install
npm test
```

Use temporary `PI_TMUX_SUBAGENTS_DIR` values for manual smoke tests to avoid touching live jobs.
