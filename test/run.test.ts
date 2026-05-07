import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoStopCompletedSubagent, launchSubagent, getSubagentStatus, cancelSubagent } from "../src/run.js";
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

test("launchSubagent creates standalone job and tmux session", async () => withNoPiSessions(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-run-test-"));
  const calls: string[][] = [];
  const tmux: TmuxExecutor = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };

  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, tmux });

  assert.equal(job.agentName, "scout");
  assert.match(job.tmuxSession, /^pi-tmux-subagent-/);
  assert.equal((await loadJobs(root)).jobs.length, 1);
  assert.equal(calls[0]?.[0], "new-session");
  assert.match(calls[0]?.at(-1) ?? "", /PI_TMUX_SUBAGENTS_JOB_ID=/);
  assert.match(calls[0]?.at(-1) ?? "", /--extension/);
}));

test("launchSubagent persists auto-stop preference", async () => withNoPiSessions(async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-autostop-launch-test-"));
  const tmux: TmuxExecutor = async () => ({ stdout: "", stderr: "" });

  const job = await launchSubagent({ stateRoot: root, cwd: root, agent, task: "Inspect auth", background: true, autoStopOnComplete: true, tmux });

  assert.equal(job.autoStopOnComplete, true);
  assert.equal((await loadJobs(root)).jobs[0]?.autoStopOnComplete, true);
}));

test("getSubagentStatus reads heartbeat result and pane preview", async () => withNoPiSessions(async () => {
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

test("getSubagentStatus marks missing tmux sessions stopped", async () => withNoPiSessions(async () => {
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

test("autoStopCompletedSubagent stops clean completed jobs and preserves done result", async () => withNoPiSessions(async () => {
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

test("autoStopCompletedSubagent returns result and warning when stop fails", async () => withNoPiSessions(async () => {
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

test("autoStopCompletedSubagent leaves non-completed jobs alive", async () => withNoPiSessions(async () => {
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

test("cancelSubagent kills tmux and marks job stopped", async () => withNoPiSessions(async () => {
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

async function withNoPiSessions(fn: () => Promise<void>): Promise<void> {
  const oldDir = process.env.PI_SESSIONS_DIR;
  const oldId = process.env.PI_SESSIONS_SESSION_ID;
  delete process.env.PI_SESSIONS_DIR;
  delete process.env.PI_SESSIONS_SESSION_ID;
  try {
    await fn();
  } finally {
    if (oldDir === undefined) delete process.env.PI_SESSIONS_DIR;
    else process.env.PI_SESSIONS_DIR = oldDir;
    if (oldId === undefined) delete process.env.PI_SESSIONS_SESSION_ID;
    else process.env.PI_SESSIONS_SESSION_ID = oldId;
  }
}
