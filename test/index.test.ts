import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.js";

test("tmux_subagent exposes stop as a shutdown alias", () => {
  let tool: any;
  extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

  assert.ok(tool.parameters.properties.action.enum.includes("stop"));
});

test("tmux_subagent rejects recursive launches past agent maxDepth", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-index-test-"));
  const agentDir = join(root, "agent", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "scout.md"), `---
name: scout
description: Scout
maxDepth: 0
tools: none
---
Scout prompt.
`);

  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    let tool: any;
    extension({ registerTool(def: any) { tool = def; }, on() {} } as any);

    const result = await tool.execute("call", { agent: "scout", task: "try nested" }, undefined, undefined, { cwd: root });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /maxDepth is 0/);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = oldDepth;
  }
});
