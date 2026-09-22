import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/components/InstanceAgentSettings.vue", import.meta.url), "utf8");
function harness(responses: Response[], options: { enrolled?: boolean; enabled?: boolean; missingSnapshot?: boolean; cryptoMode?: "http" | "missing" } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const authorization = { nodes: options.enrolled === false ? [] : [{ nodeId: "node-fixture", enabledAgentIds: options.enabled === false ? [] : ["agent-fixture"] }] };
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + "\nreturn { setAuthorization, authorized, error, notice, save, draft };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const agent = { agentId: "agent-fixture", enabled: false, name: "Fixture", workspace: "fixture-workspace", provider: "dsh", sessionId: "saved-session", managedSessionIds: ["saved-managed"] };
  const generatedKeys: string[] = [];
  let mounted: (() => Promise<void>) | undefined;
  const context = {
    crypto: options.cryptoMode === "missing" ? undefined : options.cryptoMode === "http"
      ? { getRandomValues: (bytes: Uint8Array) => { generatedKeys.push("secure-bytes"); bytes.fill(15); return bytes; } }
      : { randomUUID: () => { const key = `fixture-action-${generatedKeys.length + 1}`; generatedKeys.push(key); return key; } },
    defineProps: () => ({ instance: { instanceId: "node-fixture", local: false, connected: false }, agent, authorization: options.missingSnapshot ? undefined : authorization }),
    onMounted: (callback: () => Promise<void>) => { mounted = callback; }, defineEmits: () => () => {}, ref: (value: unknown) => ({ value }), watch: (_source: unknown, effect: () => void, config?: { immediate: boolean }) => { if (config?.immediate) effect(); },
    managerAccessToken: () => "fixture-admin", userFacingError: (error: unknown) => String(error),
    fetch: async (url: string, init?: RequestInit) => { calls.push({ url, init }); const response = responses.shift(); if (!response) throw new Error("Unexpected request"); return response; }
  };
  return { state: vm.runInNewContext(`(function() { ${code} })()`, context), calls, agent, generatedKeys, mount: () => mounted?.() };
}
const revision = '"' + "a".repeat(64) + '"';
const json = (value: unknown, status = 200, etag?: string) => new Response(JSON.stringify(value), { status, headers: etag ? { etag } : {} });
const access = () => json({ data: { token: "fixture-admin" } });
const snapshot = (enabled: boolean) => ({ nodes: [{ nodeId: "node-fixture", enabledAgentIds: enabled ? ["agent-fixture"] : [] }] });
const catalog = (enabled: boolean, etag = revision) => json({ code: 0, authorization: snapshot(enabled) }, 200, etag);

test("local and remote switches share the exact label without a second API grant", () => {
  assert.equal((source.match(/label="是否启用Agent"/g) || []).length, 2);
  assert.doesNotMatch(source, /允许使用 Manager API 与 skills|启用本机 Agent 执行|不授予总控权限|先保存新 Agent，再由总控勾选授权/);
});

test("enabled state comes only from Manager projection, never the execution draft", () => {
  const enabled = harness([]);
  assert.equal(enabled.agent.enabled, false);
  assert.equal(enabled.state.authorized.value, true);
  const disabled = harness([], { enabled: false });
  disabled.state.draft.value.enabled = true;
  assert.equal(disabled.state.authorized.value, false);
});

test("missing snapshot and failed initial read never default to enabled", async () => {
  const { state, calls, mount } = harness([access(), json({ code: -1, message: "fixture read failure" }, 503)], { missingSnapshot: true });
  assert.equal(state.authorized.value, false);
  await mount();
  assert.equal(state.authorized.value, false);
  assert.match(state.error.value, /fixture read failure/);
  assert.equal(calls.some(call => call.init?.method === "PUT"), false);
});

test("offline disable immediately PUTs admin authorization with freshly read strong If-Match", async () => {
  const { state, calls } = harness([access(), catalog(true), json({ code: 0, authorization: snapshot(false) })]);
  await state.setAuthorization(false);
  assert.equal(state.authorized.value, false);
  assert.equal(calls[1].url, "/api/lan-agent/instances");
  assert.equal(calls[2].url, "/api/lan-agent/instances/node-fixture/agents/agent-fixture/authorization");
  assert.equal(calls[2].init?.method, "PUT");
  assert.equal((calls[2].init?.headers as Record<string, string>)["If-Match"], revision);
  assert.equal((calls[2].init?.headers as Record<string, string>)["x-rabiroute-webgui-token"], "fixture-admin");
  assert.equal((calls[2].init?.headers as Record<string, string>)["Idempotency-Key"], "fixture-action-1");
  assert.equal(calls[2].init?.body, '{"enabled":false}');
  assert.doesNotMatch(source.match(/<v-switch :model-value="authorized"[^>]+/)![0], /instance.connected/);
});

test("enable freezes displayed saved binding before await, ignoring draft and remote catalog changes", async () => {
  const changedCatalog = json({ code: 0, authorization: snapshot(false), instances: [{ agents: [{ provider: "codex-desktop", sessionId: "remote-replacement" }] }] }, 200, revision);
  const { state, calls, agent } = harness([access(), changedCatalog, json({ code: 0, authorization: snapshot(true) })], { enabled: false });
  state.draft.value.provider = "codex-desktop";
  state.draft.value.sessionId = "unsaved-session";
  const pending = state.setAuthorization(true);
  agent.sessionId = "changed-during-request";
  agent.managedSessionIds.push("changed-managed");
  await pending;
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
    enabled: true, binding: { provider: "dsh", sessionId: "saved-session", managedSessionIds: ["saved-managed"] }
  });
  assert.equal(state.authorized.value, true);
});

test("HTTP LAN without randomUUID uses one 16-byte secure random key", async () => {
  const { state, calls, generatedKeys } = harness([access(), catalog(true), json({ code: 0, authorization: snapshot(false) })], { cryptoMode: "http" });
  await state.setAuthorization(false);
  assert.equal((calls[2].init?.headers as Record<string, string>)["Idempotency-Key"], "0f".repeat(16));
  assert.deepEqual(generatedKeys, ["secure-bytes"]);
});

test("missing Web Crypto reports error and sends no request", async () => {
  const { state, calls } = harness([], { cryptoMode: "missing" });
  await state.setAuthorization(false);
  assert.equal(calls.length, 0);
  assert.equal(state.authorized.value, true);
  assert.match(state.error.value, /安全随机数/);
});

test("failed authorization rolls the switch back", async () => {
  const { state } = harness([access(), catalog(true), json({ code: -1, message: "fixture rejection" }, 500)]);
  await state.setAuthorization(false);
  assert.equal(state.authorized.value, true);
  assert.match(state.error.value, /fixture rejection/);
});

test("missing fresh snapshot fails without PUT instead of assuming enabled", async () => {
  const { state, calls } = harness([access(), json({ code: 0 }, 200, revision)], { enabled: false });
  await state.setAuthorization(true);
  assert.equal(state.authorized.value, false);
  assert.match(state.error.value, /无法读取总控启用状态/);
  assert.equal(calls.some(call => call.init?.method === "PUT"), false);
});

test("412 refreshes the authoritative switch without replaying PUT", async () => {
  const { state, calls, generatedKeys } = harness([access(), catalog(true), json({ code: -1 }, 412), catalog(false)]);
  await state.setAuthorization(false);
  assert.equal(state.authorized.value, false);
  assert.equal(calls.filter(call => call.init?.method === "PUT").length, 1);
  assert.deepEqual(generatedKeys, ["fixture-action-1"]);
  assert.match(state.error.value, /未自动重试/);
});

test("missing enrollment and weak ETags fail closed without PUT", async () => {
  for (const response of [json({ code: 0, authorization: { nodes: [] } }, 200, revision), catalog(true, `W/${revision}`)]) {
    const { state, calls } = harness([access(), response]);
    await state.setAuthorization(false);
    assert.equal(state.authorized.value, true);
    assert.equal(calls.some(call => call.init?.method === "PUT"), false);
    assert.match(state.error.value, /重新接入|强 ETag/);
  }
});

test("saving remote parameters never changes the Manager-owned enabled state", async () => {
  for (const enabled of [true, false]) {
    const { state, calls } = harness([access(), json({ code: 0, result: { saved: true } })], { enabled });
    await state.save();
    const body = JSON.parse(String(calls[1].init?.body));
    assert.equal(body.enabled, true);
    assert.equal(body.workspace, "fixture-workspace");
    assert.equal(state.authorized.value, enabled);
    assert.doesNotMatch(calls[1].url, /authorization/);
  }
});
