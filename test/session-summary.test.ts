import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionSummaries } from "../src/session-summary.js";

function writeSummary(root: string, id: string, value: unknown) {
  const dir = join(root, "session-metadata");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

test("readSessionSummaries returns valid pi-session-summary metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-test-"));
  writeSummary(root, "child-1", {
    source: "pi-session-summary",
    goal: "Inspect auth flow",
    status: " Reviewing auth middleware.\n",
    nextStep: "Run auth tests",
    stage: "implementing",
    confidence: 0.8,
    updatedAt: 10_000,
  });

  const summaries = await readSessionSummaries(["child-1"], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 12_000);

  assert.deepEqual(summaries.get("child-1"), { goal: "Inspect auth flow", status: "Reviewing auth middleware.", nextStep: "Run auth tests", stage: "implementing", confidence: 0.8, updatedAt: 10_000 });
});

test("readSessionSummaries ignores missing, invalid, stale, empty, and low-confidence files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-invalid-test-"));
  mkdirSync(join(root, "session-metadata"), { recursive: true });
  writeFileSync(join(root, "session-metadata", "bad-json.json"), "{");
  writeSummary(root, "stale", { source: "pi-session-summary", status: "Old", updatedAt: 1 });
  writeSummary(root, "empty", { source: "pi-session-summary", updatedAt: 10_000 });
  writeSummary(root, "low-confidence", { source: "pi-session-summary", status: "Uncertain", confidence: 0.2, updatedAt: 10_000 });

  const summaries = await readSessionSummaries(["missing", "bad-json", "stale", "empty", "low-confidence"], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 100_000);

  assert.equal(summaries.size, 0);
});

test("readSessionSummaries accepts generic Hub metadata with optional source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-tmux-summary-generic-test-"));
  writeSummary(root, "child-1", { status: "Reviewing docs", stage: "reviewing", updatedAt: 10_000 });
  writeSummary(root, "child-2", { source: "other-extension", status: "Checking tests", updatedAt: 10_000 });

  const summaries = await readSessionSummaries(["child-1", "child-2"], { PI_AGENT_HUB_DIR: root } as NodeJS.ProcessEnv, 12_000);

  assert.deepEqual(summaries.get("child-1"), { status: "Reviewing docs", stage: "reviewing", updatedAt: 10_000 });
  assert.deepEqual(summaries.get("child-2"), { status: "Checking tests", updatedAt: 10_000 });
});

test("readSessionSummaries is disabled without Agent Hub dir", async () => {
  const summaries = await readSessionSummaries(["child-1"], {} as NodeJS.ProcessEnv, 12_000);

  assert.equal(summaries.size, 0);
});
