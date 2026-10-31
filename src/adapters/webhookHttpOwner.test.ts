import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";
import type { VoiceTranscriptEventRecord } from "../history.js";
import { acceptWebhookPayload, createWebhookAdapter, type WebhookAdapterOptions, type WebhookAdapterProfile } from "./webhookAdapter.js";
import { rabiLinkWebhookOptions } from "./rabilinkAdapter.js";
import { createWebhookRequestProducer } from "./webhookHttpOwner.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "../manager/apiOperationCatalog.js";
import { createApiDiscoveryOperations } from "../manager/apiDiscoveryRoutes.js";
import { createGatewayListenerRuntime, type GatewayListenerPublication } from "../runtime/gatewayListenerRuntime.js";
// @ts-ignore Source client is exercised against controlled native HTTP listeners.
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };
function request(port: number, method: string, requestPath: string, body: Buffer = Buffer.alloc(0), headers: http.OutgoingHttpHeaders = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, agent: false,
      headers: { connection: "close", "content-length": body.length, ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t: test.TestContext, type: WebhookAdapterProfile["type"] = "webhook", options: WebhookAdapterOptions = {}, webhookPath = "/native") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-webhook-native-"));
  const saved = { dataDir: config.dataDir, memoryDataDir: config.memoryDataDir, routeProfiles: config.routeProfiles };
  Object.assign(config, { dataDir, memoryDataDir: dataDir, routeProfiles: [] });
  let dispose: (() => void | Promise<void>) | undefined;
  t.after(async () => {
    try { await dispose?.(); }
    finally { Object.assign(config, saved); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
  let port = 0;
  const registry = new ManagerPluginRouteRegistry();
  const accepted: Array<{ payload: unknown; bytes: number }> = [];
  const profile: WebhookAdapterProfile = { type, label: "Native fixture", source: type, path: webhookPath, port: 0,
    acceptedTypes: ["webhook.text", "voice_transcript"], routeKind: "voice_transcript", missingTextMessage: "Missing fixture text" };
  const adapter = createWebhookAdapter(profile, {
    apiOperations: { registerExternalListener: definition => registry.registerExternalListener("webhook-fixture", definition) },
    acceptPayload(_profile, _path, payload, bytes): VoiceTranscriptEventRecord {
      accepted.push({ payload, bytes });
      return { time: 0, rawMessage: "controlled", messageId: "native-message" };
    },
    ...options,
    onListening({ server }) {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No native listener address.");
      port = address.port;
    }
  });
  const acquired = await adapter.start();
  if (typeof acquired !== "function") throw new Error("Expected adapter disposer.");
  dispose = acquired;
  return { port, dataDir, accepted, dispose: acquired, profile, registry };
}

for (const type of ["webhook", "fennenote", "rabilink"] as const) {
  test(`${type} native ready/message uses the original HTTP owner and ignores unknown query/content type`, async t => {
    const ctx = await fixture(t, type, type === "rabilink" ? rabiLinkWebhookOptions() : {});
    const ready = await request(ctx.port, "GET", "/native?unknown=value", Buffer.from("ignored"));
    assert.equal(ready.status, 200);
    assert.deepEqual(JSON.parse(ready.body), { ok: true, adapterType: type, label: ctx.profile.label, path: "/native", port: 0, status: "ready" });
    const accepted = await request(ctx.port, "POST", "/native?unknown=value", Buffer.from('{"text":"hello"}'), { "content-type": "image/png" });
    assert.equal(accepted.status, type === "rabilink" ? 200 : 204);
    assert.equal(ctx.accepted.length, 1);
    assert.deepEqual(ctx.accepted[0]?.payload, { text: "hello" });
    if (type === "rabilink") assert.equal(JSON.parse(accepted.body).messageId, "native-message");
    const unsupported = await request(ctx.port, "PATCH", "/native");
    assert.equal(unsupported.status, 404);
    assert.equal(unsupported.body, "");
    for (const [method, pathname] of [["HEAD", "/native"], ["OPTIONS", "/native"], ["GET", "/unknown"], ["POST", "/unknown"]]) {
      const rejected = await request(ctx.port, method!, pathname!);
      assert.equal(rejected.status, 404);
      assert.equal(rejected.body, "");
      assert.equal(rejected.headers.allow, undefined);
    }
    assert.equal(ctx.registry.catalogSnapshot().operations.length, type === "rabilink" ? 3 : 2);
    assert.equal(ctx.accepted.length, 1);
  });
}

test("native POST retains replacement UTF8, empty object and text 500 errors", async t => {
  const ctx = await fixture(t);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.equal((await request(ctx.port, "POST", "/native", invalidUtf8)).status, 204);
  assert.deepEqual(ctx.accepted[0], { payload: { text: "\ufffd" }, bytes: Buffer.byteLength('{"text":"\ufffd"}') });
  assert.equal((await request(ctx.port, "POST", "/native")).status, 204);
  assert.deepEqual(ctx.accepted[1]?.payload, {});
  const malformed = await request(ctx.port, "POST", "/native", Buffer.from("{"));
  assert.equal(malformed.status, 500);
  assert.match(malformed.body, /JSON|property name/i);
  assert.equal(malformed.headers["content-type"], undefined);
  assert.equal(ctx.accepted.length, 2);
});

test("all seven native business operations publish from actual listener owners and invoke through discovery without node credentials", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-webhook-discovery-"));
  const saved = { dataDir: config.dataDir, memoryDataDir: config.memoryDataDir, routeProfiles: config.routeProfiles };
  Object.assign(config, { dataDir, memoryDataDir: dataDir, routeProfiles: [] });
  const identity = { applicationGenerationId: "webhook-fixture-app", managerInstanceId: "webhook-fixture-manager", pluginGenerationId: "webhook-fixture-plugins" };
  const manager = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  let published: GatewayListenerPublication | undefined;
  const gateway = createGatewayListenerRuntime({ identity: { gatewayId: "native-fixture", gatewayGenerationId: "fixture-generation", pid: process.pid }, publish: value => { published = value; } });
  const disposers: Array<() => void | Promise<void>> = [];
  const nativeHeaders: http.IncomingHttpHeaders[] = [], accepted: unknown[] = [];
  let managerServer: http.Server | undefined;
  t.after(async () => {
    try {
      await Promise.all(disposers.map(dispose => dispose())); await gateway.dispose();
      if (managerServer) { managerServer.closeAllConnections(); await new Promise<void>(resolve => managerServer!.close(() => resolve())); }
    } finally { Object.assign(config, saved); fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
  for (const type of ["webhook", "fennenote", "rabilink"] as const) {
    const profile: WebhookAdapterProfile = { type, label: type, source: type, port: 0, path: `/${type}`, acceptedTypes: ["webhook.text"], routeKind: "voice_transcript", missingTextMessage: "missing text" };
    const adapter = createWebhookAdapter(profile, {
      ...(type === "rabilink" ? rabiLinkWebhookOptions() : {}),
      apiOperations: { registerExternalListener: definition => gateway.registerExternalListener(`native-${type}`, definition) },
      operationId: name => gateway.operationId(name),
      acceptPayload(_profile, _pathname, payload) { accepted.push(payload); return { time: 0, rawMessage: "controlled", messageId: "fixture-message" }; },
      onListening({ server }) { server.prependListener("request", req => { nativeHeaders.push(req.headers); }); }
    });
    const dispose = await adapter.start(); if (typeof dispose !== "function") throw new Error("Expected native listener cleanup."); disposers.push(dispose);
  }
  const remove = manager.registerExternalListenerSource("trusted-fixture-gateway", { isCurrent: () => true, read: () => published?.listeners ?? [] });
  disposers.push(remove);
  const discovery = manager.registerOperations("discovery-fixture", createApiDiscoveryOperations(manager)); disposers.push(() => discovery.dispose());
  const external = manager.catalogSnapshot().operations.filter(value => value.binding?.kind === "external-listener");
  assert.equal(external.length, 7);
  assert.ok(external.every(value => value.contract.exposure === "public" && !value.contract.operationId.endsWith(".rejected")));
  assert.equal(new Set(external.map(value => value.binding!.leaseId)).size, 3);
  assert.ok(external.every(value => value.binding!.address.port > 0 && value.binding!.address.hostname === "127.0.0.1"));
  const document = (await apiCatalogOpenApi(manager.catalogSnapshot()));
  assert.equal((document["x-rabiroute-external-listeners"] as unknown[]).length, 3);
  managerServer = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-node");
    const url = new URL(req.url ?? "/", "http://fixture");
    if (url.pathname === "/meta") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!manager.handle(req, url, res)) res.writeHead(404).end();
  });
  await new Promise<void>(resolve => managerServer!.listen(0, "127.0.0.1", resolve));
  const address = managerServer.address(); if (!address || typeof address === "string") throw new Error("No discovery listener.");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: origin, credential: "fixture-node", fetchImpl: (url, options) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    assert.equal(new URL(target).origin, origin); return fetch(url, options);
  } });
  for (const operation of external) {
    const result = await client.invokeOperation(operation.contract.operationId, operation.contract.method === "POST"
      ? { bodyBytes: Buffer.from('{"text":"controlled"}'), headers: { "content-type": "image/png" } } : { query: { unknown: "kept" } });
    if (typeof result.statusCode !== "number") throw new Error("Native invocation returned no HTTP status.");
    assert.ok([200, 204].includes(result.statusCode));
  }
  assert.equal(accepted.length, 3);
  assert.equal(nativeHeaders.length, 7);
  for (const headers of nativeHeaders) {
    assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
    assert.equal(headers["x-rabiroute-agent-id"], undefined); assert.equal(headers["x-rabiroute-expected-manager-instance-id"], undefined);
    assert.equal(typeof headers["x-rabiroute-listener-lease"], "string");
  }
  const message = external.find(value => value.contract.method === "POST")!;
  const port = message.binding?.address.port;
  if (typeof port !== "number" || port < 1) throw new Error("Native publication has no bound port.");
  const invalid = await request(port, "POST", message.contract.pathTemplate, Buffer.from("{}"), { "x-rabiroute-listener-lease": "retired" });
  assert.equal(invalid.status, 409); assert.equal(accepted.length, 3);
  await Promise.all(disposers.slice(0, 3).map(dispose => dispose()));
  assert.equal(manager.catalogSnapshot().operations.filter(value => value.binding?.kind === "external-listener").length, 0);
});

test("native POST keeps original 1MiB boundary and destroys oversized requests before accepting", async t => {
  const ctx = await fixture(t);
  const exact = Buffer.from('"' + "x".repeat(1024 * 1024 - 2) + '"');
  assert.equal((await request(ctx.port, "POST", "/native", exact)).status, 204);
  await assert.rejects(request(ctx.port, "POST", "/native", Buffer.concat([exact, Buffer.from(" ")])), /socket hang up|ECONNRESET/);
  assert.equal(ctx.accepted.length, 1);
});

test("RabiLink replies retains trailing slash, double slash, native JSONL cursor and query aliases", async t => {
  const ctx = await fixture(t, "rabilink", rabiLinkWebhookOptions(), "  native/  ");
  fs.writeFileSync(path.join(ctx.dataDir, "rabilink-replies.jsonl"), '{"id":"first","text":"one"}\ninvalid\n{"id":"second","text":"two"}\n');
  const replies = await request(ctx.port, "GET", "/native//replies?after=first&limit=1&unknown=1", Buffer.from("ignored"));
  assert.equal(replies.status, 200);
  const result = JSON.parse(replies.body);
  assert.deepEqual(result.replies, [{ id: "second", text: "two" }]);
  assert.equal(result.cursor, "second");
  assert.equal((await request(ctx.port, "GET", "/native/replies")).status, 404);
  assert.equal((await request(ctx.port, "GET", "/native/")).status, 200);
});

test("native acceptWebhookPayload retains temporary history and rejects unsupported or missing text without delivery", async t => {
  const ctx = await fixture(t, "webhook", {
    acceptPayload: (profile, webhookPath, payload, bodyBytes) => acceptWebhookPayload(profile, webhookPath, payload, bodyBytes, { forward: false, recordFirst: false })
  });
  assert.equal((await request(ctx.port, "POST", "/native", Buffer.from('{"type":"webhook.text","text":"stored","senderStableId":"claim"}'))).status, 204);
  const stored = fs.readFileSync(path.join(ctx.dataDir, "voice-transcripts.jsonl"), "utf8");
  assert.match(stored, /stored/);
  assert.doesNotMatch(stored, /"senderIdentityTrusted":true/);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, "agent-packets.jsonl")), false);
  const unsupported = await request(ctx.port, "POST", "/native", Buffer.from('{"type":"other","text":"no"}'));
  assert.equal(unsupported.status, 500);
  assert.match(unsupported.body, /Unsupported/);
  const missing = await request(ctx.port, "POST", "/native", Buffer.from("{}"));
  assert.equal(missing.status, 500);
  assert.equal(missing.body, "Missing text");
});

test("listener retirement waits for an accepted callback after closing its actual socket", async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = http.createServer((_req, response) => producer.run(async () => { entered(); await blocked; }, response));
  const producer = createWebhookRequestProducer(server);
  t.after(async () => { release(); await producer.close(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No native listener.");
  const pending = request(address.port, "GET", "/").catch(() => undefined);
  await started;
  let closed = false;
  const close = producer.close().then(() => { closed = true; });
  await pending;
  assert.equal(closed, false);
  assert.equal(producer.activeRequestCount(), 1);
  release();
  await close;
  assert.equal(producer.activeRequestCount(), 0);
  assert.equal(server.listening, false);
});

test("adapter retirement closes an incomplete native body and joins repeated disposal without accepting it", async t => {
  const ctx = await fixture(t);
  let connected!: () => void;
  const sent = new Promise<void>(resolve => { connected = resolve; });
  const closed = new Promise<void>(resolve => {
    const req = http.request({ hostname: "127.0.0.1", port: ctx.port, path: "/native", method: "POST", agent: false,
      headers: { "content-length": 1000 } });
    req.on("error", () => undefined);
    req.on("close", resolve);
    req.flushHeaders();
    req.write('{"text":"pending', connected);
  });
  await sent;
  const first = ctx.dispose();
  const second = ctx.dispose();
  assert.equal(first, second);
  await Promise.all([first, closed]);
  assert.deepEqual(ctx.accepted, []);
  await assert.rejects(request(ctx.port, "GET", "/native"), /ECONNREFUSED|socket hang up|ECONNRESET/);
});
