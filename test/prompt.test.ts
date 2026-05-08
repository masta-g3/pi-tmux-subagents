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
    tmuxSession: "pi-tmux-subagent-child",
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
  assert.match(await readFile(paths.agentSystemPath, "utf8"), /You are a child subagent/);
  assert.match(await readFile(paths.agentSystemPath, "utf8"), /You scout\./);
  assert.match(await readFile(paths.taskPath, "utf8"), /Inspect auth carefully/);
  const task = await readFile(paths.taskPath, "utf8");
  assert.match(task, /Before finishing, write your final response to:/);
  assert.match(task, /control-plane output, not a project file change/);
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
    "--extension", "/tmp/bootstrap.js",
    "--system-prompt", "/tmp/system.md",
    "@/tmp/task.md",
  ]);
});
