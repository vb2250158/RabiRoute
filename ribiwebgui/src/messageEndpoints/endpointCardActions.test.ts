import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";

function fixture(name: "Speech" | "Rabilink" | "Weixin" | "QqBot", fetchImpl: typeof fetch = async () => Response.json({ code: 0, data: { devices: [], settings: { mobileDeviceIds: [] } } })) {
  const webPath = name === "QqBot" ? "QqBotEndpointCard.vue" : `messageEndpoints/${name}EndpointCard.vue`;
  const source = fs.readFileSync(new URL(`../../../src/plugins/io.rabiroute.endpoint.${name.toLowerCase()}/web/${webPath}`, import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "endpoint-action-test" });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const unmounts: Array<() => void> = [];
  const saves: string[] = [];
  let reconciled = 0;
  let saving = async (_id: string) => {};
  const store = vue.reactive({
    selectedGateway: { id: "a", agentRoleId: "RoleA", messageAdapters: ["speech", "rabilink"], routeVariables: {}, pipeline: {} } as any,
    selectedRuntime: {} as any, async ensureDiagnostics() {}, networkOptions: { localAddresses: [] }, touch() {},
    async save(id: string) { saves.push(id); await saving(id); }
  });
  const props = vue.reactive({ context: { routeId: "a", messageEndpointType: name.toLowerCase(), active: false, loginRequested: false } });
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, fetch: fetchImpl, URL, console,
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    window: { location: { hostname: "localhost" }, setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id: number) { timers.delete(id); } },
    require(id: string) {
      id = id.replace(/^(?:\.\.\/)+ribiwebgui\/src\//, "../");
      if (id === "vue") return { ...vue, onMounted() {}, onBeforeUnmount(fn: () => void) { unmounts.push(fn); } };
      if (id.endsWith(".vue")) return {};
      if (id === "../stores/gatewayStore") return { useGatewayStore: () => store };
      if (id === "../stores/speechStore") return { useSpeechStore: () => ({ personas: [], async reconcileMicrophone() { reconciled++; }, async refreshPersonas() {}, stopMicrophone() { throw new Error("An endpoint card must not stop the shared microphone"); } }) };
      if (id === "../userFacingError") return { userFacingError: (cause: Error) => cause.message };
      if (id === "vue-router") return { useRouter: () => ({ push() {} }) };
      if (id === "../../../io.rabiroute.manager.speech/web/speech/speechDeliveryMode") return { speechPushModeForHotDelivery: (enabled: boolean) => enabled ? "hot" : "keyword" };
      if (id === "@shared/speechControlContract") return { applySpeechRouteVariableDefaults: () => ({ speechAutoPlay: "true" }) };
      if (id === "../utils/gatewayHelpers") return { configNameFor: (row: any) => row.id, isAdapterDisabled: () => false };
      if (id === "../browserUuid") return { browserUuid: () => "test-request" };
      if (id === "../clipboard") return {};
      if (id === "../webhookRuntimeEndpoint" || id === "../routeScopedNavigation") return {};
      throw new Error(`Unexpected card import: ${id}`);
    }
  });
  const scope = vue.effectScope();
  let exposed: any;
  const model = scope.run(() => module.exports.default.setup(props, { expose(value: unknown) { exposed = value; } }));
  return {
    store, props, model, exposed, saves, get reconciled() { return reconciled; },
    delaySave(fn: (id: string) => Promise<void>) { saving = fn; },
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    dispose() { unmounts.forEach(fn => fn()); scope.stop(); }
  };
}
async function settle() {
  for (let i = 0; i < 5; i++) await vue.nextTick();
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("Speech enable changes save the original Route and reconcile the shared microphone without stopping other consumers", async () => {
  const f = fixture("Speech");
  try {
    let release!: () => void;
    f.delaySave(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.exposed.onEnabledChange(false);
    f.store.selectedGateway = { id: "b", agentRoleId: "RoleB", unsaved: "keep" };
    release();
    await pending;
    assert.deepEqual(f.saves, ["a"]);
    assert.equal(f.reconciled, 1);
    assert.equal(f.store.selectedGateway.unsaved, "keep");
  } finally { f.dispose(); }
});

test("opening Speech settings neither saves Route drafts nor changes the shared microphone", async () => {
  const f = fixture("Speech");
  try {
    f.props.context.active = true;
    await settle();
    assert.deepEqual(f.saves, []);
    assert.equal(f.reconciled, 0);
  } finally { f.dispose(); }
});

test("opening an existing RabiLink card refreshes devices; disabling or removing it never rewrites shared role bindings", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const f = fixture("Rabilink", async (url, init) => { requests.push({ url: String(url), method: init?.method }); return Response.json({ code: 0, data: { devices: [{ id: "phone" }] } }); });
  try {
    f.props.context.active = true;
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "/api/roles/RoleA/all-day-recording");
    f.props.context = { ...f.props.context };
    await settle();
    assert.equal(requests.length, 1, "a parent scan/status render must not refresh the same expanded card again");
    await f.exposed.onEnabledChange(false);
    f.dispose();
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests.some(request => request.method === "PUT"), false);
    assert.deepEqual(f.saves, []);
  } finally { f.dispose(); }
});

test("a late RabiLink device read cannot replace the visible Route's device list after navigation", async () => {
  let release!: (response: Response) => void;
  const f = fixture("Rabilink", async url => String(url).includes("RoleA")
    ? new Promise<Response>(resolve => { release = resolve; })
    : Response.json({ code: 0, data: { devices: [{ id: "phone-b" }] } }));
  try {
    f.props.context.active = true;
    await settle();
    f.store.selectedGateway = { id: "b", agentRoleId: "RoleB" };
    f.props.context.routeId = "b";
    await settle();
    assert.equal(f.model.mobileRecordingInfo.value.devices[0]?.id, "phone-b");
    release(Response.json({ code: 0, data: { devices: [{ id: "phone-a" }] } }));
    await settle();
    assert.equal(f.model.mobileRecordingInfo.value.devices[0]?.id, "phone-b");
    assert.deepEqual(f.saves, []);
  } finally { f.dispose(); }
});

test("Weixin requests QR authorization only on click and follows the original Route's QR and PIN", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const f = fixture("Weixin", async (input, init) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ code: 0 }, { status: 202 });
  });
  try {
    f.props.context.active = true;
    await settle();
    assert.equal(requests.length, 0);
    f.props.context.loginRequested = true;
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(f.model.pending.value, "login");
    const state = { qrStatus: "need_verifycode", loginAttemptId: "attempt-a", qrCodeDataUrl: "data:image/png;base64,A" };
    f.store.selectedRuntime = { gatewayStatus: { messageAdapters: { weixin: state } } };
    await settle();
    assert.equal(f.model.pending.value, undefined);
    assert.equal(f.model.needsPin.value, true);
    f.model.pin.value = "123456";
    await f.model.request("pin");
    assert.deepEqual(requests, [
      { path: "/api/message/weixin/routes/a/login", body: { mode: "owner" } },
      { path: "/api/message/weixin/routes/a/pin", body: { pin: "123456", attemptId: "attempt-a" } }
    ]);
    f.store.selectedRuntime = { gatewayStatus: { messageAdapters: { weixin: { loggedIn: true } } } };
    await settle();
    assert.equal(f.model.authorized.value, true);
    assert.equal(f.model.qr.value, undefined);
  } finally { f.dispose(); }
});

test("QQ Bot credential login stages the account without changing transport or saving another Route", async () => {
  const record = { id: "account-a", appId: "123", revision: "revision-a", sandbox: true, state: "connected" };
  const posts: unknown[] = [];
  const f = fixture("QqBot", async (input, init) => {
    if (input === "/meta") return Response.json({ applicationGenerationId: "app", managerInstanceId: "manager" });
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ code: 0, data: record });
    }
    return Response.json({ code: 0, data: [record] });
  });
  try {
    f.props.context.active = true;
    await settle();
    assert.equal(posts.length, 0);
    f.store.selectedGateway.qqbotTransport = "websocket";
    f.model.openForm("add");
    assert.equal(f.model.form.value, "add");
    assert.equal(posts.length, 0);
    f.model.appId.value = "123";
    f.model.secret.value = "fixture-secret";
    await f.model.mutate("save");
    assert.deepEqual(posts, [{ appId: "123", appSecret: "fixture-secret", sandbox: true }]);
    assert.equal(f.store.selectedGateway.qqbotAccountId, "account-a");
    assert.equal(f.store.selectedGateway.qqbotTransport, "websocket");
    assert.equal(f.model.secret.value, "");
    assert.deepEqual(f.saves, []);
  } finally { f.dispose(); }
});

test("QQ Bot opens a QR session on connect and uses the bot selected on the phone", async () => {
  const selectedBot = { id: "selected-account", appId: "456", revision: "selected-revision", sandbox: false, state: "connected" };
  const actions: string[] = [];
  const f = fixture("QqBot", async (input, init) => {
    if (input === "/meta") return Response.json({ applicationGenerationId: "app", managerInstanceId: "manager" });
    if (input === "/api/message/qqbot/accounts") return Response.json({ code: 0, data: [selectedBot] });
    assert.equal(input, "/api/message/qqbot/qr/test-request");
    assert.equal((init?.headers as Record<string, string>)["x-rabiroute-expected-manager-instance-id"], "manager");
    actions.push(init?.method || "GET");
    const data = init?.method === "POST" ? { state: "waiting", qrCodeDataUrl: "data:image/png;base64,fixture" }
      : init?.method === "DELETE" ? { state: "cancelled" } : { state: "ready", accounts: [selectedBot] };
    return Response.json({ code: 0, data });
  });
  try {
    f.store.selectedGateway.qqbotTransport = "webhook";
    f.props.context.active = true;
    await settle();
    assert.deepEqual(actions, []);
    f.props.context.loginRequested = true;
    await settle();
    assert.ok(f.model.qrImage.value.startsWith("data:image/png;"));
    f.flushTimers();
    await settle();
    assert.deepEqual(actions, ["POST", "GET", "DELETE"]);
    assert.equal(f.store.selectedGateway.qqbotAccountId, "selected-account");
    assert.equal(f.store.selectedGateway.qqbotTransport, "webhook");
    assert.equal(f.model.qrMode.value, false);
  } finally { f.dispose(); }
});
