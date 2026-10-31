import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { configureTimeouts, getTimeoutMs } from "../shared/timeoutSettings.js";

test("saved overrides survive restart, back up the complete original and preserve unrelated fields", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-settings-"));
  t.after(() => { configureTimeouts({}); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new RabiGlobalConfigStore(root);
  store.patch({ rabiName: "fixture-name" });
  const original = fs.readFileSync(store.configPath, "utf8");
  store.patch({ timeoutOverrides: { "agent.catalog": 70_000 } });
  assert.equal(getTimeoutMs("agent.catalog", 8000), 70_000);
  const backupDir = path.join(root, "data", ".runtime", "timeout-settings-backups");
  assert.equal(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]!), "utf8"), original);
  const reloaded = new RabiGlobalConfigStore(root);
  assert.equal(reloaded.read().rabiName, "fixture-name");
  assert.equal(reloaded.read().timeoutOverrides["agent.catalog"], 70_000);
  assert.throws(() => reloaded.patch({ timeoutOverrides: { "agent.catalog": 0 } }));
  assert.equal(reloaded.read().timeoutOverrides["agent.catalog"], 70_000);
  reloaded.patch({ timeoutOverrides: {} });
  assert.equal(getTimeoutMs("agent.catalog", 8000), 8000);
});
