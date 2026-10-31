import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeManagerApiClient, mapXiaomiHomeAction, normalizeHomeAssistantState, xiaomiHomeActionSatisfied } from "./managerApi.js";
import { normalizeXiaomiHomeRuntimeSettings } from "./settingsRuntime.js";

const binding = { mediaPlayerEntityId: "media_player.speaker", notifyEntityId: "notify.speaker_text", encoding: "json-array" as const };
const state = (entityId: string, features = 16384 | 1 | 4 | 8 | 32) => ({
  entity_id: entityId, state: entityId.startsWith("notify.") ? "unknown" : "on",
  attributes: { supported_features: features, "action params": "[Text(str)]" }, last_updated: "2026-10-01T00:00:00Z"
});
const action = (capability: string, args: Record<string, unknown> = {}) => ({ resourceId: "home:ha:media_player.speaker", capability, arguments: args, expectedStateVersion: "ha:before" });

test("media discovery reflects provider feature bits; arbitrary notify directives remain read-only", () => {
  assert.deepEqual(normalizeHomeAssistantState(state("media_player.speaker", 1 | 4)).capabilities,
    ["home.resource.read@1", "home.media.pause@1", "home.media.set_volume@1"]);
  assert.deepEqual(normalizeHomeAssistantState(state("notify.any_action")).capabilities, ["home.resource.read@1"]);
  assert.deepEqual(normalizeHomeAssistantState(state("media_player.speaker", 0)).capabilities, ["home.resource.read@1"]);
});

test("bounded typed arguments retain schemas while Home Assistant owns media identifiers", () => {
  for (const args of [{volume: null}, {volume: "0.5"}, {volume: true}, {volume: 1.1}, {volume: 0.2, entity_id: "other"}]) assert.throws(() => mapXiaomiHomeAction(action("home.media.set_volume@1", args)));
  for (const url of ["media-source://media_source/local/movie.mp4", "https://example.org/a?signature=fixture", "https://example.org/a#fragment"]) assert.equal(mapXiaomiHomeAction(action("home.media.play_media@1", {url, mediaType: "video/mp4"})).data.media_content_id, url);
  assert.throws(() => mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "x".repeat(1001)}), [binding]));
  assert.throws(() => mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "hello"})));
  assert.throws(() => mapXiaomiHomeAction(action("home.media.play@1", JSON.parse('{"toString":"injected"}'))));
  assert.throws(() => mapXiaomiHomeAction({...action("home.media.play@1"), arguments: null as never}));
  const withoutVolume = normalizeHomeAssistantState(state("media_player.speaker"));
  withoutVolume.attributes.volume_level = null;
  assert.equal(xiaomiHomeActionSatisfied(action("home.media.set_volume@1", {volume: 0}), withoutVolume), false);
  assert.deepEqual(mapXiaomiHomeAction(action("home.speaker.speak@1", {text: "yes\n\"hello\""}), [binding]).data,
    {entity_id: "notify.speaker_text", message: JSON.stringify(["yes\n\"hello\""])});
  assert.throws(() => mapXiaomiHomeAction({...action("home.speaker.speak@1", {text: "hello"}), resourceId: "home:ha:notify.any_action"}, [binding]));
});

test("bindings are explicit, unique, revisioned settings and have one owner", () => {
  const defaults = normalizeXiaomiHomeRuntimeSettings({});
  assert.deepEqual(defaults.speechBindings, []);
  assert.deepEqual(normalizeXiaomiHomeRuntimeSettings({...defaults, speechBindings: [binding]}).speechBindings, [binding]);
  for (const speechBindings of [[binding, binding], [{...binding, notifyEntityId: "switch.outlet"}], [{...binding, encoding: "raw-service"}], [{...binding, service: "execute"}]]) assert.throws(() => normalizeXiaomiHomeRuntimeSettings({...defaults, speechBindings}));
});

test("speech is accepted once, persists across client restart, is queryable offline and does not store text", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-"));
  let posts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/api/services/")) {
      posts++;
      assert.ok(String(input).endsWith("/notify/send_message"));
      assert.deepEqual(JSON.parse(String(init?.body)), {entity_id: binding.notifyEntityId, message: '["private utterance"]'});
      return new Response("[]");
    }
    return new Response(JSON.stringify(state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId)));
  };
  const config = {runtimeDir, writeEnabled: false, speechBindings: [binding]};
  try {
    const client = new XiaomiHomeManagerApiClient(config, fetchImpl, "private-token");
    const resource = await client.getResource("home:ha:media_player.speaker");
    const request = {...action("home.speaker.speak@1", {text: "private utterance"}), expectedStateVersion: resource.stateVersion};
    const [receipt, duplicate] = await Promise.all([client.executeAction(request, "speech-one"), client.executeAction(request, "speech-one")]);
    assert.equal(receipt.status, "accepted"); assert.equal(receipt.confirmation, "provider_acceptance"); assert.deepEqual(receipt, duplicate); assert.equal(posts, 1);
    const restarted = new XiaomiHomeManagerApiClient(config, async () => {throw new Error("offline");}, "private-token");
    assert.deepEqual(await restarted.executeAction(request, "speech-one"), receipt);
    assert.deepEqual(restarted.getActionReceipt("speech-one").receipt, receipt);
    assert.throws(() => restarted.getActionReceipt("not-found"), /No action receipt/);
    await assert.rejects(() => restarted.executeAction({...request, arguments: {text: "changed"}}, "speech-one"), /another action payload/);
    const files = fs.readdirSync(path.join(runtimeDir, "data/xiaomi-home-actions")).filter(name => name.endsWith(".json"));
    const stored = files.map(name => fs.readFileSync(path.join(runtimeDir, "data/xiaomi-home-actions", name), "utf8")).join("");
    assert.doesNotMatch(stored, /private utterance|private-token/);
  } finally { fs.rmSync(runtimeDir, {recursive: true, force: true}); }
});

test("unsupported, unavailable or changed speech parameter schemas never publish a POST; dry-run never speaks", async () => {
  for (const mode of ["unsupported", "unavailable", "schema", "dryRun"] as const) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-")); let posts = 0;
    try {
      const client = new XiaomiHomeManagerApiClient({runtimeDir, writeEnabled: true, speechBindings: [binding]}, async input => {
        if (String(input).includes("/api/services/")) { posts++; return new Response("[]"); }
        const current = state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId, mode === "unsupported" ? 0 : 16384);
        if (mode === "unavailable" && current.entity_id.startsWith("notify.")) current.state = "unavailable";
        if (mode === "schema") current.attributes["action params"] = "[Command(str), Execute(bool)]";
        return new Response(JSON.stringify(current));
      }, "test-token");
      const current = await client.getResource("home:ha:media_player.speaker");
      const request = mode === "unsupported" ? action("home.media.play@1") : action("home.speaker.speak@1", {text: "hello"});
      const receipt = await client.executeAction({...request, expectedStateVersion: current.stateVersion, dryRun: mode === "dryRun"}, `speech-${mode}`);
      assert.equal(receipt.status, mode === "dryRun" ? "planned" : "failed"); assert.equal(posts, 0);
    } finally {fs.rmSync(runtimeDir, {recursive: true, force: true});}
  }
});

test("lost speech POST response is uncertain across restart; state cannot prove audibility and recovery never resends", async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-media-test-")); let posts = 0;
  const fake: typeof fetch = async input => {
    if (String(input).includes("/api/services/")) { posts++; throw new TypeError("lost private response"); }
    return new Response(JSON.stringify(state(String(input).includes("notify.") ? binding.notifyEntityId : binding.mediaPlayerEntityId)));
  };
  try {
    const config = {runtimeDir, writeEnabled: true, speechBindings: [binding]};
    const client = new XiaomiHomeManagerApiClient(config, fake, "token");
    const current = await client.getResource("home:ha:media_player.speaker");
    const request = {...action("home.speaker.speak@1", {text: "hello"}), expectedStateVersion: current.stateVersion};
    await assert.rejects(() => client.executeAction(request, "speech-lost"), /uncertain/);
    assert.equal(client.getActionReceipt("speech-lost").state, "uncertain");
    await assert.rejects(() => new XiaomiHomeManagerApiClient(config, fake, "token").executeAction(request, "speech-lost"), /uncertain/);
    assert.equal(posts, 1);
  } finally {fs.rmSync(runtimeDir, {recursive: true, force: true});}
});

test("Agent entry catalog exposes media capabilities, public settings and bounded native receipt lookup", { timeout: 15000 }, async t => {
  const { createServer } = await import("node:http");
  const { createXiaomiHomeManagerOperations } = await import("./managerOperations.js");
  const { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } = await import("./settingsRuntime.js");
  const { XiaomiHomeArtifactStore } = await import("./artifactStore.js");
  const { XiaomiHomeCredentialStore } = await import("./credentials.js");
  const { ManagerPluginRouteRegistry } = await import("../../manager/managerPluginRouteRegistry.js");
  const { LanAgentAuthority } = await import("../../manager/lanAgentAuthority.js");
  const { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } = await import("../../manager/lanAgentRequestAccess.js");
  const { markAuthenticatedConnectionRequest } = await import("../../manager/connectionRequestAccess.js");
  const { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } = await import("../../manager/lanAgentBodyAuthority.js");
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-catalog-"));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(dispose => dispose()));
    assert.equal(path.dirname(path.resolve(runtimeDir)), path.resolve(os.tmpdir()));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    assert.ok(results.every(result => result.status === "fulfilled"));
  });
  const baseUrl = "http://127.0.0.1", calls: string[] = [];
  const credentials = new XiaomiHomeCredentialStore(runtimeDir, {
    scheme: "test-protector-v1", protect: value => Buffer.from(value).toString("base64"),
    unprotect: value => Buffer.from(value, "base64").toString()
  });
  credentials.write("owned-test-home-token", baseUrl, {});
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, baseUrl); calls.push((init?.method || "GET") + " " + url.pathname);
    assert.notEqual(init?.method, "POST", "Receipt rehearsal cannot dispatch a real media action.");
    if (url.pathname === "/api/") return new Response("{}");
    const entityId = url.pathname.slice("/api/states/".length);
    assert.ok([binding.mediaPlayerEntityId, binding.notifyEntityId].includes(entityId));
    return new Response(JSON.stringify(state(entityId)));
  };
  const runtime = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(runtimeDir, { baseUrl, eventMonitorEnabled: false, speechBindings: [binding] }), new XiaomiHomeArtifactStore(runtimeDir), { env: {}, fetchImpl, deliverEvent: async () => { throw new Error("No external delivery is permitted."); } }, credentials);
  cleanup.push(() => runtime.stop());
  const fence = { applicationGenerationId: "owned-catalog-generation", managerInstanceId: "owned-catalog-manager" };
  const registry = new ManagerPluginRouteRegistry();
  const bundle = createXiaomiHomeManagerOperations({ runtime, lifecycleFence: fence, deliverEvent: async () => { throw new Error("No external delivery is permitted."); } });
  const operations = registry.registerOperations("xiaomi-catalog-fixture", bundle.operations), proxies = registry.registerHttpProxies("xiaomi-catalog-fixture", bundle.proxies);
  cleanup.push(() => operations.dispose(), () => proxies.dispose());
  const authority = new LanAgentAuthority({ statePath: path.join(runtimeDir, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-catalog-node");
  const server = createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (suffix: string, init: RequestInit = {}) => fetch("http://127.0.0.1:" + address.port + "/api/agent/xiaomi-home" + suffix, { ...init, headers: { authorization: "Bearer " + credential.token, "content-type": "application/json", ...init.headers } });
  const catalog = registry.catalogSnapshot().operations;
  assert.equal(catalog.length, 53); assert.ok(catalog.every(row => row.contract.exposure === "public"));
  for (const [method, suffix] of [["GET", "/health"], ["GET", "/capabilities"], ["GET", "/resources/:resourceId"], ["GET", "/action-requests"], ["GET", "/settings"], ["PUT", "/settings"]]) assert.ok(catalog.some(row => row.contract.method === method && row.contract.pathTemplate === "/api/agent/xiaomi-home" + suffix));
  assert.equal((await request("/health")).status, 200); assert.equal((await request("/settings")).status, 200);
  const capabilities = await request("/capabilities"); assert.equal(capabilities.status, 200);
  const advertised = (await capabilities.json()).data;
  assert.ok(advertised.actions.some((entry: { capability: string }) => entry.capability === "home.media.set_volume@1"));
  assert.ok(advertised.actions.some((entry: { capability: string }) => entry.capability === "home.speaker.speak@1"));
  const detail = await request("/resources/" + encodeURIComponent("home:ha:media_player.speaker")); assert.equal(detail.status, 200);
  const resource = (await detail.json()).data; assert.ok(resource.capabilities.includes("home.media.set_volume@1")); assert.ok(resource.capabilities.includes("home.speaker.speak@1"));
  const key = "catalog-media-receipt-0001";
  const planned = await request("/action-requests", { method: "POST", headers: { "idempotency-key": key, "x-rabiroute-expected-application-generation-id": fence.applicationGenerationId, "x-rabiroute-expected-manager-instance-id": fence.managerInstanceId }, body: JSON.stringify({ ...action("home.media.set_volume@1", { volume: 0.3 }), expectedStateVersion: resource.stateVersion, dryRun: true }) });
  assert.equal(planned.status, 202); assert.equal((await planned.json()).data.status, "planned");
  const before = calls.length, receipt = await request("/action-requests?idempotencyKey=" + key); assert.equal(receipt.status, 200);
  const saved = (await receipt.json()).data; assert.equal(saved.idempotencyKey, key); assert.equal(saved.state, "completed"); assert.equal(saved.receipt.status, "planned"); assert.equal(saved.retryAllowed, false); assert.equal(calls.length, before);
  for (const suffix of ["/action-requests?idempotencyKey=x&idempotencyKey=y", "/action-requests?idempotencyKey=" + "x".repeat(161)]) { const invalid = await request(suffix); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "xiaomi_home_idempotency_required"); }
  assert.equal(calls.length, before);
  assert.ok(!catalog.some(row => row.contract.pathTemplate.startsWith("/api/services/")));
  const arbitrary = await fetch("http://127.0.0.1:" + address.port + "/api/services/notify/send_message", { method: "POST", headers: { authorization: "Bearer " + credential.token }, body: "{}" }); assert.equal(arbitrary.status, 404); assert.equal(calls.length, before);
});
