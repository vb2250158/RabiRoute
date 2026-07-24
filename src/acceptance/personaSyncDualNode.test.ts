import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPersonaSyncDualNodeAcceptance } from "./personaSyncDualNode.js";

test("dual-node acceptance proves LAN-first and real Relay fallback convergence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-dual-node-acceptance-test-"));
  const outputPath = path.join(root, "report.json");
  const result = await runPersonaSyncDualNodeAcceptance({ outputPath, timeoutMs: 30_000 }, {
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.acceptancePassed, true);
  assert.deepEqual(result.report.transports, { lan: "passed", relay: "passed" });
  assert.equal((result.report.counts as Record<string, unknown>).unresolvedConflicts, 0);
  const evidence = fs.readFileSync(outputPath, "utf8");
  assert.equal(evidence.includes("dual-node-acceptance-password"), false);
  assert.equal(evidence.includes("relay fallback file"), false);
  assert.equal(evidence.includes("AcceptanceRole"), false);
  assert.equal(evidence.includes("127.0.0.1"), false);
});
