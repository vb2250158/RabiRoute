import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { loadPersonaDocument } from "../src/persona/personaDocumentClient";
import { personaPeerRequestAllowed } from "../../src/shared/personaPeerService";
import {
  RemotePersonaReadError,
  RemotePersonaReferenceBrowser,
  bootstrapRemotePersonaService,
  personaReferenceIdentity,
  remotePersonaClient,
  remotePersonaServicePath,
  type RemotePersonaReference
} from "../src/persona/remotePersonaReference";

function reference(roleId: string, document: string): RemotePersonaReference {
  return { schemaVersion: 1, roleId, file: "persona.md", document, personaConfig: {}, revision: "a".repeat(64), applicationGenerationId: "generation", managerInstanceId: "manager" };
}
const meta = { applicationGenerationId: "generation", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
function localPreparation(path: string, init?: RequestInit): Response | undefined {
  if (path === "/meta") return Response.json(meta);
  if (path === "/api/rabilink/peer/persona/bootstrap") {
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["content-type"], "application/json");
    return Response.json({ code: 0, data: { deviceId: JSON.parse(String(init?.body)).deviceId } });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

test("remote persona discovery combines PC identities with tunnel trust without changing the speech selection", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = String(input); paths.push(path);
    return new Response(JSON.stringify(path.includes("peer/list")
      ? { peers: [{ id: "peer-a", name: "PC A", online: true, rabiPcVersion: "0.3.19" }, { id: "peer-b", name: "PC B", online: false }, { id: "peer-old", name: "Old PC", online: true }] }
      : { selectedDeviceId: "speech-pc", peers: [{ deviceId: "peer-a", trusted: false, supported: true, personaSupported: true, online: true }, { deviceId: "peer-old", trusted: true, supported: true, personaSupported: false, online: true }] }));
  });
  const devices = await remotePersonaClient.devices();
  assert.deepEqual(devices, [
    { deviceId: "peer-a", name: "PC A", online: true, supported: true, trusted: false, rabiPcVersion: "0.3.19" },
    { deviceId: "peer-b", name: "PC B", online: false, supported: false, trusted: false, rabiPcVersion: null },
    { deviceId: "peer-old", name: "Old PC", online: true, supported: false, trusted: true, rabiPcVersion: null }
  ]);
  assert.deepEqual(paths, ["/api/rabilink/peer/list?deviceKind=pc", "/api/rabilink/peer/servers"]);
});

test("catalog reads bootstrap the selected stable PC identity through RabiLink and share one timeout budget", async t => {
  const paths: string[] = [];
  const signals = new Set<AbortSignal | null | undefined>();
  let localMetaCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); paths.push(path); signals.add(init?.signal);
    if (path === "/meta") {
      ++localMetaCalls;
      return Response.json(localMetaCalls === 2 ? { ...meta, health: { live: false, requiredReady: false, state: "stopping" } } : meta);
    }
    const preparation = localPreparation(path, init);
    if (preparation) {
      assert.deepEqual(JSON.parse(String(init?.body)), { deviceId: "peer:a" });
      return preparation;
    }
    if (path.endsWith("/meta")) return Response.json(meta);
    return Response.json({ personas: [{ personaId: "same-role", name: "Remote role" }] });
  });
  const browser = new RemotePersonaReferenceBrowser();
  browser.devices = [{ deviceId: "peer:a", name: "PC A", online: true, supported: true, trusted: false }];
  await browser.selectSource("peer:a");
  assert.equal(browser.catalogState, "ready", "An online untrusted PC must get the automatic handshake attempt");
  assert.equal(browser.personas[0].personaId, "same-role");
  assert.deepEqual(paths, ["/meta", "/api/rabilink/peer/persona/bootstrap", "/meta", "/api/rabilink/peer/http/peer%3Aa/persona/meta", "/api/rabilink/peer/http/peer%3Aa/persona/api/personas", "/api/rabilink/peer/http/peer%3Aa/persona/meta"]);
  assert.equal(signals.size, 1, "Bootstrap, identity fences and the catalog share the 25-second signal");
  assert.ok([...signals][0] instanceof AbortSignal);
  assert.ok(paths.every(path => !path.includes("/manager/")), "Persona reads must not request full Manager access");
});

test("bootstrap distinguishes old PC capability, RabiLink authentication and unavailable PC without reading remote data", async t => {
  let reply = () => Response.json({ error: "REMOTE_PERSONA_UPGRADE_REQUIRED" }, { status: 426 });
  let remoteReads = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/meta") return Response.json(meta);
    if (path === "/api/rabilink/peer/persona/bootstrap") return reply();
    ++remoteReads;
    throw new Error("Remote data must not be requested after failed bootstrap");
  });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unsupported");
  reply = () => new Response("", { status: 403 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unauthorized" && /RabiLink 鉴权失败/.test(error.message));
  reply = () => Response.json({ error: "REMOTE_PERSONA_UNAVAILABLE" }, { status: 503 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "offline");
  reply = () => Response.json({ error: "MANAGER_IDENTITY_MISMATCH" }, { status: 409 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "failed");
  reply = () => new Response("<html>old Manager</html>", { status: 404 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unsupported");
  assert.equal(remoteReads, 0);
});

test("bootstrap rejects a changed local Manager identity or a different selected device", async t => {
  let localMetaCalls = 0;
  let returnedDeviceId = "peer-a";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input) === "/meta") return Response.json(++localMetaCalls === 2 ? { ...meta, managerInstanceId: "new-manager" } : meta);
    assert.equal(String(input), "/api/rabilink/peer/persona/bootstrap");
    return Response.json({ code: 0, data: { deviceId: returnedDeviceId } });
  });
  await assert.rejects(bootstrapRemotePersonaService("peer-a"), /本机 Manager 身份已变化/);
  returnedDeviceId = "another-device"; localMetaCalls = 0;
  await assert.rejects(bootstrapRemotePersonaService("peer-a"), /来源 PC 不一致/);
});

test("a tunnel-capable PC without persona-reference support reports upgrade before trying any handshake", async () => {
  let calls = 0;
  const browser = new RemotePersonaReferenceBrowser({ devices: async () => [], personas: async () => { ++calls; return []; }, reference: async () => reference("same-role", "") });
  browser.devices = [{ deviceId: "peer-old", name: "Old PC", online: true, supported: false, trusted: false }];
  await browser.selectSource("peer-old");
  assert.equal(browser.catalogState, "unsupported");
  assert.equal(browser.sourceDeviceId, "peer-old");
  assert.equal(calls, 0);
});

test("remote reads use the exact device and role keys and reject owner mismatch", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(String(input));
    const preparation = localPreparation(String(input), init);
    if (preparation) return preparation;
    if (String(input).endsWith("/meta")) return Response.json(meta);
    return new Response(JSON.stringify({ code: 0, data: reference("other-role", "wrong") }));
  });
  await assert.rejects(remotePersonaClient.reference("peer:a", "same-role", "persona.md"), /身份或配置响应无效/);
  assert.equal(paths[4], "/api/rabilink/peer/http/peer%3Aa/persona/api/roles/same-role/persona-reference?file=persona.md");
  assert.equal(remotePersonaServicePath("peer:a", "/api/personas"), "/api/rabilink/peer/http/peer%3Aa/persona/api/personas");
  assert.throws(() => remotePersonaServicePath("peer:a", "/api/rabilink/peer/servers"), /地址无效/);
});

test("permission failure and older HTML endpoints do not become an empty persona list", async t => {
  let targetResponse = () => new Response(JSON.stringify({ error: "persona service denied" }), { status: 403 });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => localPreparation(String(input), init)
    || (String(input).endsWith("/meta") ? Response.json(meta) : targetResponse()));
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unauthorized");
  targetResponse = () => new Response("", { status: 403 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unauthorized");
  targetResponse = () => Response.json({ error: "PERSONA_NOT_FOUND" }, { status: 404 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "failed");
  targetResponse = () => new Response("<html>old manager</html>", { status: 404 });
  await assert.rejects(remotePersonaClient.personas("peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unsupported");
  targetResponse = () => new Response("<html>old manager</html>", { status: 200 });
  await assert.rejects(remotePersonaClient.reference("peer-a", "same-role", "persona.md"), error => error instanceof RemotePersonaReadError && error.state === "unsupported");
});

test("the remote document reader uses the persona service snapshot and rejects WebGUI HTML fallback", async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(String(input));
    const preparation = localPreparation(String(input), init);
    if (preparation) return preparation;
    if (String(input).endsWith("/meta")) return Response.json(meta);
    const servicePath = String(input).slice("/api/rabilink/peer/http/peer-a/persona".length);
    assert.ok(personaPeerRequestAllowed({ method: "GET", path: servicePath }), "The production persona whitelist must permit the document request");
    return Response.json({ code: 0, data: reference("same-role", "# Remote persona") });
  });
  assert.equal(await loadPersonaDocument("same-role", "persona.md", "peer-a"), "# Remote persona");
  assert.deepEqual(paths, ["/meta", "/api/rabilink/peer/persona/bootstrap", "/meta", "/api/rabilink/peer/http/peer-a/persona/meta", "/api/rabilink/peer/http/peer-a/persona/api/roles/same-role/persona-reference?file=persona.md", "/api/rabilink/peer/http/peer-a/persona/meta"]);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => localPreparation(String(input), init)
    || (String(input).endsWith("/meta") ? Response.json(meta) : new Response("<html>WebGUI</html>", { headers: { "content-type": "text/html" } })));
  await assert.rejects(loadPersonaDocument("same-role", "persona.md", "peer-a"), error => error instanceof RemotePersonaReadError && error.state === "unsupported");
});

test("the remote document reader rejects a snapshot from another persona or Manager", async t => {
  let snapshot = reference("other-role", "unexpected");
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => localPreparation(String(input), init)
    || (String(input).endsWith("/meta") ? Response.json(meta) : Response.json({ code: 0, data: snapshot })));
  await assert.rejects(loadPersonaDocument("same-role", "persona.md", "peer-a"), /身份或配置响应无效/);
  snapshot = { ...reference("same-role", "unexpected"), managerInstanceId: "other-manager" };
  await assert.rejects(loadPersonaDocument("same-role", "persona.md", "peer-a"), /身份已变化/);
});

test("preview rejects remote generation changes but accepts an identity-stable health change after reading", async t => {
  let metaCalls = 0;
  let changeGeneration = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const preparation = localPreparation(String(input), init);
    if (preparation) return preparation;
    if (!String(input).endsWith("/meta")) return Response.json({ code: 0, data: reference("same-role", "document") });
    const after = ++metaCalls === 2;
    return Response.json(after ? { ...meta, applicationGenerationId: changeGeneration ? "other-generation" : "generation", health: { live: false, requiredReady: false, state: "stopping" } } : meta);
  });
  await assert.rejects(remotePersonaClient.reference("peer-a", "same-role", "persona.md"), /身份已变化/);
  metaCalls = 0; changeGeneration = false;
  assert.equal((await remotePersonaClient.reference("peer-a", "same-role", "persona.md")).document, "document");
});

test("preview validates payload identity, SHA-256 revision and the independent document byte limit", async t => {
  let snapshot = reference("same-role", "document");
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => localPreparation(String(input), init)
    || Response.json(String(input).endsWith("/meta") ? meta : { code: 0, data: snapshot }));
  snapshot = { ...snapshot, managerInstanceId: "other-manager" };
  await assert.rejects(remotePersonaClient.reference("peer-a", "same-role", "persona.md"), /身份已变化/);
  snapshot = { ...reference("same-role", "document"), revision: "invalid" };
  await assert.rejects(remotePersonaClient.reference("peer-a", "same-role", "persona.md"), /身份或配置响应无效/);
  snapshot = reference("same-role", "a".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(remotePersonaClient.reference("peer-a", "same-role", "persona.md"), /正文超过/);
});

test("switching PC discards delayed catalog and same-named persona responses", async () => {
  const catalogA = deferred<Array<{ personaId: string; name: string }>>();
  const documentA = deferred<RemotePersonaReference>();
  const browser = new RemotePersonaReferenceBrowser({
    devices: async () => [],
    personas: async deviceId => deviceId === "peer-a" ? catalogA.promise : [{ personaId: "same-role", name: "B role" }],
    reference: async deviceId => deviceId === "peer-a" ? documentA.promise : reference("same-role", "B document")
  });
  const pendingCatalog = browser.selectSource("peer-a");
  const pendingReference = browser.loadReference("peer-a", "same-role", "persona.md");
  await browser.selectSource("peer-b");
  await browser.loadReference("peer-b", "same-role", "persona.md");
  catalogA.resolve([{ personaId: "same-role", name: "A role" }]);
  documentA.resolve(reference("same-role", "A document"));
  await Promise.all([pendingCatalog, pendingReference]);
  assert.equal(browser.sourceDeviceId, "peer-b");
  assert.equal(browser.personas[0].name, "B role");
  assert.equal(browser.reference?.document, "B document");
  await browser.loadReference("peer-a", "same-role", "persona.md");
  assert.equal(browser.reference?.document, "B document");
});

test("a failed new read clears old remote document and preserves the remote source", async () => {
  let fail = false;
  const browser = new RemotePersonaReferenceBrowser({
    devices: async () => [], personas: async () => [],
    reference: async () => {
      if (fail) throw new RemotePersonaReadError("unauthorized", "RabiLink authentication denied");
      return reference("same-role", "first document");
    }
  });
  await browser.selectSource("peer-a");
  await browser.loadReference("peer-a", "same-role", "persona.md");
  fail = true;
  await browser.loadReference("peer-a", "same-role", "persona.md");
  assert.equal(browser.sourceDeviceId, "peer-a");
  assert.equal(browser.reference, null);
  assert.equal(browser.referenceState, "unauthorized");
  assert.match(browser.referenceError, /RabiLink authentication denied/);
});

test("an offline saved PC remains the owner and is not queried as a local persona", async () => {
  let calls = 0;
  const browser = new RemotePersonaReferenceBrowser({ devices: async () => [], personas: async () => { ++calls; return []; }, reference: async () => reference("same-role", "") });
  browser.devices = [{ deviceId: "peer-a", name: "PC A", online: false, supported: true, trusted: true }];
  await browser.selectSource("peer-a");
  assert.equal(browser.catalogState, "offline");
  assert.equal(browser.sourceDeviceId, "peer-a");
  assert.equal(calls, 0);
  assert.notEqual(personaReferenceIdentity({ agentRoleId: "same-role" }), personaReferenceIdentity({ agentRoleId: "same-role", agentRoleDeviceId: "peer-a" }));
});

test("remote persona views gate all local persona editors and preserve route-only saving", () => {
  const page = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  const document = fs.readFileSync(new URL("../src/pages/PersonaDocumentPage.vue", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/stores/gatewayStore.ts", import.meta.url), "utf8");
  assert.match(page, /label="人格来源 PC"/);
  assert.match(page, /<v-window v-if="!isRemotePersona"/);
  assert.match(page, /v-if="hasPersona && !isRemotePersona"[^\n]+openConfigFile/);
  assert.match(page, /removePersonaOwnedGatewayConfig/);
  assert.match(page, /buildPersonaSourceOptions\(store\.meta, remotePersona\.devices/);
  assert.doesNotMatch(page, /核对双端设备公钥|允许本机使用 manager 服务/);
  assert.match(page, /remoteConfigSummary[\s\S]*personaConfig/);
  assert.doesNotMatch(page, /Object\.assign\(gateway\.value,\s*remotePersona/);
  assert.match(store, /if \(!gateway\.agentRoleDeviceId\) ensureActiveRoleRules/);
  assert.match(document, /readPersonaDocument\(roleId, fileName, gateway\.value\?\.agentRoleDeviceId/);
});
