import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createYeYuGamerManagerOperations } from "./managerRoutes.js";
import { YeYuGamerManagerApiClient, YEYU_GAMER_MANAGER_BASE_URL, type YeYuGamerManagerConfigInput } from "./managerApi.js";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "../../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "../../manager/lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "../../manager/lanAgentBodyAuthority.js";

const health = { status: "ok", manager: "ok", storage: "ok", eventStream: "ok", checkedAt: "fixture", checks: {} };
const meta = { name: "fixture", version: "1", apiVersion: "v1", managerId: "fixture-manager", startedAt: "fixture", hostPolicy: "loopback-only", webGuiAvailable: false, legacyExecutionEnabled: false };
const snapshot = { stateVersion: 7, generatedAt: "fixture", eventCursor: "fixture-cursor", manager: {}, health: {}, gameDay: "fixture", recentBatches: [{ extension: true }], games: [{ extension: true }], counters: {}, extension: true };
const capabilities = { total: 0, items: [] };
const receipt = { commandId: "fixture-plan", idempotencyKey: "original-key", acceptedStateVersion: 8, state: "accepted", message: "recorded", result: {}, submittedAt: "fixture", replayed: false, extension: true };
const dispatch = { workItem: { kind: "observation", note: "fixture" }, idempotencyKey: "original-key", expectedStateVersion: 7 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function requestOwned(url: string, options: { method?: string; body?: string; headers?: http.OutgoingHttpHeaders; signal?: AbortSignal } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method, headers: options.headers, signal: options.signal }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers: { "content-type": "application/json" } })));
    });
    request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned YeYu HTTP fixture timed out."))); request.end(options.body);
  });
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yeyu-contract-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const actorDir = path.join(root, "secrets", "actors"); await fs.mkdir(actorDir, { recursive: true }); await fs.writeFile(path.join(actorDir, "rabiroute.token"), "T".repeat(48), "ascii");
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "yeyu-node");
  const seen: { path: string; method: string; body: unknown; actor?: string; key?: string; version?: string }[] = [];
  let respond = (pathname: string): { status: number; body: unknown } => ({ status: pathname === "/agent/work-items" ? 202 : 200, body: ({ "/health": health, "/meta": meta, "/snapshot": snapshot, "/capabilities": capabilities, "/agent/work-items": receipt } as Record<string, unknown>)[pathname] });
  let held: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; closed: ReturnType<typeof deferred> } | undefined;
  const upstream = http.createServer(async (request, response) => {
    response.on("error", () => {});
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen.push({ path: request.url!, method: request.method!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      actor: request.headers["x-yeyu-gamer-actor"] as string | undefined, key: request.headers["idempotency-key"] as string | undefined, version: request.headers["x-expected-state-version"] as string | undefined });
    const gate = held;
    if (gate) { response.once("close", gate.closed.resolve); gate.entered.resolve(); await gate.release.promise; }
    if (response.destroyed) return;
    const result = respond(request.url!); response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
  });
  t.after(() => { held?.release.resolve(); upstream.closeAllConnections(); return new Promise<void>(resolve => upstream.close(() => resolve())); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamBase = "http://127.0.0.1:" + (upstream.address() as import("node:net").AddressInfo).port;
  let config: YeYuGamerManagerConfigInput = { runtimeDir: root }, credentialReads = 0, configReads = 0;
  let configRead: (() => void) | undefined;
  const owner = createYeYuGamerManagerOperations({ getConfig: () => { configReads++; configRead?.(); return config; }, createClient: original => new YeYuGamerManagerApiClient(original, {
    readFile: async (file, encoding) => { credentialReads++; assert.equal(file, path.join(actorDir, "rabiroute.token")); return fs.readFile(file, encoding); },
    fetch: async (input, init) => { assert.ok(String(input).startsWith(YEYU_GAMER_MANAGER_BASE_URL + "/")); return requestOwned(upstreamBase + String(input).slice(YEYU_GAMER_MANAGER_BASE_URL.length), { method: init?.method, body: init?.body as string | undefined, headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined }); }
  }) });
  const registry = new ManagerPluginRouteRegistry(); const registration = registry.registerOperations("yeyu-contract", owner.operations);
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  t.after(async () => { held?.release.resolve(); const retired = registration.dispose(); await owner.stop(); await retired; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const headers = { authorization: "Bearer " + credential.token };
  return { base, headers, owner, registration, seen, request: (resource: string, body?: unknown, signal?: AbortSignal) => requestOwned(base + "/api/agent/yeyu-gamer/" + resource, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal }),
    counts: () => ({ configReads, credentialReads }), setConfig: (value: YeYuGamerManagerConfigInput) => { config = value; }, onConfig: (callback: () => void) => { configRead = callback; },
    respond: (handler: typeof respond) => { respond = handler; }, hold: () => { held = { entered: deferred(), release: deferred(), closed: deferred() }; return held; } };
}

test("five executable YeYu operations use the original native client and plan-only receipt", async t => {
  const f = await fixture(t);
  for (const [resource, expected] of [["health", health], ["meta", meta], ["snapshot", snapshot], ["capabilities", capabilities]] as const) {
    const response = await f.request(resource + "?ignored=yes"); assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, expected);
  }
  assert.equal(f.counts().credentialReads, 2);
  const posted = await f.request("work-items", { ...dispatch, workItem: { ...dispatch.workItem, mode: "execute", requestedBy: "ignored" } });
  assert.equal(posted.status, 202); assert.deepEqual((await posted.json()).data, receipt);
  assert.deepEqual(f.seen.at(-1), { path: "/agent/work-items", method: "POST", body: { kind: "observation", mode: "plan", requestedBy: "rabiroute", note: "fixture", artifactRefs: [], allowedCapabilityRefs: [] }, actor: "rabiroute", key: "original-key", version: "7" });
  assert.equal(f.counts().credentialReads, 3);
  for (const requestId of ["", null, false, 0]) assert.equal((await f.request("work-items", { ...dispatch, requestId })).status, 202);
  for (const resource of ["claims", "decisions", "capability-invocations", "path", "shell"]) assert.equal((await f.request(resource, {})).status, 404);
});

test("YeYu request schema rejects invalid plans before reading credentials or dispatching", async t => {
  const f = await fixture(t);
  for (const body of [{}, { ...dispatch, expectedStateVersion: -1 }, { ...dispatch, idempotencyKey: "white space" }, { ...dispatch, workItem: { kind: "run_game" } }, { ...dispatch, workItem: { kind: "cancel_run" } }, { ...dispatch, workItem: { kind: "observation", note: "x".repeat(501) } }, { ...dispatch, workItem: { kind: "run_game", gameId: "../path" } }, { ...dispatch, workItem: { kind: "observation", artifactRefs: ["../path"] } }]) assert.equal((await f.request("work-items", body)).status, 400);
  assert.equal(f.counts().credentialReads, 0); assert.equal(f.seen.length, 0);
});

test("YeYu captures its original configuration before body consumption", async t => {
  const f = await fixture(t), configured = deferred(); f.onConfig(configured.resolve);
  let upload!: http.ClientRequest;
  const pending = new Promise<number>((resolve, reject) => { upload = http.request(f.base + "/api/agent/yeyu-gamer/work-items", { method: "POST", headers: f.headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }); upload.on("error", reject); upload.write('{"workItem":'); });
  await configured.promise; f.setConfig({ baseUrl: "http://unaccepted.invalid" });
  upload.end(JSON.stringify(dispatch.workItem) + ',"idempotencyKey":"original-key","expectedStateVersion":7}');
  assert.equal(await pending, 202); assert.equal(f.seen.length, 1);
  assert.equal((await f.request("health")).status, 400); assert.equal(f.seen.length, 1);
});

test("native YeYu errors remain bounded and malformed response schemas are rejected", async t => {
  const f = await fixture(t);
  f.respond(() => ({ status: 412, body: { error: { code: "state_version_conflict", message: "credential-or-private-path" } } }));
  const conflict = await f.request("work-items", dispatch); assert.equal(conflict.status, 412);
  const result = await conflict.json(); assert.equal(result.error.code, "state_version_conflict"); assert.doesNotMatch(JSON.stringify(result), /credential-or-private-path/);
  f.respond(() => ({ status: 200, body: { status: "invented-state" } }));
  const invalid = await f.request("health"); assert.equal(invalid.status, 502); assert.equal((await invalid.json()).error.code, "yeyu_gamer_contract_mismatch");
});

test("YeYu retirement cancels and joins an already dispatched original plan request", { timeout: 10000 }, async t => {
  const f = await fixture(t), gate = f.hold();
  const pending = f.request("work-items", dispatch); await gate.entered.promise;
  const retired = f.registration.dispose(); await f.owner.stop(); await retired;
  assert.equal((await pending).status, 503); await gate.closed.promise; gate.release.resolve(); assert.equal(f.seen.length, 1);
});

test("YeYu HTTP disconnect cancels the original native transport without replay", { timeout: 10000 }, async t => {
  const f = await fixture(t), gate = f.hold(), controller = new AbortController();
  const pending = f.request("work-items", dispatch, controller.signal).catch(() => undefined); await gate.entered.promise;
  controller.abort(); await pending; await gate.closed.promise; gate.release.resolve(); assert.equal(f.seen.length, 1);
});
