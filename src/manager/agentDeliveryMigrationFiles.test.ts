import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateAgentDeliveryFiles } from "./agentDeliveryMigrationFiles.js";
test("migration snapshots, reads back, is idempotent, and restores after a partial write", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-delivery-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personaPath = path.join(root, "personaConfig.json");
  const routePath = path.join(root, "route", "adapterConfig.json");
  fs.mkdirSync(path.dirname(routePath));
  fs.writeFileSync(personaPath, '{"automationRules":[],"custom":"preserved"}');
  fs.writeFileSync(routePath, '{"agentAdapters":["codex"],"codexThreadId":"original"}');
  const before = [personaPath, routePath].map(file => fs.readFileSync(file));
  assert.throws(() => migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath], apply: true, beforeWrite: index => { if (index === 0) throw new Error("injected failure"); } }), /injected/);
  [personaPath, routePath].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  const result = migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath], apply: true });
  assert.ok(result.snapshotPath);
  assert.equal(JSON.parse(fs.readFileSync(routePath, "utf8")).codexThreadId, "original");
  assert.equal(migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath], apply: true }).changed, false);
});


test("interrupted migration restores proven bytes before repeating conversion", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-delivery-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personaPath = path.join(root, "personaConfig.json");
  const routePath = path.join(root, "route", "adapterConfig.json");
  fs.mkdirSync(path.dirname(routePath));
  fs.writeFileSync(personaPath, '{"automationRules":[]}');
  fs.writeFileSync(routePath, '{"agentAdapters":["codex"]}');
  const result = migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath], apply: true });
  const manifestPath = path.join(result.snapshotPath!, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, state: "prepared" }));
  fs.writeFileSync(personaPath, fs.readFileSync(path.join(result.snapshotPath!, "0.json")));
  assert.throws(() => migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath] }), /requires recovery/);
  assert.equal(migrateAgentDeliveryFiles({ personaPath, routePaths: [routePath], apply: true }).changed, true);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).state, "restored");
  assert.equal(JSON.parse(fs.readFileSync(personaPath, "utf8")).agentDeliveryConfigurationVersion, 1);
});
