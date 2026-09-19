import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_IDLE_TIMEOUT_MS, cancelSubagent, finalizeStoppedSubagents, getSubagentStatus, hasOpenDescendants, launchSubagent, sendSubagentAttentionReply, sendSubagentMessage, waitForAnySubagent, waitForSubagent } from "../src/run.js";
import { SYSTEM_PROMPT_APPEND_ENV } from "../src/names.js";
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
  assert.doesNotMatch(calls[0]?.at(-1) ?? "", new RegExp(`${SYSTEM_PROMPT_APPEND_ENV}=`));
  assert.match(calls[0]?.at(-1) ?? "", /--extension/);
}));

test("launchSubagent appends and forwards generic parent guidance", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-prompt-bridge-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const previous = process.env[SYSTEM_PROMPT_APPEND_ENV];
  process.env[SYSTEM_PROMPT_APPEND_ENV] = "## Worktree context\nUse /hub/worktree, not /repo/source.";
  try {
    const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
    const systemPrompt = await readFile(join(root, "jobs", job.id, "agent-system.md"), "utf8");
    const command = calls[0]?.at(-1) ?? "";

    assert.match(systemPrompt, /## Worktree context\nUse \/hub\/worktree, not \/repo\/source\./);
    assert.match(command, new RegExp(`${SYSTEM_PROMPT_APPEND_ENV}=`));
    assert.match(command, /Use \/hub\/worktree, not \/repo\/source\./);
  } finally {
    if (previous === undefined) delete process.env[SYSTEM_PROMPT_APPEND_ENV];
    else process.env[SYSTEM_PROMPT_APPEND_ENV] = previous;
  }
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

test("launchSubagent persists and passes effective model", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-model-launch-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };

  const job = await launchSubagent({
    stateRoot: root,
    cwd: root,
    agent: { ...agent, model: "openai-codex/gpt-5.6-sol" },
    task: "Inspect auth",
    background: true,
    tmux,
  });

  assert.equal(job.model, "openai-codex/gpt-5.6-sol");
  assert.equal((await loadJobs(root)).jobs.find((item) => item.id === job.id)?.model, "openai-codex/gpt-5.6-sol");
  assert.match(calls[0]?.at(-1) ?? "", /'--model' 'openai-codex\/gpt-5\.6-sol'/);
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

test("launchSubagent persists resolved idle cleanup policy and rejects invalid values before writes", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-idle-policy-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });

  const defaulted = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Default", background: true, tmux });
  const finite = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Finite", background: true, idleTimeoutMs: 1234, tmux });
  const indefinite = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Indefinite", background: true, idleTimeoutMs: 0, tmux });
  assert.equal(defaulted.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(finite.idleTimeoutMs, 1234);
  assert.equal(indefinite.idleTimeoutMs, 0);

  const before = (await loadJobs(root)).jobs.length;
  for (const idleTimeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(launchSubagent({ stateRoot: root, cwd: root, agent, task: "Invalid", background: true, idleTimeoutMs, tmux }), /idleTimeoutMs/);
  }
  assert.equal((await loadJobs(root)).jobs.length, before);
}));

test("hasOpenDescendants checks all saved descendants with one name-only tmux query", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-descendants-test-"));
  const launchTmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const parent = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Parent", background: true, tmux: launchTmux });
  const previousJobId = process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  process.env.PI_TMUX_SUBAGENTS_JOB_ID = parent.id;
  const child = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Child", background: true, tmux: launchTmux });
  if (previousJobId === undefined) delete process.env.PI_TMUX_SUBAGENTS_JOB_ID;
  else process.env.PI_TMUX_SUBAGENTS_JOB_ID = previousJobId;
  await finalizeStoppedSubagents(root, [child]);
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: `${child.tmuxSession}\nunrelated\n`, stderr: "" };
  };

  assert.equal(await hasOpenDescendants(root, parent.id, tmux), true);
  assert.deepEqual(calls, [["list-sessions", "-F", "#{session_name}"]]);
  await assert.rejects(hasOpenDescendants(root, parent.id, async () => { throw new Error("tmux unavailable"); }), /tmux unavailable/);
}));

test("finalizeStoppedSubagents only finalizes requested jobs and preserves automatic completion", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-finalize-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const first = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "First", background: true, tmux });
  const second = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Second", background: true, tmux });
  await writeFile(join(root, "jobs", first.id, "result.md"), "done", "utf8");

  const [stopped] = await finalizeStoppedSubagents(root, [first], true);
  const [again] = await finalizeStoppedSubagents(root, [first]);
  const jobs = (await loadJobs(root)).jobs;
  assert.equal(stopped?.autoStopped, true);
  assert.equal(again?.autoStopped, true);
  assert.equal(again?.updatedAt, stopped?.updatedAt);
  assert.equal(jobs.find((job) => job.id === second.id)?.status, "starting");
  assert.equal(await readFile(join(root, "jobs", first.id, "result.md"), "utf8"), "done");

  await Promise.all([
    finalizeStoppedSubagents(root, [second], true),
    cancelSubagent(root, second.id, tmux),
  ]);
  const raced = (await loadJobs(root)).jobs.find((job) => job.id === second.id);
  assert.equal(raced?.status, "stopped");
  assert.equal(raced?.autoStopped, true);
}));

for (const initiallyWaiting of [false, true]) {
  test(`getSubagentStatus preserves concurrent automatic completion with ${initiallyWaiting ? "unchanged" : "changed"} observed status`, async () => withNoAgentHub(async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tmux-status-race-test-"));
    const launchTmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
    const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Race", background: true, tmux: launchTmux });
    await writeFile(join(root, "jobs", job.id, "heartbeat.json"), JSON.stringify({
      jobId: job.id, executionId: job.executionId,
      cwd: root,
      state: "waiting",
      stateSince: 2,
      updatedAt: 3,
      seenRunning: true,
    }), "utf8");
    if (initiallyWaiting) await getSubagentStatus(root, job.id, launchTmux);
    const tmux: TmuxExecutor = async (args) => {
      if (args[0] === "has-session") {
        await finalizeStoppedSubagents(root, [job], true);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "pane", stderr: "" };
    };

    const status = await getSubagentStatus(root, job.id, tmux);
    assert.equal(status.status, "stopped");
    assert.equal(status.job.status, "stopped");
    assert.equal(status.autoStopped, true);
    assert.equal((await loadJobs(root)).jobs[0]?.autoStopped, true);
  }));
}

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
    jobId: job.id, executionId: job.executionId,
    cwd: root,
    state: "waiting",
    stateSince: 2,
    updatedAt: 3,
    seenRunning: true
  }), "utf8");
  await writeFile(join(jobDir, "result.md"), "done", "utf8");

  const status = await getSubagentStatus(root, job.id.slice(0, 8), tmux, {readResults:true,capturePreview:true});
  assert.equal(status.status, "waiting");
  assert.equal(status.result, "done");
  assert.equal(status.preview, "pane preview");
}));

test("getSubagentStatus rejects malformed usage before rendering", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-invalid-usage-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  try {
    const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect", background: true, tmux });
    const heartbeat = join(root, "jobs", job.id, "heartbeat.json");
    for (const usage of [{ input: 1, output: 2 }, { input: 1, output: 2, cost: { total: "0.1" } }]) {
      await writeFile(heartbeat, JSON.stringify({ executionId: job.executionId, state: "running", seenRunning: true, usage }));
      await assert.rejects(getSubagentStatus(root, job.id, tmux), /Invalid usage/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}));

test("getSubagentStatus keeps latestResult scoped to turn results", async () => withNoAgentHub(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-legacy-status-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });
  const jobDir = join(root, "jobs", job.id);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "result.md"), "legacy", "utf8");

  const status = await getSubagentStatus(root, job.id, tmux, {readResults:true,capturePreview:true});

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
    jobId: job.id, executionId: job.executionId,
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

  const status = await getSubagentStatus(root, job.id, tmux, {readResults:true,capturePreview:true});

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

test("getSubagentStatus preserves child errors in the Agent Hub mirror", async () => withAgentHub(async (hubDir) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-error-mirror-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });
  const registryPath = join(hubDir, "registry.json");
  try {
    await writeFile(registryPath, JSON.stringify({ version: 1, sessions: [
      { id: "parent-1", title: "parent", cwd: root, group: "default", tmuxSession: "parent", status: "running", createdAt: 1, updatedAt: 1 },
    ] }));
    process.env.PI_AGENT_HUB_SESSION_ID = "parent-1";
    const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect", background: true, tmux });
    const heartbeatPath = join(root, "jobs", job.id, "heartbeat.json");
    await writeFile(heartbeatPath, JSON.stringify({ executionId: job.executionId, state: "error", seenRunning: true, message: "Provider failed" }));
    const status = await getSubagentStatus(root, job.id, tmux);
    assert.equal(status.job.error, "Provider failed");
    const mirroredJob = async () => JSON.parse(await readFile(registryPath, "utf8")).sessions.find((row: { id: string }) => row.id === job.id);
    assert.equal((await mirroredJob()).error, "Provider failed");
    await writeFile(heartbeatPath, JSON.stringify({ executionId: job.executionId, state: "running", seenRunning: true }));
    await getSubagentStatus(root, job.id, tmux);
    assert.equal((await mirroredJob()).error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(hubDir, { recursive: true, force: true });
  }
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
    jobId: job.id, executionId: job.executionId,
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
    jobId: job.id, executionId: job.executionId,
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
    jobId: job.id, executionId: job.executionId,
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
    jobId: job.id, executionId: job.executionId,
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
  assert.equal(status.resultPath, join(jobDir, "turns", "001-result.md"));
  assert.equal(status.result, undefined, "waiting must not read result bodies");
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
    jobId: job.id, executionId: job.executionId,
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
  assert.equal(status.resultPath, resultPath);
  assert.equal(status.result, undefined, "waiting must not read result bodies");
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
      jobId: job.id, executionId: job.executionId,
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
          jobId: second.id, executionId: second.executionId,
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
  const oldPromptAppend = process.env[SYSTEM_PROMPT_APPEND_ENV];
  delete process.env.PI_AGENT_HUB_DIR;
  delete process.env.PI_AGENT_HUB_SESSION_ID;
  delete process.env[SYSTEM_PROMPT_APPEND_ENV];
  try {
    await fn();
  } finally {
    if (oldDir === undefined) delete process.env.PI_AGENT_HUB_DIR;
    else process.env.PI_AGENT_HUB_DIR = oldDir;
    if (oldId === undefined) delete process.env.PI_AGENT_HUB_SESSION_ID;
    else process.env.PI_AGENT_HUB_SESSION_ID = oldId;
    if (oldPromptAppend === undefined) delete process.env[SYSTEM_PROMPT_APPEND_ENV];
    else process.env[SYSTEM_PROMPT_APPEND_ENV] = oldPromptAppend;
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
