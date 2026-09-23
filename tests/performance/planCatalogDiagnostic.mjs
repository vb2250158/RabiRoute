import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Diagnostic only: this intentionally bypasses the HTTP worker deadline.
// Usage: node planCatalogDiagnostic.mjs <built package> <retained synthetic role>
const [packageInput, roleInput] = process.argv.slice(2);
assert.ok(packageInput && roleInput, "Explicit built package and synthetic role required");
const packageRoot = fs.realpathSync(packageInput);
const roleDir = fs.realpathSync(roleInput);
assert.equal(path.basename(roleDir), "SyntheticBenchmark");
assert.ok(path.basename(path.dirname(path.dirname(roleDir))).startsWith("plan-api-benchmark-"));
const modulePath = path.join(packageRoot, "dist", "roleKnowledge.js");
const identity = {
  scope: "non-HTTP isolated diagnostic, not performance acceptance",
  node: process.version, pid: process.pid,
  moduleSha256: createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex")
};
let stage = "imports";
const emit = data => console.log(JSON.stringify({ ...identity, stage, ...data }));
const deadline = setTimeout(() => {
  emit({ error: "180 second diagnostic deadline", memory: process.memoryUsage() });
  process.exit(2);
}, 180_000);
try {
  const load = name => import(pathToFileURL(path.join(packageRoot, "dist", `${name}.js`)).href);
  const knowledge = await load("roleKnowledge");
  const fences = await load("planReadInvalidation");
  stage = "cold";
  emit({ event: "start" });
  let started = performance.now();
  const rows = await knowledge.readPlanPageCatalogInWorker(roleDir, fences.planReadFence(roleDir));
  emit({ ms: performance.now() - started, count: rows.length, diagnostics: knowledge.planPageReadDiagnostics(roleDir), memory: process.memoryUsage() });
  stage = "interval";
  await new Promise(resolve => setTimeout(resolve, 5100));
  stage = "periodic";
  emit({ event: "start" });
  started = performance.now();
  const next = await knowledge.readPlanPageCatalogInWorker(roleDir, fences.planReadFence(roleDir));
  assert.equal(next.length, rows.length);
  emit({ ms: performance.now() - started, sameArray: next === rows, diagnostics: knowledge.planPageReadDiagnostics(roleDir), memory: process.memoryUsage() });
} catch (error) {
  emit({ error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
