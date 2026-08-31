import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mobileAdapterStates, personaProfileIds, publicRabiLinkRelayConfig } from "./rabiApi.js";

test("Rabi discovery uses only fenced DNS-SD endpoints", () => {
  const source = fs.readFileSync(new URL("./rabiApi.ts", import.meta.url), "utf8");
  assert.match(source, /discoverManagerLanEndpoints/);
  assert.match(source, /verifyManagerDiscoveryEndpoint/);
  assert.match(source, /x-rabiroute-expected-application-generation-id/);
  assert.match(source, /x-rabiroute-expected-manager-instance-id/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /Boolean\(expectedGeneration\) !== Boolean\(expectedManager\)/);
  assert.match(source, /maxResponseBytes = 4 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /function candidateHosts/);
  assert.doesNotMatch(source, /rabiDiscoveryPorts/);
  assert.doesNotMatch(source, /\/api\/rabi\/identity`, timeoutMs/);
});

test("public Rabi identity never exposes the Relay application token", () => {
  const publicConfig = publicRabiLinkRelayConfig({
    enabled: true,
    url: "https://relay.example.test",
    token: "secret-app-token",
    deviceId: "pc-test",
    claimWaitMs: 60_000,
    replyIdleTimeoutMs: 60_000,
    speechProxyEnabled: false,
    speechServiceUrl: "http://127.0.0.1:8781"
  });

  assert.equal("token" in publicConfig, false);
  assert.equal(publicConfig.tokenConfigured, true);
  assert.equal(JSON.stringify(publicConfig).includes("secret-app-token"), false);
});

test("mobile persona profiles expose display names and skip lifecycle directories", () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-mobile-personas-"));
  fs.mkdirSync(path.join(rolesRoot, "Ilias"));
  fs.writeFileSync(path.join(rolesRoot, "Ilias", "persona.md"), "# 伊莉娅\n", "utf8");
  fs.mkdirSync(path.join(rolesRoot, "old"));
  fs.writeFileSync(path.join(rolesRoot, "old", "persona.2026-07-30.md"), "# 不应出现\n", "utf8");
  fs.mkdirSync(path.join(rolesRoot, "Momo"));
  fs.writeFileSync(path.join(rolesRoot, "Momo", "persona.md"), "# 桃子\n", "utf8");
  fs.mkdirSync(path.join(rolesRoot, "DaiMao"));
  fs.writeFileSync(path.join(rolesRoot, "DaiMao", "persona.md"), "# 呆猫人格提示词\n", "utf8");

  const profiles = personaProfileIds([rolesRoot], ["Momo"]);
  assert.deepEqual(profiles.map(({ roleId, personaDisplayName }) => ({ roleId, personaDisplayName })), [
    { roleId: "DaiMao", personaDisplayName: "呆猫" },
    { roleId: "Ilias", personaDisplayName: "伊莉娅" }
  ]);
});

test("mobile adapter states distinguish independent login and connection state", () => {
  const states = mobileAdapterStates({
    enabled: true,
    running: true,
    messageAdapters: ["napcat", "weixin", "rabilink"],
    runtimeStatus: {
      gatewayStatus: {
        napcatInstances: {
          primary: { connected: true, botUserId: "private-account-id" }
        },
        messageAdapters: {
          weixin: {
            status: "running",
            loggedIn: false,
            accountId: "private-weixin-id",
            lastError: "private diagnostic detail"
          }
        }
      }
    }
  });

  assert.deepEqual(states, [
    { type: "napcat", label: "QQ", state: "connected", summary: "已连接" },
    { type: "weixin", label: "个人微信", state: "login_required", summary: "未登录" },
    { type: "rabilink", label: "手机消息", state: "ready", summary: "已就绪" }
  ]);
  const serialized = JSON.stringify(states);
  assert.equal(serialized.includes("private-account-id"), false);
  assert.equal(serialized.includes("private-weixin-id"), false);
  assert.equal(serialized.includes("diagnostic"), false);
});

test("mobile adapter states describe stopped or disabled entries without reporting a system fault", () => {
  assert.deepEqual(mobileAdapterStates({
    enabled: true,
    running: false,
    messageAdapters: ["napcat", "weixin"]
  }).map(({ state, summary }) => ({ state, summary })), [
    { state: "stopped", summary: "等待 Rabi PC 启动" },
    { state: "stopped", summary: "等待 Rabi PC 启动" }
  ]);

  assert.deepEqual(mobileAdapterStates({
    enabled: true,
    running: true,
    messageAdapters: ["napcat", "weixin"],
    messageAdaptersDisabled: ["weixin"]
  }).map(({ state, summary }) => ({ state, summary })), [
    { state: "waiting", summary: "等待 QQ 连接" },
    { state: "disabled", summary: "已停用" }
  ]);
});
