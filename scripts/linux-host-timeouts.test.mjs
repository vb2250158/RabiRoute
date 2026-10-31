import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLinuxHostTimeouts } from "./lib/linux-host-runtime.mjs";
import { getTimeoutMs } from "./lib/timeout-settings.mjs";

test("Linux Host reloads startup settings from the same global configuration owner", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-host-timeouts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data"));
  const file = path.join(root, "data", "Config.json");
  fs.writeFileSync(file, JSON.stringify({ timeoutOverrides: { "linux.host.startup": 180000 } }));
  loadLinuxHostTimeouts(root);
  assert.equal(getTimeoutMs("linux.host.startup", 60000, {}), 180000);
  fs.writeFileSync(file, JSON.stringify({ timeoutOverrides: {} }));
  loadLinuxHostTimeouts(root);
  assert.equal(getTimeoutMs("linux.host.startup", 60000, {}), 60000);
});


test("Linux Host optional configuration faults preserve discovery and valid neighbouring settings", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-host-bad-timeouts-"));
  const warnings = [], originalWarning = process.emitWarning;
  process.emitWarning = (...args) => warnings.push(args);
  t.after(() => { process.emitWarning = originalWarning; loadLinuxHostTimeouts(undefined); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "data"));
  const file = path.join(root, "data", "Config.json");
  for (const raw of ['{', 'null', '[]']) {
    fs.writeFileSync(file, raw);
    assert.doesNotThrow(() => loadLinuxHostTimeouts(root));
    assert.equal(getTimeoutMs("linux.host.startup", 60000, {}), 60000);
  }
  fs.writeFileSync(file, JSON.stringify({ timeoutOverrides: { "linux.host.startup": 180000, "linux.host.command": false } }));
  loadLinuxHostTimeouts(root);
  assert.equal(getTimeoutMs("linux.host.startup", 60000, {}), 180000);
  assert.equal(getTimeoutMs("linux.host.command", 10000, {}), 10000);
  fs.rmSync(file); fs.mkdirSync(file);
  assert.doesNotThrow(() => loadLinuxHostTimeouts(root));
  assert.equal(getTimeoutMs("linux.host.startup", 60000, {}), 60000);
  fs.rmdirSync(file);
  const count = warnings.length;
  loadLinuxHostTimeouts(root);
  assert.equal(warnings.length, count, "absent optional config needs no warning");
  assert.ok(count >= 5);
});
