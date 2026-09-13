# Functional validation

Validated with Pi 0.85.1, tmux 3.5a, an isolated tmux server/config, isolated subagent and Agent Hub roots, and a deterministic local OpenAI-compatible provider. No paid calls or live state mutations occurred.

- A one-shot child launched through `launchSubagent()` self-closed without a status query after its launcher exited. A second child launched through the real `tmux_subagent` extension survived an actual parent `/reload` and parent termination, then self-closed.
- Reusable timeout `4000` expired. A follow-up at 2.5 seconds changed `idleSince`, remained open beyond the old deadline, and closed after the new deadline. Timeout `0` remained open after 6 seconds.
- Child `/reload` preserved the exact `idleSince` value and the child closed against the original 5-second deadline.
- Deterministic provider error, in-flight abort, and an explicit hanging `ask_question` call all remained alive. The last case published `attention`.
- A settled one-shot parent stayed open while an actual indefinite nested worker session was open. It self-closed on the next heartbeat check after the worker was manually stopped.
- Each checked automatic closure had no tmux session or process, persisted `status: stopped` plus `autoStopped: true`, retained `result.md` and `turns/001-result.md`, and had no isolated Hub row or heartbeat.
- With state-root writes denied after the provider request but before completion, native auto-shutdown still removed the Pi process and tmux session, surfaced the `EACCES` finalization error, and preserved both result files; the stale registry stayed `starting` without `autoStopped`, and the isolated Hub row remained instead of falsely claiming full removal.
- A seeded policy-less legacy job remained byte-for-byte equivalent as a JSON object after all runs.

The temporary harness and isolated sessions were removed after validation.
