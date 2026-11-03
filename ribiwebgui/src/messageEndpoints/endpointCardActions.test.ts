import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";

function fixture(name: "Speech" | "Rabilink", fetchImpl: typeof fetch = async () => Response.json({ code: 0, data: { devices: [], settings: { mobileDeviceIds: [] } } })) {
  const source = fs.readFileSync(new URL(`./${name}EndpointCard.vue`, import.meta.url), "utf8");
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
    selectedRuntime: {}, networkOptions: { localAddresses: [] }, touch() {},
    async save(id: string) { saves.push(id); await saving(id); }
  });
  const props = vue.reactive({ context: { routeId: "a", messageEndpointType: name.toLowerCase(), active: false } });
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, fetch: fetchImpl, URL, console,
    window: { location: { hostname: "localhost" }, setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id: number) { timers.delete(id); } },
    require(id: string) {
      if (id === "vue") return { ...vue, onMounted() {}, onBeforeUnmount(fn: () => void) { unmounts.push(fn); } };
      if (id.endsWith(".vue")) return {};
      if (id === "../stores/gatewayStore") return { useGatewayStore: () => store };
      if (id === "../stores/speechStore") return { useSpeechStore: () => ({ personas: [], async reconcileMicrophone() { reconciled++; }, async refreshPersonas() {}, stopMicrophone() { throw new Error("An endpoint card must not stop the shared microphone"); } }) };
      if (id === "../userFacingError") return { userFacingError: (cause: Error) => cause.message };
      if (id === "vue-router") return { useRouter: () => ({ push() {} }) };
      if (id === "../speech/speechDeliveryMode") return { speechPushModeForHotDelivery: (enabled: boolean) => enabled ? "hot" : "keyword" };
      if (id === "@shared/speechControlContract") return { applySpeechRouteVariableDefaults: () => ({ speechAutoPlay: "true" }) };
      if (id === "../utils/gatewayHelpers") return { configNameFor: (row: any) => row.id, isAdapterDisabled: () => false };
      if (id === "../clipboard") return {};
      if (id === "../routeScopedNavigation") return {};
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

test("Speech navigation and card removal cancel an old autosave instead of saving another Route's draft", async () => {
  const f = fixture("Speech");
  try {
    f.model.setSpeechHotDelivery(true);
    f.store.selectedGateway = { id: "b", agentRoleId: "RoleB", unsaved: "keep" };
    await settle();
    f.flushTimers();
    await settle();
    assert.deepEqual(f.saves, []);
    assert.equal(f.store.selectedGateway.unsaved, "keep");
    f.model.setSpeechHotDelivery(true);
    f.dispose();
    f.flushTimers();
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
