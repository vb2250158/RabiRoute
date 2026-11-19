import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureLinearRunEvidence, prepareLinearRunEvidence } from "./workbenchRunEvidence.mjs";

test("linear evidence keeps only recorded steps and redacted command log tails from this run", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-run-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logFile = path.join(directory, "run.jsonl");
  const nodes = [
    { id: "cmd", kind: "command", config: { importedNodeId: "fetch" } },
    { id: "agent", kind: "agent", config: { importedNodeId: "review" } },
    { id: "current", kind: "command", config: { importedNodeId: "warnlog" } },
    { id: "later", kind: "command", config: { importedNodeId: "later" } }
  ];
  const records = [
    { attemptId: "cmd-attempt", text: "A".repeat(4200) },
    { attemptId: "agent-attempt", text: "Agent discussion" },
    { attemptId: "other-run", text: "A different attempt" },
    { attemptId: "cmd-attempt", text: "[WARN] recent command result" }
  ];
  await fs.writeFile(logFile, records.map(row => JSON.stringify(row)).join("\n"));
  const run = { state: "running", sequence: records.length,
    snapshot: { graph: { nodes }, variables: [{ name: "date", value: "2026-11-19" }] },
    attempts: {
      cmd: { id: "cmd-attempt", state: "succeeded" },
      agent: { id: "agent-attempt", state: "failed", reason: "formal_result_missing" },
      current: { id: "summary-attempt", state: "running" },
      later: { id: "later-attempt", state: "pending" }
    }
  };
  const result = await captureLinearRunEvidence(run, logFile, "current");
  assert.deepEqual(Object.keys(result.nodes), ["fetch", "review"]);
  assert.equal(result.date, "2026-11-19");
  assert.equal(result.nodes.fetch.status, "pass");
  assert.equal(result.nodes.fetch.log.length, 4000);
  assert.match(result.nodes.fetch.log, /recent command result\n$/);
  assert.deepEqual(result.nodes.review, { status: "fail", detail: "formal_result_missing", log: "" });
  const prepared = await prepareLinearRunEvidence(run, logFile, "current", directory);
  assert.equal(JSON.parse(await fs.readFile(prepared.file, "utf8")).date, "2026-11-19");
  await prepared.dispose();
  await assert.rejects(fs.stat(prepared.file), { code: "ENOENT" });
});

test("verified resumed attempts use their original command logs", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reused-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshot = { graph: { nodes: [{ id: "check", kind: "command", config: { importedNodeId: "check" } }] }, variables: [] };
  const prior = { id: "prior", sequence: 2, attempts: { check: { id: "original-attempt", state: "succeeded" } } };
  await fs.writeFile(path.join(directory, "prior.jsonl"), [
    { attemptId: "original-attempt", text: "[WARN] retained evidence" },
    { attemptId: "wrong-attempt", text: "do not include" }
  ].map(row => JSON.stringify(row)).join("\n"));
  const resumed = { id: "resumed", resumedFromRunId: "prior", sequence: 0, state: "running", snapshot,
    attempts: { check: { id: "reused-attempt", state: "succeeded", reusedFromAttemptId: "original-attempt" } } };
  const log = path.join(directory, "resumed.jsonl");
  assert.equal((await captureLinearRunEvidence(resumed, log, "summary", [prior])).nodes.check.log, "[WARN] retained evidence\n");
  assert.match((await captureLinearRunEvidence(resumed, log, "summary")).nodes.check.log, /缺少可核对/);
});
