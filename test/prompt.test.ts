import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyThinkingSuffix, buildPiArgs, writePromptFiles } from "../src/prompt.js";
import type { AgentConfig, TmuxSubagentJob } from "../src/types.js";

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
  tools: ["read", "bash"],
  model: "openai/gpt",
  thinking: "low",
};

function job(dir: string): TmuxSubagentJob {
  return {
    id: "child-1",
    agentName: "scout",
    taskPreview: "Inspect auth",
    cwd: dir,
    tmuxSession: "pi-tmux-subagents-child",
    status: "starting",
    resultPath: join(dir, "jobs", "child-1", "result.md"),
    createdAt: 1,
    updatedAt: 1,
  };
}

test("applyThinkingSuffix appends once", () => {
  assert.equal(applyThinkingSuffix("openai/gpt", "low"), "openai/gpt:low");
  assert.equal(applyThinkingSuffix("openai/gpt:high", "low"), "openai/gpt:high");
  assert.equal(applyThinkingSuffix("openai/gpt", "off"), "openai/gpt");
});

test("writePromptFiles writes child boundary and task contract under jobs/id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-prompt-test-"));
  const paths = await writePromptFiles(root, job(root), agent, "Inspect auth carefully");

  assert.equal(paths.agentSystemPath, join(root, "jobs", "child-1", "agent-system.md"));
  assert.equal(paths.taskPath, join(root, "jobs", "child-1", "task.md"));
  const system = await readFile(paths.agentSystemPath, "utf8");
  assert.match(system, /You are a child subagent/);
  assert.match(system, /You scout\./);
  assert.doesNotMatch(system, /Write your final answer to the requested result path/i);
  assert.match(await readFile(paths.taskPath, "utf8"), /Inspect auth carefully/);
  const task = await readFile(paths.taskPath, "utf8");
  assert.match(task, /Return your final answer normally/);
  assert.match(task, /captured automatically/);
  assert.doesNotMatch(task, /write your final response/i);
});

test("writePromptFiles includes nested subagent boundary when enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-prompt-nested-test-"));
  const nestedJob = { ...job(root), allowNestedSubagents: true, nestedAgentAllowlist: ["code-critic", "plan-critic"] };
  const paths = await writePromptFiles(root, nestedJob, agent, "Review carefully");

  assert.match(await readFile(paths.agentSystemPath, "utf8"), /Nested subagent launches are allowed only/);
  assert.match(await readFile(paths.taskPath, "utf8"), /Allowed nested agents: code-critic, plan-critic/);
});

test("buildPiArgs maps agent config to Pi CLI args", () => {
  const args = buildPiArgs({
    agent,
    taskPath: "/tmp/task.md",
    agentSystemPath: "/tmp/system.md",
    childBootstrapPath: "/tmp/bootstrap.js",
  });

  assert.deepEqual(args, [
    "--model", "openai/gpt:low",
    "--tools", "read,bash",
    "--no-skills",
    "--approve",
    "--extension", "/tmp/bootstrap.js",
    "--system-prompt", "/tmp/system.md",
    "@/tmp/task.md",
  ]);
});

test("buildPiArgs exposes tmux_subagent when nested launches are allowed", () => {
  const args = buildPiArgs({
    agent,
    taskPath: "/tmp/task.md",
    agentSystemPath: "/tmp/system.md",
    childBootstrapPath: "/tmp/bootstrap.js",
    allowNestedSubagents: true,
  });

  assert.ok(args.includes("read,bash,tmux_subagent"));
});
