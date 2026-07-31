import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteAgentHostConfigStore } from "./configStore.js";

test("RemoteAgentHostConfigStore creates an unattended first-run config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-host-"));
  const configPath = path.join(root, "config.json");
  const store = new RemoteAgentHostConfigStore(configPath);
  const config = store.read();

  assert.equal(config.enabled, true);
  assert.equal(config.profile.agentAdapters[0], "codex");
  assert.equal(config.profile.codexCwd, "");
  assert.ok(config.deviceId.startsWith("rabi-agent-"));
  assert.ok(Buffer.byteLength(config.password, "utf8") >= 16);
  assert.equal(fs.existsSync(configPath), true);
});

test("RemoteAgentHostConfigStore persists only the Agent profile and host settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-host-"));
  const store = new RemoteAgentHostConfigStore(path.join(root, "config.json"));

  store.updateProfile({
    agentAdapters: ["codex", "astrbot"],
    codexCwd: "C:\\work\\project",
    codexThreadName: "Remote Work",
    astrbotUrl: "http://127.0.0.1:6185",
    messageAdapters: ["napcat"],
    agentRoleId: "should-not-persist"
  });
  const config = store.read();

  assert.deepEqual(config.profile.agentAdapters, ["codex", "astrbot"]);
  assert.equal(config.profile.codexThreadName, "Remote Work");
  assert.equal("messageAdapters" in config.profile, false);
  assert.equal("agentRoleId" in config.profile, false);
});

test("RemoteAgentHostConfigStore validates and rotates the device password", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-host-"));
  const store = new RemoteAgentHostConfigStore(path.join(root, "config.json"));
  const original = store.read().password;

  assert.throws(() => store.patchSettings({ password: "short" }), /至少需要 16/);
  const rotated = store.patchSettings({ regeneratePassword: true }).password;
  assert.notEqual(rotated, original);
  assert.ok(Buffer.byteLength(rotated, "utf8") >= 16);
});
