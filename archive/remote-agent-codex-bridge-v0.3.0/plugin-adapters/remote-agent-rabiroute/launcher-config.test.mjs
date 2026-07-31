import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bridgeEnvironment,
  createDefaultConfig,
  defaultConfigPath,
  readConfig,
  validateConfig,
  writeConfig
} from "./launcher-config.mjs";

test("default config stays inside the current user profile and pins one writable root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-launcher-"));
  const config = createDefaultConfig({ defaultCwd: root, deviceName: "Build PC" });
  assert.equal(config.deviceName, "Build PC");
  assert.deepEqual(config.allowedCwds, [fs.realpathSync.native(root)]);
  assert.ok(Buffer.byteLength(config.password, "utf8") >= 16);
  assert.equal(defaultConfigPath({ LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }), "C:\\Users\\Example\\AppData\\Local\\RabiRoute\\RemoteAgent\\config.json");
});

test("config writes atomically and environment keeps explicit operator overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-launcher-"));
  const configPath = path.join(root, "private", "config.json");
  const config = writeConfig(configPath, createDefaultConfig({ defaultCwd: root }));
  assert.deepEqual(readConfig(configPath), config);
  const env = bridgeEnvironment(config, {
    REMOTE_AGENT_DEVICE_NAME: "Override",
    REMOTE_AGENT_ALLOW_NETWORK: "1"
  });
  assert.equal(env.REMOTE_AGENT_DEVICE_NAME, "Override");
  assert.equal(env.REMOTE_AGENT_ALLOW_NETWORK, "1");
  assert.equal(env.REMOTE_AGENT_DEFAULT_CWD, fs.realpathSync.native(root));
});

test("invalid workspace and short password fail closed", () => {
  assert.throws(
    () => validateConfig({
      schemaVersion: 1,
      defaultCwd: path.join(os.tmpdir(), "missing-rabiroute-workspace"),
      password: "this-password-is-long-enough"
    }),
    /项目目录不存在/
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-launcher-"));
  assert.throws(
    () => validateConfig({
      schemaVersion: 1,
      defaultCwd: root,
      password: "short"
    }),
    /至少需要 16/
  );
});
