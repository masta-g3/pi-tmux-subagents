import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { discoverAgents, parseAgentMarkdown } from "../src/agents.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-tmux-agents-test-"));
}

test("parseAgentMarkdown supports frontmatter defaults", () => {
  const agent = parseAgentMarkdown(`---
name: scout
description: Fast recon
tools: read, bash
model: openai/gpt
thinking: low
---

You scout.` , "/tmp/scout.md", "user");

  assert.equal(agent?.name, "scout");
  assert.equal(agent?.description, "Fast recon");
  assert.deepEqual(agent?.tools, ["read", "bash"]);
  assert.equal(agent?.model, "openai/gpt");
  assert.equal(agent?.thinking, "low");
  assert.equal(agent?.systemPrompt, "You scout.");
  assert.equal(agent?.systemPromptMode, "replace");
  assert.equal(agent?.inheritProjectContext, true);
  assert.equal(agent?.inheritSkills, false);
  assert.equal(agent?.maxDepth, 0);
});

test("parseAgentMarkdown skips malformed and disabled agents", () => {
  assert.equal(parseAgentMarkdown("---\nname: missing-description\n---\nBody", "/tmp/a.md", "user"), null);
  assert.equal(parseAgentMarkdown("---\nname: off\ndescription: Off\ndisabled: true\n---\nBody", "/tmp/b.md", "user"), null);
});

test("discoverAgents includes builtins and lets user agents override them", async () => {
  const home = tempDir();
  const userAgents = join(home, ".pi", "agent", "agents");
  await mkdir(userAgents, { recursive: true });
  await writeFile(join(userAgents, "scout.md"), "---\nname: scout\ndescription: custom scout\n---\nCustom", "utf8");

  const previousHome = process.env.HOME;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const agents = discoverAgents(home, "user").agents;
    assert.equal(agents.find((agent) => agent.name === "delegate")?.source, "builtin");
    assert.equal(agents.find((agent) => agent.name === "worker")?.model, "openai-codex/gpt-5.5");
    assert.equal(agents.find((agent) => agent.name === "scout")?.description, "custom scout");
    assert.equal(agents.find((agent) => agent.name === "scout")?.source, "user");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test("discoverAgents defaults to user scope and lets project override in both scope", async () => {
  const home = tempDir();
  const project = tempDir();
  const userAgents = join(home, ".pi", "agent", "agents");
  const projectAgents = join(project, ".pi", "agents");
  await mkdir(userAgents, { recursive: true });
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(userAgents, "same.md"), "---\nname: same\ndescription: user\n---\nUser", "utf8");
  await writeFile(join(projectAgents, "same.md"), "---\nname: same\ndescription: project\n---\nProject", "utf8");

  const previousHome = process.env.HOME;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(discoverAgents(project, "user").agents.find((agent) => agent.name === "same")?.description, "user");
    const both = discoverAgents(project, "both").agents;
    assert.equal(both.find((agent) => agent.name === "same")?.description, "project");
    assert.equal(both.find((agent) => agent.name === "same")?.source, "project");
    assert.equal(both.find((agent) => agent.name === "worker")?.source, "builtin");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});
