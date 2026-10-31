import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { DesktopPetOwner, listDesktopPetPacks, type DesktopPetOwnerContext } from "./desktopPetRoutes.js";
import { createDesktopPetOperations } from "./desktopPetOperations.js";
import { DesktopSettingsStore } from "./desktopSettings.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext, options: Partial<DesktopPetOwnerContext> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pet-operation-fixture-")), roleDir = path.join(root, "roles", "sample"), cacheRoot = path.join(root, "cache");
  await fs.mkdir(roleDir, { recursive: true });
  const settings = new DesktopSettingsStore(path.join(root, "settings.json"));
  const events: Array<{ event: string; data: unknown }> = [];
  const owner = new DesktopPetOwner({ resolveRoleDir: () => roleDir, settings, cacheRoot, publishEvent: (event, data) => { events.push({ event, data }); }, ...options });
  const registry = new ManagerPluginRouteRegistry(), definitions = createDesktopPetOperations(owner), registration = registry.registerOperations("pet-fixture", definitions);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "pet-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { const retired = registration.dispose(); await Promise.all([retired, owner.stop()]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (tail: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; json(): any }>((resolve, reject) => {
    const request = http.request(base + "/api/desktop-pet/roles/sample" + tail, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode!, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString()) }); });
    }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Controlled pet fixture request timed out."))); request.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { root, roleDir, cacheRoot, settings, owner, registry, registration, definitions, authority, credential, send, events };
}

test("an enrolled empty node imports native bytes, reads binary assets and updates the original binding", async t => {
  const f = await fixture(t); assert.equal(f.definitions.length, 12); assert.equal(f.definitions.every(definition => definition.contract.exposure === "public"), true);
  const bytes = Buffer.from("GIF89a");
  const imported = await f.send("/packs/import?fileName=fixture.gif&packId=sample-pack&name=Fixture", "POST", bytes, { "content-type": "image/gif" });
  assert.equal(imported.status, 201); assert.equal(imported.json().data.pack.id, "sample-pack");
  const catalog = (await f.send("/packs?scope=runtime")).json(); assert.equal(catalog.data.packs[0].id, "sample-pack");
  const asset = await f.send("/packs/sample-pack/assets/idle.gif"); assert.equal(asset.status, 200); assert.equal(asset.headers["content-type"], "image/gif"); assert.deepEqual(asset.bytes, bytes); assert.equal(asset.headers["cache-control"], "private, max-age=3600");
  const binding = await f.send("", "PATCH", { personaId: "sample", enabled: true, packId: "sample-pack", scale: 0.75 }); assert.equal(binding.status, 200); assert.equal(binding.json().data.binding.scale, .75);
  const put = await f.send("", "PUT", { opacity: .6 }); assert.equal(put.status, 200); assert.equal(put.json().data.binding.scale, .75); assert.equal((await f.send("")).json().data.binding.opacity, .6);
  assert.equal(new DesktopSettingsStore(path.join(f.root, "settings.json")).read().pets.sample!.packId, "sample-pack");
  assert.equal((await f.send("/packs/import?fileName=fixture.gif&packId=sample-pack", "POST", bytes, { "content-type": "image/gif" })).status, 400);
  assert.ok(f.events.some(value => value.event === "desktop_pet_catalog_changed"));
});

test("dialogue and TTS transcript operations retain persona ownership and durable identity", async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.roleDir, "desktop-pet"), { recursive: true });
  await fs.writeFile(path.join(f.roleDir, "desktop-pet", "dialogue.json"), JSON.stringify({ schemaVersion: 1, personaId: "sample", openers: { hello: " Hello " }, fallbacks: {} }));
  assert.deepEqual((await f.send("/dialogue")).json().data.dialogue, { openers: { hello: "Hello" }, fallbacks: {} });
  const body = { personaId: "sample", voice: "sample", kind: "tts", id: "controlled-transcript", text: "Controlled fixture.", time: 12345 };
  assert.equal((await f.send("/transcripts", "POST", { ...body, voice: "other" })).status, 400);
  const created = await f.send("/transcripts", "POST", body); assert.equal(created.status, 200); assert.equal(created.json().data.appended, true);
  assert.equal((await f.send("/transcripts", "POST", body)).json().data.appended, false);
  assert.equal((await f.send("/transcripts", "POST", { ...body, text: "different" })).status, 400);
});

test("motion runtime keeps the original claim token and generation-scoped receipt for an authenticated remote node", async t => {
  const f = await fixture(t); f.settings.write({ pets: { sample: { enabled: true, packId: "fixture" } } });
  const requestId = "fixture-motion-1", body = { requestId, target: { kind: "position", x: 10, y: 20 } }, headers = { "idempotency-key": requestId };
  assert.equal((await f.send("/motion", "POST", body, headers)).status, 202);
  const claimed = (await f.send("/motion/runtime", "POST", {})).json().data; assert.equal(claimed.status, "running"); assert.equal(typeof claimed.token, "string");
  assert.equal((await f.send("/motion/" + requestId)).json().data.token, undefined);
  const completed = { requestId, token: claimed.token, status: "succeeded", position: { x: 10, y: 20 }, destination: { x: 10, y: 20 } };
  assert.equal((await f.send("/motion/runtime", "POST", { ...completed, token: "wrong" })).status, 409);
  assert.equal((await f.send("/motion/runtime", "POST", completed)).status, 200);
  assert.equal((await f.send("/motion/" + requestId)).json().data.status, "succeeded");
  assert.equal((await f.send("/motion", "POST", body, headers)).status, 200);
});

test("catalog response timeout does not release the original worker lease during retirement", async t => {
  let release: (() => void) | undefined;
  t.after(() => release?.());
  const f = await fixture(t, { catalogQuery: async (_role, _dir, _cache, _options, _timeout, onReleased) => { release = onReleased; throw new Error("Controlled worker timeout."); } });
  const reply = await f.send("/packs"); assert.equal(reply.status, 503); assert.equal(f.owner.activeWorkerCount(), 1);
  let stopped = false; const stopping = f.owner.stop().then(() => { stopped = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  assert.ok(release); release(); await stopping; assert.equal(f.owner.activeWorkerCount(), 0);
});

test("HTTP disconnect and registry retirement join the original catalog query through actual release", async t => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<ReturnType<typeof listDesktopPetPacks>>(resolve => { release = () => resolve({ personaId: "sample", packs: [], diagnostics: [] }); });
  t.after(() => release());
  const f = await fixture(t, { catalogQuery: async (_role, _dir, _cache, _options, _timeout, onReleased) => { entered(); try { return await gate; } finally { onReleased(); } } });
  const abort = new AbortController(), pending = f.send("/packs", "GET", undefined, {}, abort.signal).catch(() => null); await Promise.race([started, pending.then(() => { throw new Error("Pet fixture ended before owner entry."); })]); abort.abort(); await pending;
  let retired = false; const retiring = Promise.all([f.registration.dispose(), f.owner.stop()]).then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  release(); await retiring; assert.equal(f.owner.activeWorkerCount(), 0);
});


test("plugin drains accepted parsing/operations before joining worker leases created during retirement", async () => {
  const plugin = await import(new URL("../../plugins/builtin/io.rabiroute.manager.desktop-pet/1.0.0/manager.mjs", import.meta.url).href);
  const { EffectScope } = await import("../plugin-kernel/effectScope.js");
  const scope = new EffectScope();
  let owner!: DesktopPetOwner, finishOperation!: () => void, releaseWorker!: () => void;
  const operationGate = new Promise<void>(resolve => { finishOperation = resolve; });
  class ControlledOwner extends DesktopPetOwner {
    constructor(context: DesktopPetOwnerContext) {
      super({ ...context, catalogQuery: async (_r, _d, _c, _o, _t, onReleased) => { releaseWorker = onReleased; throw new Error("Controlled timeout."); } }); owner = this;
    }
  }
  const runtime = { DesktopPetOwner: ControlledOwner, createDesktopPetOperations, resolveRoleDir: () => "", managerPluginRoutes: { registerOperationsAsync: async () => ({ dispose: () => operationGate }) } };
  await plugin.activate({ identity: { instanceId: "pet-fixture" }, services: { require: () => runtime, provide: () => {} }, lifecycle: { signal: scope.signal() }, effects: { add: scope.add.bind(scope), adopt: scope.adopt.bind(scope) } });
  await scope.commit(); let retired = false; const retirement = scope.dispose().then(() => { retired = true; });
  await assert.rejects(owner.queryCatalog("sample", "", "", {}, 1), /Controlled timeout/); assert.equal(owner.activeWorkerCount(), 1);
  finishOperation(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  releaseWorker(); await retirement; assert.equal(retired, true); assert.equal(owner.activeWorkerCount(), 0);
});

test("missing native settings rejects binding and renderer writes before malformed JSON consumption", async t => {
  const f = await fixture(t, { settings: undefined });
  const binding = await f.send("", "PATCH", "not-json"); assert.equal(binding.status, 503);
  const motion = await f.send("/motion/runtime", "POST", "not-json"); assert.equal(motion.status, 503); assert.equal(motion.headers["cache-control"], "no-store");
});
