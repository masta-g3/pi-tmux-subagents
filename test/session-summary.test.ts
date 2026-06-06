import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionSummaries } from "../src/session-summary.js";

function writeSummary(root: string, id: string, value: unknown) {
  const dir = join(root, "session-summary");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

test("readSessionSummaries returns valid pi-session-summary metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-test-"));
  writeSummary(root, "child-1", {
    version: 1,
    source: "pi-session-summary",
    cwd: "/repo",
    state: "running",
    summary: " Reviewing auth middleware.\n",
    phase: "implementing",
    sequence: 1,
    updatedAt: 10_000,
  });

  const summaries = await readSessionSummaries(["child-1"], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 12_000);

  assert.deepEqual(summaries.get("child-1"), { summary: "Reviewing auth middleware.", phase: "implementing", updatedAt: 10_000 });
});

test("readSessionSummaries ignores missing, invalid, wrong source, and stale files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-invalid-test-"));
  mkdirSync(join(root, "session-summary"), { recursive: true });
  writeFileSync(join(root, "session-summary", "bad-json.json"), "{");
  writeSummary(root, "wrong-source", { version: 1, source: "other", state: "running", summary: "No", updatedAt: 10_000 });
  writeSummary(root, "stale", { version: 1, source: "pi-session-summary", state: "running", summary: "Old", updatedAt: 1 });

  const summaries = await readSessionSummaries(["missing", "bad-json", "wrong-source", "stale"], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 100_000);

  assert.equal(summaries.size, 0);
});

test("readSessionSummaries filters control states", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-state-test-"));
  const accepted = ["starting", "running", "waiting", "complete", "blocked"];
  const suppressed = ["disabled", "no_model", "error", "shutdown"];
  for (const state of [...accepted, ...suppressed]) {
    writeSummary(root, state, { version: 1, source: "pi-session-summary", state, summary: `Summary ${state}`, updatedAt: 10_000 });
  }

  const summaries = await readSessionSummaries([...accepted, ...suppressed], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 12_000);

  assert.deepEqual([...summaries.keys()].sort(), accepted.sort());
});

test("readSessionSummaries is disabled without Agent Hub dir", async () => {
  const summaries = await readSessionSummaries(["child-1"], {} as NodeJS.ProcessEnv, 12_000);

  assert.equal(summaries.size, 0);
});
