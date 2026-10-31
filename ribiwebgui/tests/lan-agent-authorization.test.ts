import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const settingsSource = fs.readFileSync(new URL("../src/components/InstanceAgentSettings.vue", import.meta.url), "utf8");
const pageSource = fs.readFileSync(new URL("../src/pages/LanAgentsPage.vue", import.meta.url), "utf8");
type Reply = Response | Promise<Response>;
function evaluate(source: string, exposed: string, context: Record<string, unknown>) {
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + `\nreturn { ${exposed} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`(function() { ${code} })()`, {
    ref: (value: unknown) => ({ value }), computed: () => ({}), onMounted: () => {}, watch: () => {},
    managerAccessToken: () => "fixture-fallback", userFacingError: String, ...context
  });
}
function requests(responses: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return { calls, fetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request: ${url}`);
    return response;
  } };
}
function settings(responses: Reply[], local = false, agentId = "agent-fixture") {
  const transport = requests(responses);
  const agent = { agentId, enabled: false, name: "Fixture", workspace: "fixture-workspace", provider: "dsh", sessionId: "saved-session", managedSessionIds: ["saved-managed"] };
  const instance = { instanceId: "node:fixture", name: "Display alias", address: "192.0.2.1", local, connected: true, enabled: true };
  const events: string[] = [];
  const state = evaluate(settingsSource, "error, notice, save, draft, busy, openTask, selectedSessionId", {
    ...transport, defineProps: () => ({ instance, agent }), defineEmits: () => (name: string) => events.push(name)
  });
  return { state, ...transport, agent, instance, events };
}
function page(responses: Reply[]) {
  const transport = requests(responses);
  const state = evaluate(pageSource, "setInstanceEnabled, instances, error, enablingInstanceId, connectionToken, refresh", {
    ...transport, window: { location: { origin: "https://manager.test", hostname: "manager.test" } }, useGatewayStore: () => ({ gateways: [] })
  });
  state.connectionToken.value = "fixture-admin";
  return { state, ...transport };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const access = () => json({ code: 0, data: { token: "fixture-admin", enabled: false } });
const saved = () => json({ code: 0, result: { saved: true } });
const instance = (enabled?: boolean) => ({ instanceId: "node:fixture", name: "Display alias", address: "192.0.2.1", local: false, connected: false, enabled, agents: [] });
const catalog = (enabled: boolean) => json({ code: 0, instances: [instance(enabled)] });
const payload = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body));

test("remote instance owns its visible enable switch; local execution settings do not add an API grant", () => {
  assert.match(pageSource, /:model-value="instance.enabled !== false" label="是否启用Agent"/);
  assert.match(pageSource, /setInstanceEnabled\(instance, \$event\)/);
  assert.match(settingsSource, /v-switch v-if="instance.local" v-model="draft.enabled" label="启用此执行程序"/);
  assert.doesNotMatch(settingsSource, /setAuthorization|authorized|\/authorization/);
});

test("remote save persists execution parameters by stable IDs without changing instance enable or saved session bindings", async () => {
  const { state, calls, instance: target, events } = settings([access(), saved()]);
  state.draft.value.enabled = false;
  state.draft.value.sessionId = "unsaved-session";
  state.draft.value.managedSessionIds = ["unsaved-managed"];
  state.draft.value.workspace = "new-workspace";
  target.name = "Renamed alias";
  target.address = "192.0.2.2";
  await state.save();
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents/agent-fixture/configure");
  assert.equal(calls[1].init?.method, "POST");
  const body = payload(calls[1]);
  for (const key of ["enabled", "sessionId", "managedSessionIds"]) assert.equal(Object.hasOwn(body, key), false);
  assert.equal(body.workspace, "new-workspace");
  assert.equal(target.enabled, true);
  assert.deepEqual(events, ["saved"]);
  assert.match(state.notice.value, /已保存/);
});

test("local save retains local executor enable and session configuration", async () => {
  const { state, calls } = settings([access(), saved()], true);
  state.draft.value.enabled = true;
  state.draft.value.sessionId = "selected-local-session";
  await state.save();
  assert.equal(payload(calls[1]).enabled, true);
  assert.equal(payload(calls[1]).sessionId, "selected-local-session");
  assert.deepEqual(payload(calls[1]).managedSessionIds, ["saved-managed"]);
});

test("failed save retains edited draft and emits no saved result", async () => {
  const { state, events, calls } = settings([access(), json({ code: -1, message: "fixture save rejected" }, 503)]);
  state.draft.value.workspace = "keep-my-draft";
  await state.save();
  assert.equal(state.draft.value.workspace, "keep-my-draft");
  assert.match(state.error.value, /fixture save rejected/);
  assert.equal(state.notice.value, "");
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2);
  assert.equal(state.busy.value, false);
});

test("executor failure inside a successful HTTP envelope is not reported as saved", async () => {
  const { state, events } = settings([access(), json({ code: 0, result: { statusCode: 409, data: { message: "execution conflict" } } })]);
  await state.save();
  assert.match(state.error.value, /execution conflict/);
  assert.deepEqual(events, []);
  assert.equal(state.notice.value, "");
});

test("new execution settings use instance collection creation without a synthetic agent identity", async () => {
  const { state, calls } = settings([access(), saved()], false, "");
  await state.save();
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents");
  assert.equal(payload(calls[1]).provider, "dsh");
});

test("remote open uses the explicitly selected full session ID only for that operation", async () => {
  const { state, calls, agent } = settings([access(), json({ code: 0, result: { opened: true } })]);
  state.selectedSessionId.value = "full-selected-session";
  await state.openTask();
  assert.equal(payload(calls[1]).threadId, "full-selected-session");
  assert.equal(payload(calls[1]).action, "open");
  assert.equal(agent.sessionId, "saved-session");
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents/agent-fixture/threads");
});

test("offline instance disable uses its original ID and confirms the owner catalog", async () => {
  const { state, calls } = page([json({ code: 0 }), access(), catalog(false)]);
  const target = instance(true);
  state.instances.value = [target];
  await state.setInstanceEnabled(target, false);
  assert.equal(calls[0].url, "/api/lan-agent/instances/node%3Afixture/enabled");
  assert.equal(calls[0].init?.method, "PUT");
  assert.deepEqual(payload(calls[0]), { enabled: false, expectedEnabled: true });
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-rabiroute-webgui-token"], "fixture-admin");
  assert.equal(state.instances.value[0].enabled, false);
  assert.equal(state.error.value, "");
  assert.equal(target.enabled, true, "the old display snapshot is not optimistically rewritten");
});

test("an older instance without enabled field retains the default-enabled compare value", async () => {
  const { state, calls } = page([json({ code: 0 }), access(), catalog(false)]);
  await state.setInstanceEnabled(instance(), false);
  assert.equal(payload(calls[0]).expectedEnabled, true);
});

test("rejected instance change keeps the displayed owner state and never retries the write", async () => {
  const { state, calls } = page([json({ code: -1, message: "instance changed concurrently" }, 409)]);
  state.instances.value = [instance(true)];
  await state.setInstanceEnabled(state.instances.value[0], false);
  assert.equal(state.instances.value[0].enabled, true);
  assert.match(state.error.value, /instance changed concurrently/);
  assert.equal(calls.length, 1);
  assert.equal(state.enablingInstanceId.value, "");
});

test("successful write with mismatching readback remains explicitly unconfirmed", async () => {
  const { state, calls } = page([json({ code: 0 }), access(), catalog(true)]);
  await state.setInstanceEnabled(instance(true), false);
  assert.match(state.error.value, /保存结果未确认/);
  assert.equal(state.instances.value[0].enabled, true);
  assert.equal(calls.filter(call => call.init?.method === "PUT").length, 1);
});

test("pending instance and executor writes reject duplicate clicks without duplicating requests", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  const fixture = page([held, access(), catalog(false)]);
  const target = instance(true);
  const pending = fixture.state.setInstanceEnabled(target, false);
  await fixture.state.setInstanceEnabled(target, true);
  await fixture.state.setInstanceEnabled(target, "false");
  assert.equal(fixture.calls.length, 1);
  release(json({ code: 0 }));
  await pending;
  let releaseAccess!: (response: Response) => void;
  const heldAccess = new Promise<Response>(resolve => { releaseAccess = resolve; });
  const execution = settings([heldAccess, saved()]);
  const saving = execution.state.save();
  await execution.state.save();
  assert.equal(execution.calls.length, 1);
  releaseAccess(access());
  await saving;
  assert.deepEqual(execution.events, ["saved"]);
  assert.equal(execution.calls.length, 2);
});
