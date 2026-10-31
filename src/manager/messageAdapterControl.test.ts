import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  createMessageAdapterControlOperations,
  MessageAdapterControlService,
  MessageAdapterScanProviderRegistry,
  scanXiaomiHomeEndpoint,
  type MessageAdapterScanResult
} from "./messageAdapterControl.js";

test("Xiaomi Home scan maps the owner health contract without treating pending authorization as connected", () => {
  const pending = scanXiaomiHomeEndpoint({
    status: "authorization_required",
    baseUrl: "http://user:secret@127.0.0.1:8123?token=hidden",
    tokenConfigured: false,
    writeEnabled: false,
    eventMonitor: { enabled: true, connectionState: "authorization_required" },
    cameraCapture: { enabled: false, ready: false, allowedHostCount: 0, inFlight: 0 }
  });
  assert.equal(pending.type, "xiaomiHome");
  assert.equal(pending.label, "米家 / Xiaomi Home");
  assert.equal(pending.endpoints?.[0]?.url, "http://127.0.0.1:8123");
  assert.equal(pending.endpoints?.[0]?.healthy, false);
  assert.equal(pending.requirements?.find(item => item.id === "authorization")?.ok, false);
  assert.match(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /待授权/);
  assert.match(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /米家消息端卡片/);
  assert.doesNotMatch(pending.requirements?.find(item => item.id === "authorization")?.detail ?? "", /环境变量|RABIROUTE_/);
  assert.equal(JSON.stringify(pending).includes("secret"), false);
  assert.equal(JSON.stringify(pending).includes("hidden"), false);

  const ready = scanXiaomiHomeEndpoint({
    status: "ready",
    baseUrl: "http://homeassistant.local:8123",
    tokenConfigured: true,
    writeEnabled: false,
    eventMonitor: { enabled: true, connectionState: "subscribed" },
    cameraCapture: { enabled: true, ready: true, inFlight: 0 }
  });
  assert.equal(ready.endpoints?.[0]?.healthy, true);
  assert.equal(ready.requirements?.find(item => item.id === "event-monitor")?.ok, true);
  assert.match(ready.warnings?.[0] ?? "", /不是 Gateway 常驻 adapter/);
});

function adapterResult(): MessageAdapterScanResult {
  return {
    type: "webhook",
    label: "Webhook",
    maturity: "experimental",
    installed: true
  };
}

test("message adapter service waits for probes that outlive the response deadline", async () => {
  const providers = new MessageAdapterScanProviderRegistry();
  let release!: () => void;
  const probe = new Promise<MessageAdapterScanResult>(resolve => {
    release = () => resolve(adapterResult());
  });
  providers.register({
    type: "webhook",
    label: "Webhook",
    maturity: "experimental",
    scan: () => probe
  });
  const service = new MessageAdapterControlService(providers, 1);

  const result = await service.scanAdapters();
  assert.equal(result.partial, true);
  assert.equal(service.activeProbeCount(), 1);

  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(service.activeProbeCount(), 0);
  await assert.rejects(() => service.scanAdapters(), /stopping or inactive/);
});


async function operationFixture(t: test.TestContext, options: { provider?: Parameters<MessageAdapterScanProviderRegistry["register"]>[0]; napcat?: () => Promise<any>; gatewayPayload?: () => unknown; deadlineMs?: number } = {}) {
  const { ManagerPluginRouteRegistry } = await import("./managerPluginRouteRegistry.js");
  const { markAuthenticatedConnectionRequest } = await import("./connectionRequestAccess.js");
  const providers = new MessageAdapterScanProviderRegistry();
  const unregister = providers.register(options.provider ?? { type: "webhook", label: "fixture", maturity: "experimental", scan: adapterResult });
  const service = new MessageAdapterControlService(providers, options.deadlineMs ?? 100);
  const registry = new ManagerPluginRouteRegistry();
  let scans = 0;
  const definitions = createMessageAdapterControlOperations({ service, scanNapcatHealth: options.napcat ?? (async () => { scans++; return { payload: {}, diagnostics: {}, partial: false, durationMs: 0, deadlineMs: 100 }; }), gatewayPayload: options.gatewayPayload ?? (() => ({ fixture: "native-summary" })) });
  const registration = registry.registerOperations("adapter-control-fixture", definitions);
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer fixture") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await Promise.all([registration.dispose(), service.stop()]); unregister(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (query = "", method = "GET", authenticated = true, rawBody?: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(base + "/api/scan/message-adapters" + query, { method, headers: { ...(authenticated ? { authorization: "Bearer fixture" } : {}), ...(rawBody ? { "content-length": Buffer.byteLength(rawBody) } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, body: raw ? JSON.parse(raw) : null }); });
    }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned adapter scan fixture timed out."))); request.end(rawBody);
  });
  return { definitions, registration, service, providers, send, napcatScans: () => scans };
}

test("executable scan returns native adapter diagnostics and first gatewayId metadata without filtering", async t => {
  const f = await operationFixture(t);
  assert.equal(f.definitions.length, 1); assert.equal(f.definitions[0].contract.operationId, "manager.message-adapters.scan");
  const reply = await f.send("?gatewayId=first&gatewayId=second&ignored=yes");
  assert.equal(reply.status, 200); assert.equal(reply.body.scan.requestedGatewayId, "first");
  assert.equal(reply.body.adapters.webhook.installed, true); assert.equal(reply.body.adapters.webhook.scan.state, "ok");
  assert.equal(reply.body.scan.adapters.webhook.state, "ok"); assert.equal(reply.body.repair.changed, false);
  assert.deepEqual(reply.body.gatewayPayload, { fixture: "native-summary" }); assert.equal(f.napcatScans(), 1);
  assert.equal((await f.send("?gatewayId=")).body.scan.requestedGatewayId, undefined);
  assert.equal((await f.send("", "GET", true, "malformed-body\u0000")).status, 200);
});

test("scan admission requires authenticated ingress and preserves GET-only routing", async t => {
  let probes = 0;
  const f = await operationFixture(t, { provider: { type: "webhook", label: "fixture", maturity: "experimental", scan: () => { probes++; return adapterResult(); } } });
  assert.equal((await f.send("", "GET", false)).status, 401);
  assert.equal((await f.send("", "POST")).status, 405); assert.equal(probes, 0); assert.equal(f.napcatScans(), 0);
});

test("partial native scan is returned while retirement still joins the actual unfinished probe", async t => {
  let release!: () => void;
  const gate = new Promise<MessageAdapterScanResult>(resolve => { release = () => resolve(adapterResult()); });
  const f = await operationFixture(t, { deadlineMs: 1, provider: { type: "webhook", label: "fixture", maturity: "experimental", scan: () => gate } });
  try {
    const reply = await f.send(); assert.equal(reply.status, 200); assert.equal(reply.body.scan.partial, true);
    assert.equal(reply.body.adapters.webhook.scan.state, "timeout"); assert.equal(reply.body.health.adapters.webhook.state, "timeout"); assert.equal(f.service.activeProbeCount(), 1);
    const retired = f.registration.dispose(); let stopped = false; const stop = f.service.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal((await f.send()).status, 404);
    release(); await retired; await stop; assert.equal(f.service.activeProbeCount(), 0);
  } finally { release(); }
});

test("native aggregate failure retains the original 500 code/message response", async t => {
  const f = await operationFixture(t, { napcat: async () => { throw new Error("Controlled native scan failure."); } });
  const reply = await f.send(); assert.equal(reply.status, 500); assert.deepEqual(reply.body, { code: -1, message: "Controlled native scan failure." });
});

test("plugin retirement joins timed-out native NapCat probes before unregistering scan providers", { timeout: 10000 }, async () => {
  const { scanNapcatHealthReadOnly } = await import("../messageEndpoints/napcatHealthScan.js");
  const { ManagerPluginRouteRegistry } = await import("./managerPluginRouteRegistry.js");
  const plugin = await import(new URL("../../plugins/builtin/io.rabiroute.manager.message-adapter-control/1.0.0/manager.mjs", import.meta.url).href);
  const keepAlive = setTimeout(() => {}, 9000);
  let release!: () => void, start!: () => Promise<() => Promise<void>>, operations!: ReturnType<typeof createMessageAdapterControlOperations>;
  const probe = new Promise<Record<string, unknown>>(resolve => { release = () => resolve({ ok: true }); });
  const events: string[] = [], registry = new ManagerPluginRouteRegistry();
  const runtime = {
    MessageAdapterScanProviderRegistry, MessageAdapterControlService, createMessageAdapterControlOperations,
    managerPluginRoutes: { registerOperationsAsync: async (id: string, definitions: typeof operations, signal: AbortSignal) => { operations = definitions; return registry.registerOperationsAsync(id, definitions, signal); } },
    registerBuiltinMessageAdapterScanProviders: (providers: MessageAdapterScanProviderRegistry) => {
      const unregister = providers.register({ type: "webhook", label: "fixture", maturity: "experimental", scan: adapterResult });
      return () => { events.push("providers-unregistered"); unregister(); };
    },
    napcatScanHealthPayload: (trackProbe: <T>(value: Promise<T>) => Promise<T>) => scanNapcatHealthReadOnly({
      runtimes: ["fixture"], gatewayId: value => value, instances: () => ["fixture"], instanceId: value => value,
      instanceEnabled: () => true, instanceMetadata: () => ({}), testHealth: () => trackProbe(probe)
    }, { deadlineMs: 1 }),
    standaloneGatewayPayload: () => ({}),
    speechControl: {}
  };
  try {
    await plugin.activate({ identity: { instanceId: "adapter-control-fixture" }, lifecycle: { signal: new AbortController().signal }, services: { require: () => runtime, provide: () => {} }, contributions: { register: () => {} }, effects: { add: (starter: typeof start) => { start = starter; } } });
    const retire = await start();
    const result = await operations[0].handler({ query: {}, body: undefined } as any);
    assert.equal(result.status, 200); assert.equal((result.body as any).scan.partial, true);
    assert.equal((result.body as any).napcatHealth.fixture.instances.fixture.scanState, "timeout");
    let stopped = false; const stopping = retire().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.deepEqual(events, []);
    release(); await stopping; assert.equal(stopped, true); assert.deepEqual(events, ["providers-unregistered"]);
  } finally { release(); clearTimeout(keepAlive); }
});
