import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoStopCompletedSubagent, cleanupCompletedSubagents, launchSubagent, getSubagentStatus, cancelSubagent, sendSubagentAttentionReply, sendSubagentMessage, waitForAnySubagent, waitForSubagent } from "../src/run.js";
import { loadJobs } from "../src/state.js";
import type { AgentConfig } from "../src/types.js";
import type { TmuxExecutor } from "../src/tmux.js";

const agent: AgentConfig = {
  name: "scout",
  description: "Scout",
  source: "user",
  filePath: "/tmp/scout.md",
  systemPrompt: "You scout.",
  systemPromptMode: "replace",
  inheritProjectContext: true,
  inheritSkills: false,
  maxDepth: 0,
  tools: "none",
};

test("launchSubagent creates standalone job and tmux session", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-run-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };

  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, displayName: "scout-auth", tmux });

  assert.equal(job.agentName, "scout");
  assert.equal(job.displayName, "scout-auth");
  assert.match(job.tmuxSession, /^pi-tmux-subagents-/);
  assert.equal((await loadJobs(root)).jobs.length, 1);
  assert.equal(calls[0]?.[0], "new-session");
  assert.match(calls[0]?.at(-1) ?? "", /PI_TMUX_SUBAGENTS_JOB_ID=/);
  assert.match(calls[0]?.at(-1) ?? "", /PI_SUBAGENT_DISPLAY_NAME='scout-auth'/);
  assert.match(calls[0]?.at(-1) ?? "", /PI_AGENT_HUB_SESSION_ID=''/);
  assert.match(calls[0]?.at(-1) ?? "", /--extension/);
}));

test("launchSubagent passes nested subagent policy to child sessions", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-nested-launch-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };

  const job = await launchSubagent({
    stateRoot: root,
    cwd: root,
    agent,
    task: "Review auth",
    background: true,
    allowNestedSubagents: true,
    nestedAgentAllowlist: ["code-critic", "plan-critic"],
    maxNestedDepth: 1,
    tmux,
  });

  const command = calls[0]?.at(-1) ?? "";
  assert.equal(job.allowNestedSubagents, true);
  assert.deepEqual(job.nestedAgentAllowlist, ["code-critic", "plan-critic"]);
  assert.equal(job.maxNestedDepth, 1);
  assert.match(command, /PI_TMUX_SUBAGENTS_NESTED_ALLOWLIST='code-critic,plan-critic'/);
  assert.match(command, /PI_TMUX_SUBAGENTS_MAX_NESTED_DEPTH='1'/);
  assert.match(command, /'--tools' 'tmux_subagent'/);
}));

test("launchSubagent persists auto-stop preference", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-launch-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });

  const enabled = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux });
  const disabled = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: false, tmux });
  const jobs = (await loadJobs(root)).jobs;

  assert.equal(enabled.autoStopOnComplete, true);
  assert.equal(disabled.autoStopOnComplete, false);
  assert.equal(jobs.find((job) => job.id === enabled.id)?.autoStopOnComplete, true);
  assert.equal(jobs.find((job) => job.id === disabled.id)?.autoStopOnComplete, false);
}));

test("getSubagentStatus reads heartbeat result and pane preview", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-status-test-"));
  const tmux: TmuxExecutor = async (args) => {
    if (args[0] === "capture-pane") return { stdout: "pane preview", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "done", "utf8");

  const status = await getSubagentStatus(root, job.id.slice(0, 8), tmux);
  assert.equal(status.status, "waiting");
  assert.equal(status.result, "done");
  assert.equal(status.preview, "pane preview");
}));

test("getSubagentStatus keeps latestResult scoped to turn results", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-legacy-status-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "result.md"), "legacy", "utf8");

  const status = await getSubagentStatus(root, job.id, tmux);

  assert.equal(status.result, "legacy");
  assert.equal(status.latestResult, undefined);
}));

test("getSubagentStatus prefers latest turn result", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-turn-status-test-"));
  const tmux: TmuxExecutor = async (args) => {
    if (args[0] === "capture-pane") return { stdout: "pane preview", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  const turnsDir = join(jobDir, "turns");
  await mkdir(turnsDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "latest", "utf8");
  await writeFile(join(turnsDir, "001-result.md"), "turn one", "utf8");
  await writeFile(join(turnsDir, "turns.json"), JSON.stringify({
    version: 1,
    turns: [{ index: 1, status: "waiting", startedAt: 2, completedAt: 3, resultPath: join(turnsDir, "001-result.md") }],
  }), "utf8");

  const status = await getSubagentStatus(root, job.id, tmux);

  assert.equal(status.latestTurn?.index, 1);
  assert.equal(status.latestResult, "turn one");
  assert.equal(status.result, "turn one");
}));

test("getSubagentStatus marks missing tmux sessions stopped", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-missing-test-"));
  const tmux: TmuxExecutor = async (args) => {
    if (args[0] === "has-session") throw new Error("missing");
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });

  const status = await getSubagentStatus(root, job.id, tmux);

  assert.equal(status.status, "stopped");
  assert.equal((await loadJobs(root)).jobs[0]?.status, "stopped");
  assert.equal(status.preview, undefined);
}));

test("autoStopCompletedSubagent stops clean completed jobs and preserves done result", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    if (args[0] === "capture-pane") return { stdout: "pane preview", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "done", "utf8");

  const status = await autoStopCompletedSubagent(root, await getSubagentStatus(root, job.id, tmux), tmux);

  assert.equal(status.status, "waiting");
  assert.equal(status.result, "done");
  assert.equal(status.autoStopped, true);
  assert.equal((await loadJobs(root)).jobs[0]?.status, "stopped");
  assert.equal(calls.at(-1)?.[0], "kill-session");
}));

test("autoStopCompletedSubagent removes mirrored pi-agent-hub rows after clean completion", async () => withAgentHub(async (hubDir) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-mirror-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  await writeFile(join(hubDir, "registry.json"), JSON.stringify({
    version: 1,
    sessions: [{ id: "parent-1", title: "parent", cwd: root, group: "default", tmuxSession: "pi-agent-hub-parent", status: "running", createdAt: 1, updatedAt: 1 }],
  }), "utf8");
  process.env.PI_AGENT_HUB_SESSION_ID = "parent-1";

  const calls: string[][] = [];
  const recordingTmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return tmux(args);
  };

  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux: recordingTmux });
  const launchedRegistry = JSON.parse(await readFile(join(hubDir, "registry.json"), "utf8"));
  assert.match(job.tmuxSession, /^pi-agent-hub-/);
  assert.ok(launchedRegistry.sessions.some((session: { id: string }) => session.id === job.id));
  assert.match(calls[0]?.at(-1) ?? "", new RegExp(`PI_AGENT_HUB_SESSION_ID='${job.id}'`));
  const hubHeartbeat = join(hubDir, "heartbeats", `${job.id}.json`);
  await mkdir(join(hubDir, "heartbeats"), { recursive: true });
  await writeFile(hubHeartbeat, JSON.stringify({ managedSessionId: job.id, state: "waiting" }), "utf8");
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "done", "utf8");

  const status = await autoStopCompletedSubagent(root, await getSubagentStatus(root, job.id, tmux), tmux);
  const registry = JSON.parse(await readFile(join(hubDir, "registry.json"), "utf8"));

  assert.equal(status.autoStopped, true);
  assert.deepEqual(registry.sessions.map((session: { id: string }) => session.id), ["parent-1"]);
  assert.equal(existsSync(hubHeartbeat), false);
}));

test("cancelSubagent cascades to nested child jobs and removes hub mirror rows", async () => withAgentHub(async (hubDir) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-cascade-cancel-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await writeFile(join(hubDir, "registry.json"), JSON.stringify({
    version: 1,
    sessions: [{ id: "main-1", title: "main", cwd: root, group: "default", tmuxSession: "pi-agent-hub-main", status: "running", createdAt: 1, updatedAt: 1 }],
  }), "utf8");
  await mkdir(join(hubDir, "heartbeats"), { recursive: true });

  process.env.PI_AGENT_HUB_SESSION_ID = "main-1";
  const parent = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Parent", background: true, autoStopOnComplete: false, tmux });
  process.env.PI_AGENT_HUB_SESSION_ID = parent.id;
  const child = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Child", background: true, autoStopOnComplete: true, tmux });
  await writeFile(join(hubDir, "heartbeats", `${parent.id}.json`), JSON.stringify({ managedSessionId: parent.id, state: "waiting" }), "utf8");
  await writeFile(join(hubDir, "heartbeats", `${child.id}.json`), JSON.stringify({ managedSessionId: child.id, state: "waiting" }), "utf8");

  await cancelSubagent(root, parent.id, tmux);

  const registry = JSON.parse(await readFile(join(hubDir, "registry.json"), "utf8"));
  const jobs = await loadJobs(root);
  assert.deepEqual(registry.sessions.map((session: { id: string }) => session.id), ["main-1"]);
  assert.equal(jobs.jobs.find((job) => job.id === parent.id)?.status, "stopped");
  assert.equal(jobs.jobs.find((job) => job.id === child.id)?.status, "stopped");
  assert.equal(existsSync(join(hubDir, "heartbeats", `${parent.id}.json`)), false);
  assert.equal(existsSync(join(hubDir, "heartbeats", `${child.id}.json`)), false);
  assert.deepEqual(calls.filter((args) => args[0] === "kill-session").map((args) => args.at(-1)), [child.tmuxSession, parent.tmuxSession]);
}));

test("autoStopCompletedSubagent returns result and warning when stop fails", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-fail-test-"));
  const tmux: TmuxExecutor = async (args) => {
    if (args[0] === "kill-session") throw new Error("tmux session disappeared");
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "done", "utf8");

  const status = await autoStopCompletedSubagent(root, await getSubagentStatus(root, job.id, tmux), tmux);

  assert.equal(status.status, "waiting");
  assert.equal(status.result, "done");
  assert.equal(status.autoStopped, undefined);
  assert.match(status.autoStopError ?? "", /tmux session disappeared/);
  assert.equal((await loadJobs(root)).jobs[0]?.status, "waiting");
}));

test("autoStopCompletedSubagent leaves non-completed jobs alive", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-running-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux });

  const status = await autoStopCompletedSubagent(root, await getSubagentStatus(root, job.id, tmux), tmux);

  assert.equal(status.status, "starting");
  assert.equal(status.autoStopped, undefined);
  assert.notEqual(calls.at(-1)?.[0], "kill-session");
}));

test("cleanupCompletedSubagents auto-stops completed default children and reports persistent idle ones", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-cleanup-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const auto = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Auto", background: true, autoStopOnComplete: true, tmux });
  const persistent = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Persistent", background: true, autoStopOnComplete: false, tmux });
  for (const job of [auto, persistent]) {
    const jobDir = join(root, "jobs", job.id);
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
      jobId: job.id,
      cwd: root,
      state: "waiting",
      stateSince: 2,
      updatedAt: 3,
      seenRunning: true
    }), "utf8");
  }

  const result = await cleanupCompletedSubagents(root, tmux);
  const jobs = await loadJobs(root);

  assert.equal(result.autoStopped.length, 1);
  assert.equal(result.autoStopped[0]?.job.id, auto.id);
  assert.equal(result.idlePersistent.length, 1);
  assert.equal(result.idlePersistent[0]?.job.id, persistent.id);
  assert.equal(jobs.jobs.find((job) => job.id === auto.id)?.status, "stopped");
  assert.equal(jobs.jobs.find((job) => job.id === persistent.id)?.status, "waiting");
  assert.ok(calls.some((args) => args[0] === "kill-session" && args.at(-1) === auto.tmuxSession));
  assert.equal(calls.some((args) => args[0] === "kill-session" && args.at(-1) === persistent.tmuxSession), false);
}));

test("sendSubagentMessage bracket-pastes multiline messages into idle live sessions", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-send-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");

  await sendSubagentMessage(root, job.id, "hello 'there'\nsecond line", tmux);

  const sendCalls = calls.filter((args) => ["set-buffer", "paste-buffer", "send-keys", "delete-buffer"].includes(args[0] ?? ""));
  const bufferName = sendCalls[0]?.[2];
  assert.match(bufferName ?? "", /^pi-tmux-subagents-/);
  assert.deepEqual(sendCalls, [
    ["set-buffer", "-b", bufferName, "--", "hello 'there'\nsecond line"],
    ["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job.tmuxSession],
    ["send-keys", "-t", job.tmuxSession, "Enter"],
    ["delete-buffer", "-b", bufferName],
  ]);
}));

test("sendSubagentAttentionReply allows explicit attention while running", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-send-attention-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "running",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true,
    attention: { kind: "question", message: "Choose path", updatedAt: 3, toolCallId: "ask-1" },
  }), "utf8");

  await sendSubagentAttentionReply(root, job.id, "Use option A", tmux);

  assert.ok(calls.some((args) => args[0] === "set-buffer" && args.includes("Use option A")));
}));

test("sendSubagentMessage rejects busy sessions", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-send-busy-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "running",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");

  await assert.rejects(() => sendSubagentMessage(root, job.id, "hello", tmux), /busy subagent/);
}));

test("waitForSubagent can wait for a later completed turn", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-wait-turn-test-"));
  let calls = 0;
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(join(jobDir, "turns"), { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");

  const status = await waitForSubagent(root, job.id, tmux, {
    afterTurnIndex: 0,
    intervalMs: 1,
    timeoutMs: 100,
    onUpdate() {
      calls += 1;
      if (calls === 1) {
        const resultPath = join(jobDir, "turns", "001-result.md");
        writeFileSync(resultPath, "done", "utf8");
        writeFileSync(join(jobDir, "turns", "turns.json"), JSON.stringify({
          version: 1,
          turns: [{ index: 1, status: "waiting", startedAt: 2, completedAt: 3, resultPath }],
        }), "utf8");
      }
    },
  });

  assert.equal(status.latestTurn?.index, 1);
  assert.equal(status.result, "done");
}));

test("waitForSubagent returns already waiting sessions without requiring a future turn", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-wait-already-done-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  const turnsDir = join(jobDir, "turns");
  const resultPath = join(turnsDir, "001-result.md");
  await mkdir(turnsDir, { recursive: true });
  await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
    jobId: job.id,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(resultPath, "done", "utf8");
  await writeFile(join(turnsDir, "turns.json"), JSON.stringify({
    version: 1,
    turns: [{ index: 1, status: "waiting", startedAt: 2, completedAt: 3, resultPath }],
  }), "utf8");

  const status = await waitForSubagent(root, job.id, tmux, { intervalMs: 1, timeoutMs: 100 });

  assert.equal(status.status, "waiting");
  assert.equal(status.latestTurn?.index, 1);
  assert.equal(status.result, "done");
}));

test("waitForAnySubagent returns the first active child that completes", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-wait-any-test-"));
  let updates = 0;
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const first = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "First", background: true, tmux });
  const second = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Second", background: true, tmux });
  for (const job of [first, second]) {
    const jobDir = join(root, "jobs", job.id);
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "heartbeat.json"), JSON.stringify({
      jobId: job.id,
      cwd: root,
      state: "running",
      stateSince: 2,
      updatedAt: 3,
      seenRunning: true
    }), "utf8");
  }

  const status = await waitForAnySubagent(root, tmux, {
    intervalMs: 1,
    timeoutMs: 100,
    onUpdate() {
      updates += 1;
      if (updates === 1) {
        writeFileSync(join(root, "jobs", second.id, "heartbeat.json"), JSON.stringify({
          jobId: second.id,
          cwd: root,
          state: "waiting",
          stateSince: 4,
          updatedAt: 5,
          seenRunning: true
        }), "utf8");
      }
    },
  });

  assert.equal(status.job.id, second.id);
  assert.equal(status.status, "waiting");
}));

test("waitForSubagent returns stopped sessions without waiting for a new turn", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-wait-stopped-test-"));
  const tmux: TmuxExecutor = async (args) => {
    if (args[0] === "has-session") throw new Error("missing");
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });

  const status = await waitForSubagent(root, job.id, tmux, { afterTurnIndex: 1, intervalMs: 1, timeoutMs: 100 });

  assert.equal(status.status, "stopped");
}));

test("waitForSubagent timeout leaves child alive", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-wait-timeout-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });

  await assert.rejects(() => waitForSubagent(root, job.id, tmux, { afterTurnIndex: 0, intervalMs: 1, timeoutMs: 1 }), /Timed out/);
  assert.equal(calls.some((args) => args[0] === "kill-session"), false);
}));

test("cancelSubagent kills tmux and marks job stopped", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-cancel-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });

  const stopped = await cancelSubagent(root, job.id, tmux);
  assert.equal(stopped.status, "stopped");
  assert.equal(calls.at(-1)?.[0], "kill-session");
}));

async function withNoAgentHub(fn: () => Promise<void>): Promise<void> {
  const oldDir = process.env.PI_AGENT_HUB_DIR;
  const oldId = process.env.PI_AGENT_HUB_SESSION_ID;
  delete process.env.PI_AGENT_HUB_DIR;
  delete process.env.PI_AGENT_HUB_SESSION_ID;
  try {
    await fn();
  } finally {
    if (oldDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = oldDir;
    if (oldId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = oldId;
  }
}

async function withAgentHub(fn: (hubDir: string) => Promise<void>): Promise<void> {
  const oldDir = process.env.PI_AGENT_HUB_DIR;
  const oldId = process.env.PI_AGENT_HUB_SESSION_ID;
  const hubDir = mkdtempSync(join(tmpdir(), "pi-agent-hub-mirror-test-"));
  process.env.PI_AGENT_HUB_DIR = hubDir;
  delete process.env.PI_AGENT_HUB_SESSION_ID;
  try {
    await fn(hubDir);
  } finally {
    if (oldDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = oldDir;
    if (oldId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = oldId;
  }
}
