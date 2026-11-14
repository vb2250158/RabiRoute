import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import * as gatewayModel from "../../src/shared/gatewayConfigModel";
import * as endpointTypes from "../../src/shared/messageEndpointTypes";
import * as speechContract from "../../src/shared/speechControlContract";
import * as napcatContract from "../../src/shared/napcatStateContract";
import * as endpoint from "../src/napcatRuntimeEndpoint";
import * as httpEndpoint from "../src/webhookRuntimeEndpoint";

function loadModule(source: string, imports: (name: string) => unknown, globals = {}) {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, require: imports, ...globals });
  return module.exports;
}

const helpers = loadModule(fs.readFileSync(new URL("../src/utils/gatewayHelpers.ts", import.meta.url), "utf8"), name => {
  if (name === "@shared/gatewayConfigModel") return gatewayModel;
  if (name === "@shared/messageEndpointTypes") return endpointTypes;
  if (name === "@shared/speechControlContract") return speechContract;
  if (name.endsWith("/speechDeliveryMode")) return { SPEECH_ROUTE_AUTO_SUBMIT: true };
  if (name === "../pluginCatalogStore") return {};
  if (name === "../napcatRuntimeEndpoint") return endpoint;
  throw new Error(`Unexpected helper import ${name}`);
});

function runtime() {
  return { running: true, pid: 123, startedAt: "2026-11-08T00:00:00Z", gatewayStatus: {
    pid: 123, updatedAt: "2026-11-08T00:00:02Z", gatewayGenerationId: "generation",
    messageAdapters: { napcat: { updatedAt: "2026-11-08T00:00:02Z" } },
    napcatInstances: { bot: { gatewayPort: 31415, listenerReady: true, listenerLeaseId: "lease", gatewayGenerationId: "generation", connected: false } }
  } };
}

function component(quick = false, overrides: Record<string, unknown> = {}, sourcePath?: string) {
  const gateway = { id: "original", gatewayPort: 0, messageAdapters: ["napcat"], messageAdapterType: "napcat", enabled: true,
    napcatHttpUrl: "http://127.0.0.1:3000", napcatInstances: [{ id: "bot", gatewayPort: 0, enabled: true, httpUrl: "http://127.0.0.1:3000", webuiUrl: "http://127.0.0.1:6099/webui" }] };
  const calls: Array<{ kind: string; value?: any }> = [];
  const store = vue.reactive({ loading: true, dirty: false, error: "", selectedGateway: gateway, selectedRuntime: runtime(),
    gateways: [gateway], managerRows: [], meta: {}, networkOptions: {},
    touch() { helpers.applyAdapterDefaults(store.selectedGateway); store.dirty = true; },
    async save(id?: string) { calls.push({ kind: "save", value: { id, port: store.selectedGateway.gatewayPort, instancePort: store.selectedGateway.napcatInstances[0].gatewayPort } }); },
    async load() { calls.push({ kind: "load" }); }, ...overrides });
  const source = fs.readFileSync(new URL(sourcePath ?? (quick ? "../src/components/QuickSetupDialog.vue" : "../../src/plugins/io.rabiroute.endpoint.napcat/web/messageEndpoints/NapcatEndpointCard.vue"), import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "napcat-port-settings" });
  const definition = loadModule(script.content, name => {
    if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
    if (name === "vue-router") return { useRoute: () => ({}), useRouter: () => ({}) };
    if (name.endsWith("/stores/gatewayStore")) return { useGatewayStore: () => store };
    if (name.endsWith("/utils/gatewayHelpers")) return helpers;
    if (name.endsWith("/napcatRuntimeEndpoint")) return endpoint;
    if (name.endsWith("/webhookRuntimeEndpoint")) return httpEndpoint;
    if (name.endsWith("/i18n/index")) return { useI18n: () => ({ t: (key: string) => key }) };
    if (name.endsWith("/userFacingError")) return { userFacingError: (error: Error) => error.message };
    if (name === "@shared/napcatStateContract") return napcatContract;
    if (name === "@shared/gatewayConfigModel") return gatewayModel;
    if (name.endsWith("/clipboard")) return { copyTextToClipboard: async (text: string) => { calls.push({ kind: "copy", value: text }); } };
    return {};
  }, { window: { clearTimeout() {}, setTimeout, location: { hostname: "127.0.0.1" } }, URL, URLSearchParams, console,
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ kind: "request", value: { url, body: JSON.parse(String(init.body)) } });
      return { ok: true, json: async () => ({ ok: true, connected: false, needsUserAction: true }) };
    }
  }).default;
  const scope = vue.effectScope();
  const props = vue.reactive({ modelValue: false });
  const model = scope.run(() => definition.setup(props, { expose() {}, emit() {} }));
  return { model, store, calls, dispose: () => scope.stop() };
}

test("new and normalized NapCat preferences retain automatic zero and explicit ports", () => {
  const gateway = helpers.createDefaultGateway(1);
  helpers.applyAdapterDefaults(gateway);
  assert.equal(gateway.gatewayPort, 0);
  assert.equal(gateway.napcatInstances[0].gatewayPort, 0);
  gateway.napcatInstances[0].gatewayPort = 23456;
  helpers.applyAdapterDefaults(gateway);
  assert.equal(gateway.napcatInstances[0].gatewayPort, 23456);
});

test("Speech defaults defer its local URL to the runtime owner and retain an explicit worker", () => {
  const gateway = helpers.createDefaultGateway(1);
  gateway.messageAdapters = ["speech"]; gateway.messageAdapterType = "speech";
  helpers.applyAdapterDefaults(gateway);
  assert.equal(gateway.pipeline.ttsWorkerUrl, "");
  gateway.pipeline.ttsWorkerUrl = "https://explicit.example/v1/audio/speech";
  helpers.applyAdapterDefaults(gateway);
  assert.equal(gateway.pipeline.ttsWorkerUrl, "https://explicit.example/v1/audio/speech");
});

test("connection diagnostics use the native WS publication and hide withdrawn diagnostic ports", () => {
  const gateway = helpers.createDefaultGateway(1);
  gateway.napcatInstances = [{ id: "bot", gatewayPort: 0, enabled: true }];
  const snapshot = runtime();
  assert.match(helpers.adapterErrorsFor("napcat", gateway, snapshot).join(" "), /ws:\/\/127\.0\.0\.1:31415/);
  snapshot.gatewayStatus.napcatInstances.bot.listenerReady = false;
  const message = helpers.adapterErrorsFor("napcat", gateway, snapshot).join(" ");
  assert.match(message, /监听尚未就绪/);
  assert.doesNotMatch(message, /ws:\/\//);
});

test("port repair persists zero before the native ensure-ready request without inventing a listening address", async () => {
  const fixture = component();
  try {
    const instance = fixture.store.selectedGateway.napcatInstances[0];
    instance.gatewayPort = 23456;
    await fixture.model.fixNapcatPorts(instance);
    assert.equal(fixture.calls[0].kind, "save");
    assert.equal(fixture.calls[0].value.port, 0);
    assert.equal(fixture.calls[0].value.instancePort, 0);
    assert.equal(fixture.calls[1].kind, "request");
    assert.equal(fixture.calls[1].value.url, "/api/message/napcat-ensure-ready");
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls[1].value.body)), { gatewayId: "original", instanceId: "bot" });
    assert.match(fixture.model.napcatPortFixResult.value.bot.message, /保存/);
    assert.doesNotMatch(fixture.model.napcatPortFixResult.value.bot.message, /已连接/);
    assert.equal(fixture.model.napcatInstanceWsUrl(instance), "ws://127.0.0.1:31415");
    fixture.store.selectedRuntime.gatewayStatus.napcatInstances.bot.listenerReady = false;
    assert.equal(fixture.model.napcatInstanceWsUrl(instance), "");
  } finally { fixture.dispose(); }
});

test("port repair never reconfigures a different Route after its original save completes", async () => {
  let finishSave!: () => void;
  const fixture = component(false, { save: () => new Promise<void>(resolve => { finishSave = resolve; }) });
  try {
    const repair = fixture.model.fixNapcatPorts(fixture.store.selectedGateway.napcatInstances[0]);
    fixture.store.selectedGateway = { ...fixture.store.selectedGateway, id: "other" };
    finishSave(); await repair;
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.store.error, "");
  } finally { fixture.dispose(); }
});

test("failed settings save does not call ensure-ready or claim a repaired connection", async () => {
  const fixture = component(false, { save: async () => { throw new Error("Save failed"); } });
  try {
    await fixture.model.fixNapcatPorts(fixture.store.selectedGateway.napcatInstances[0]);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.model.napcatPortFixResult.value.bot.ok, false);
    assert.equal(fixture.store.error, "Save failed");
  } finally { fixture.dispose(); }
});

test("Quick Setup accepts automatic zero and copies only the current live publication", async () => {
  const fixture = component(true);
  try {
    assert.equal(fixture.model.form.gatewayPort, 0);
    assert.equal(fixture.model.messageReady.value, true);
    await fixture.model.copyNapcatWsUrl();
    assert.equal(fixture.calls[0].value, "ws://127.0.0.1:31415");
    fixture.store.selectedRuntime.gatewayStatus.napcatInstances.bot.listenerReady = false;
    await fixture.model.copyNapcatWsUrl();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.model.copyResult.value, "等待监听就绪");
    fixture.model.form.gatewayPort = -1;
    assert.equal(fixture.model.messageReady.value, false);
  } finally { fixture.dispose(); }
});

function publishHttp(fixture: ReturnType<typeof component>, type: string) {
  const snapshot = fixture.store.selectedRuntime.gatewayStatus as Record<string, any>;
  snapshot.messageAdapters[type] = { updatedAt: "2026-11-08T00:00:02Z", listenerReady: true,
    listenerLeaseId: "http-lease", gatewayGenerationId: "generation" };
  snapshot.httpCallbacks = { ...snapshot.httpCallbacks, [type]: { url: `http://127.0.0.1:31416/${type}` } };
}

test("named HTTP cards retain automatic preferences and expose only the original live URL", async () => {
  for (const type of ["feishu", "rabilink"]) {
    const name = type === "feishu" ? "Feishu" : "Rabilink";
    const fixture = component(false, {}, `../../src/plugins/io.rabiroute.endpoint.${type}/web/messageEndpoints/${name}EndpointCard.vue`);
    try {
      fixture.store.selectedGateway.messageAdapters = [type];
      fixture.store.selectedGateway.messageAdapterType = type;
      fixture.model.setWebhookPort?.(type, 0);
      publishHttp(fixture, type);
      assert.equal(fixture.model.webhookPortFor(type), 0);
      assert.equal(fixture.model.callbackUrl(), `http://127.0.0.1:31416/${type}`);
      (fixture.store.selectedRuntime.gatewayStatus.messageAdapters as Record<string, any>)[type].listenerReady = false;
      assert.equal(fixture.model.callbackUrl(), "");
      if (type === "rabilink") {
        assert.equal(fixture.model.webhookCurl(type), "");
        await fixture.model.copyText(fixture.model.callbackUrl());
        assert.equal(fixture.calls.length, 0);
      }
    } finally { fixture.dispose(); }
  }
});

test("runtime diagnostics follow NapCat, Feishu and RabiLink publications without saved-port fallbacks", () => {
  const fixture = component(false, {}, "../../src/plugins/io.rabiroute.manager.diagnostics/web/pages/RuntimeLogPage.vue");
  try {
    assert.equal(fixture.model.napcatAddress(), "ws://127.0.0.1:31415");
    for (const type of ["rabilink", "feishu"]) {
      publishHttp(fixture, type);
      assert.equal(fixture.model.webhookAddress(type), `http://127.0.0.1:31416/${type}`);
      (fixture.store.selectedRuntime.gatewayStatus.messageAdapters as Record<string, any>)[type].listenerReady = false;
      assert.equal(fixture.model.webhookAddress(type), "");
    }
    fixture.store.selectedRuntime.running = false;
    assert.equal(fixture.model.napcatAddress(), "");
  } finally { fixture.dispose(); }
});
