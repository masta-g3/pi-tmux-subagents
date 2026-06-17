import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentsLibraryView, formatAgentLibraryList } from "../src/subagents-library-view.js";
import type { AgentConfig } from "../src/types.js";

const agent: AgentConfig = {
  name: "scout",
  description: "Fast recon",
  source: "project",
  filePath: "/repo/.pi/agents/scout.md",
  model: "openai/gpt-5",
  thinking: "low",
  tools: ["read", "bash"],
  systemPrompt: "Scout the codebase and report concise findings.",
  systemPromptMode: "replace",
  inheritProjectContext: true,
  inheritSkills: false,
  maxDepth: 0,
};

test("library view renders agent rows and details", () => {
  const component = createSubagentsLibraryView([agent], {}, () => undefined);
  const output = component.render(100).join("\n");

  assert.match(output, /subagents library/);
  assert.match(output, /scout\s+project\s+Fast recon/);
  assert.match(output, /tools: read, bash/);
  assert.match(output, /model: openai\/gpt-5/);
  assert.match(output, /file: scout\.md/);
});

test("library fallback formats compact list", () => {
  assert.equal(formatAgentLibraryList([agent]), "scout (project): Fast recon");
});
