import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { buildLanAgentBootstrapPrompt } from "../src/lanAgentBootstrap";

test("LAN bootstrap includes current endpoint, trust pin, both hosts and automatic binding", () => {
  const prompt = buildLanAgentBootstrapPrompt({ managerUrl: "http://192.168.1.20:23456/#/lan-agents", token: "fixture-only", publicKeySha256: "a".repeat(64) });
  assert.match(prompt, /http:\/\/192\.168\.1\.20:23456\/api\/lan-agent\/releases\/manifest/);
  assert.match(prompt, /RABI_AGENT_DSH_SESSION_ID/);
  assert.match(prompt, /RABI_AGENT_CODEX_THREAD_ID/);
  assert.match(prompt, /SPKI DER/);
  assert.match(prompt, /不等待它退出/);
  assert.doesNotMatch(prompt, /1728|8790|RABI_LAN_LINK_TOKEN|\/api\/lan-agent\/nodes/);
  assert.match(prompt, /RABI_AGENT_BOOTSTRAP_TICKET/);
  assert.match(prompt, /一次性接入票据/);
  assert.match(prompt, /nodeCredential/);
  assert.match(prompt, /30 分钟内有效，只能成功兑换一次/);
  assert.match(prompt, /成功兑换后立即失效/);
  assert.match(prompt, /保留原身份并用本提示词中的有效新票据完成重新接入/);
  assert.match(prompt, /节点已接入，等待管理员允许 Manager API 与 skills/);
  assert.match(prompt, /无需用户手填 WebGUI 密钥/);
  assert.match(prompt, /不重复兑换/);
  assert.match(prompt, /\/api\/lan-agent\/self/);
  assert.match(prompt, /--api METHOD/);
  assert.match(prompt, /\/api\/lan-agent\/resources/);
  assert.match(prompt, /docs\/rabi-agent-interfaces.md/);
});

test("copy installs only a freshly issued ticket, never the WebGUI admin token", async () => {
  const source = fs.readFileSync(new URL("../src/pages/LanAgentsPage.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + "\nreturn { copyInstallPrompt, connectionToken, releasePublicKeySha256 };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let copied = "";
  let requested = false;
  let requestCount = 0;
  const expiresAt = Date.now() + 30 * 60_000;
  const context = {
    ref: (value: unknown) => ({ value }), computed: () => ({}), onMounted: () => {},
    window: { location: { origin: "https://manager.test" } }, useGatewayStore: () => ({}),
    userFacingError: String, buildLanAgentBootstrapPrompt,
    copyTextToClipboard: async (value: string) => { assert.equal(requested, true); copied = value; },
    fetch: async (url: string, init: RequestInit) => {
      requested = true;
      requestCount++;
      assert.equal(url, "/api/lan-agent/enrollments");
      assert.equal(init.method, "POST");
      assert.equal((init.headers as Record<string, string>)["x-rabiroute-webgui-token"], "fixture-admin-secret");
      return new Response(JSON.stringify({ code: 0, data: { ticket: "fixture-ticket-only", expiresAt } }));
    }
  };
  const state = vm.runInNewContext(`(function() { ${code} })()`, context);
  state.connectionToken.value = "fixture-admin-secret";
  state.releasePublicKeySha256.value = "a".repeat(64);
  await state.copyInstallPrompt();
  assert.equal(requestCount, 1);
  assert.match(copied, /Manager URL: https:\/\/manager\.test/);
  assert.ok(copied.includes(new Date(expiresAt).toISOString()));
  assert.ok(copied.includes("Release public key SHA-256: " + "a".repeat(64)));
  assert.match(copied, /30 分钟内有效，只能成功兑换一次/);
  assert.match(copied, /node rabi-agent\.mjs --bootstrap/);
  assert.match(copied, /fixture-ticket-only/);
  assert.doesNotMatch(copied, /fixture-admin-secret/);
});

test("copy guards concurrent clicks and reports clipboard failure without success", async () => {
  const source = fs.readFileSync(new URL("../src/pages/LanAgentsPage.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + "\nreturn { copyInstallPrompt, connectionToken, releasePublicKeySha256, copied, issuingTicket, error };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const state = vm.runInNewContext(`(function() { ${code} })()`, {
    ref: (value: unknown) => ({ value }), computed: () => ({}), onMounted: () => {},
    window: { location: { origin: "https://manager.test" } }, useGatewayStore: () => ({}),
    userFacingError: String, buildLanAgentBootstrapPrompt,
    copyTextToClipboard: async () => { throw new Error("fixture clipboard unavailable"); },
    fetch: async () => {
      requests++;
      await pending;
      return new Response(JSON.stringify({ code: 0, data: { ticket: "fixture-ticket-only", expiresAt: Date.now() + 30 * 60_000 } }));
    }
  });
  state.connectionToken.value = "fixture-admin-secret";
  state.releasePublicKeySha256.value = "a".repeat(64);
  const first = state.copyInstallPrompt();
  await state.copyInstallPrompt();
  assert.equal(requests, 1);
  assert.equal(state.issuingTicket.value, true);
  release();
  await first;
  assert.equal(state.copied.value, false);
  assert.equal(state.issuingTicket.value, false);
  assert.match(state.error.value, /clipboard unavailable/);
});

test("LAN bootstrap rejects unusable addresses and missing trust material", () => {
  const input = { managerUrl: "http://127.0.0.1:1234", token: "fixture-only", publicKeySha256: "a".repeat(64) };
  assert.throws(() => buildLanAgentBootstrapPrompt(input), /局域网地址/);
  assert.throws(() => buildLanAgentBootstrapPrompt({ ...input, managerUrl: "https://manager.test", publicKeySha256: "" }), /指纹/);
});
