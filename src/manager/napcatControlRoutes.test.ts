import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createNapcatControlOperations, type NapcatControlRoutesContext } from "./napcatControlRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { NapcatLifecycleError, NapcatState } from "../shared/napcatStateContract.js";
import { compileApiContract } from "./apiOperationContract.js";

async function fixture(t: test.TestContext, overrides: Partial<NapcatControlRoutesContext> = {}) {
  const calls: Array<{ key: string; body: unknown }> = [];
  const native = (key: string) => async (body?: unknown) => { calls.push({ key, body }); return { ok: true, action: key }; };
  const context: NapcatControlRoutesContext = { repairAll: native("repairAll"), ensureReady: native("ensureReady"), health: native("health"), loginPanel: native("loginPanel"), loginAction: native("loginAction"), configureOneBot: native("configureOneBot"), add: native("add"), launch: native("launch"), restart: native("restart"), remove: native("remove"), ...overrides };
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createNapcatControlOperations(context);
  const registration = registry.registerOperations("napcat-fixture", definitions);
  const server = http.createServer((request, response) => {
    // Controlled ingress fixture: no account, native process, QQ endpoint or credentials.
    if (request.headers.authorization !== "Bearer fixture") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (suffix: string, body: unknown = {}, method = "POST", authenticated = true) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const request = http.request(base + "/api/message/napcat-" + suffix + "?ignored=yes", { method, headers: { "content-type": "text/plain", ...(authenticated ? { authorization: "Bearer fixture" } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, headers: response.headers, body: raw ? JSON.parse(raw) : null }); });
    });
    request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned NapCat fixture timed out.")));
    request.end(method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { registry, registration, definitions, calls, context, send };
}

test("all ten executable NapCat routes install from the same discoverable contracts", async t => {
  const f = await fixture(t);
  const suffixes = ["repair-all", "ensure-ready", "health", "login-panel", "login-action", "configure-onebot", "add", "launch", "restart", "remove"];
  assert.equal(f.definitions.length, 10);
  for (const [i, suffix] of suffixes.entries()) {
    const operation = f.definitions[i];
    assert.equal(operation.contract.operationId, `manager.napcat.${suffix}`);
    assert.equal(compileApiContract(operation).contract.pathTemplate, "/api/message/napcat-" + suffix);
    const reply = await f.send(suffix, { gatewayId: "fixture", instanceId: "fixture", action: "refresh-qr", ignored: "preserved" });
    assert.equal(reply.status, 200); assert.equal(f.calls.length, i + 1);
    if (suffix.startsWith("login-")) assert.equal(reply.headers["cache-control"], "no-store");
    else assert.equal(reply.headers["cache-control"], undefined);
  }
  assert.equal(f.calls[0].body, undefined);
  assert.equal(f.calls[4].key, "loginAction");
  assert.equal((f.calls[4].body as any).ignored, "preserved");
  assert.equal((await f.send("health", {}, "GET")).status, 405);
  assert.equal((await f.send("health", {}, "POST", false)).status, 401);
});

test("repair-all ignores arbitrary malformed bytes while JSON actions decode only once", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("repair-all", "not-json\u0000")).status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, undefined);
  assert.equal((await f.send("launch", "not-json")).status, 400); assert.equal(f.calls.length, 1);
  assert.equal((await f.send("health", "")).status, 200); assert.deepEqual(f.calls[1].body, {});
  assert.equal((await f.send("health", "null")).status, 200); assert.equal(f.calls[2].body, null);
});

test("native ok truthiness preserves all three existing status policies", async t => {
  const result = { ok: false, diagnostics: ["native"] };
  const value = async () => result;
  const f = await fixture(t, { repairAll: value, ensureReady: value, health: value, loginPanel: value, loginAction: value, configureOneBot: value, add: value, launch: value, restart: value, remove: value });
  for (const suffix of ["repair-all", "ensure-ready", "health", "login-panel"]) { const reply = await f.send(suffix); assert.equal(reply.status, 200); assert.deepEqual(reply.body, result); }
  for (const suffix of ["login-action", "configure-onebot", "add", "launch", "restart", "remove"]) assert.equal((await f.send(suffix)).status, 400);
  f.context.launch = async () => ({}); f.context.loginAction = async () => ({ ok: null }); f.context.add = async () => ({ ok: "yes" });
  assert.equal((await f.send("launch")).status, 200); assert.equal((await f.send("login-action")).status, 200); assert.equal((await f.send("add")).status, 200);
  f.context.add = async () => ({}); assert.equal((await f.send("add")).status, 400);
});

test("native lifecycle failures retain their exact state and login no-store headers", async t => {
  const f = await fixture(t, { loginAction: async () => { throw new NapcatLifecycleError(NapcatState.AccountMismatch, "Controlled account mismatch."); } });
  const reply = await f.send("login-action");
  assert.equal(reply.status, 400); assert.equal(reply.headers["cache-control"], "no-store"); assert.deepEqual(reply.body, { ok: false, message: "Controlled account mismatch.", state: NapcatState.AccountMismatch });
});

test("retirement removes admission and joins an accepted native action through completion", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { launch: async () => { entered(); await gate; return { ok: true }; } });
  const pending = f.send("launch"); await started;
  let retired = false; const retiring = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  assert.equal((await f.send("launch")).status, 404);
  release(); await pending; await retiring; assert.equal(retired, true);
});



test("native mutation admission still rejects a removed binding before any external action", async t => {
  const { runNapcatLoginAction } = await import("../messageEndpoints/napcatManager.js");
  let probes = 0;
  const definition = { id: "fixture-route", gatewayPort: 12345, napcatInstances: [] };
  const nativeContext = { rootDir: process.cwd(), getRuntimes: () => [{ definition }], normalizeNapCatInstances: () => definition.napcatInstances, appendLog: () => undefined, checkHttpEndpoint: async () => { probes++; throw new Error("No external probe allowed."); } };
  const f = await fixture(t, { loginAction: body => runNapcatLoginAction(nativeContext, body) });
  const reply = await f.send("login-action", { gatewayId: "fixture-route", instanceId: "missing-fixture", action: "refresh-qr" });
  assert.equal(reply.status, 400); assert.equal(reply.body.ok, false); assert.equal(probes, 0);
});

test("plugin retirement stops admission and supervisor before joining native actions, preserving process handover", async () => {
  for (const supervisorFails of [false, true]) {
  const pluginPath = new URL("../../plugins/builtin/io.rabiroute.manager.napcat-control/1.0.0/manager.mjs", import.meta.url).href;
  const plugin = await import(pluginPath);
  let start!: () => Promise<() => Promise<void>>, operations!: ReturnType<typeof createNapcatControlOperations>, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const runtime = {
    createNapcatControlOperations,
    activeNapcatControlContext: undefined as unknown,
    napcatManagerCtx: (assertCurrent: () => void) => ({ assertCurrent }),
    managerPluginRoutes: { registerOperationsAsync: async (_id: string, values: typeof operations) => { operations = values; return { dispose: async () => { events.push("unregister"); } }; } },
    managerListenerReady: true,
    startActiveNapcatSupervisor: () => { events.push("start-supervisor"); },
    stopActiveNapcatSupervisor: async () => { events.push("stop-supervisor"); if (supervisorFails) throw new Error("Controlled supervisor failure."); },
    launchNapcatInstanceEndpoint: async () => { entered(); await gate; events.push("native-complete"); return { ok: true }; }
  };
  let publication!: { publish(): void; rollback(): void };
  await plugin.activate({ identity: { instanceId: "napcat-fixture" }, lifecycle: { signal: new AbortController().signal }, services: { require: () => runtime, provide: () => {} },
    publication: { add: (hook: typeof publication) => { publication = hook; } }, effects: { add: (starter: typeof start) => { start = starter; } } });
  const retire = await start();
  publication.publish();
  runtime.startActiveNapcatSupervisor();
  const launch = operations.find(value => value.contract.operationId === "manager.napcat.launch")!;
  const input = { body: {}, path: {}, query: {}, headers: {}, request: {} } as any;
  const pending = launch.handler(input); await started;
  let finished = false; const retirement = retire().then(() => { finished = true; return null; }, error => { finished = true; return error; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.deepEqual(events, ["start-supervisor", "unregister", "stop-supervisor"]);
  assert.throws(() => launch.prepare!(input), /stopping/);
  release(); await pending; const retirementError = await retirement;
  if (supervisorFails) assert.match(retirementError.message, /Controlled supervisor failure/); else assert.equal(retirementError, null);
  assert.equal(runtime.activeNapcatControlContext, undefined); assert.deepEqual(events, ["start-supervisor", "unregister", "stop-supervisor", "native-complete"]);
  }
});
