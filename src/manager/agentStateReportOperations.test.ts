import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentStateReportOwner, createAgentStateReportOperations, type AgentStateReportOwnerOptions } from "./agentStateReportOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

const previousId = "019f0000-0000-7000-8000-000000000109", nextId = "019f0000-0000-7000-8000-000000000110";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-state-operation-"));
  const runtime = { agentStateGeneration: "process-one", definition: { codexThreadId: previousId, codexCwd: "C:/work/example" } };
  const states: AgentStateReportOwnerOptions<typeof runtime.definition>["states"] = new Map();
  const events: unknown[] = [];
  let failWrite = false, entered!: () => void, release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const report = createAgentStateReportOwner({ runtime: id => id === "example" ? runtime : undefined, states,
    writeAdapterConfigFile: async definition => { entered(); if (gate) await gate; if (failWrite) throw new Error("Owned config persistence failed."); await writeFile(path.join(root, "adapter.json"), JSON.stringify(definition)); },
    publishManagerEvent: (type, payload) => { events.push({ type, payload }); } });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("agent-state", createAgentStateReportOperations(report));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "state-node");
  const server = http.createServer((request, response) => {
    // An authenticated connection with no persona, Route or workspace grant uses the public operation.
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority("/api/agent-state", body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  t.after(async () => { release?.(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/agent-state`;
  const send = (body: unknown, signal?: AbortSignal) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(url + "?ignored=yes", { method: "POST", signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Owned state fixture timeout."))); request.end(JSON.stringify(body));
  });
  const body = (sequence: number | string, state: unknown = {}) => ({ gatewayId: " example ", adapterType: "codex", generation: " process-one ", sequence, state });
  const binding = { bindingUpdateRequestedAt: "2026-10-21T00:00:00Z", bindingPreviousThreadId: previousId, bindingThreadId: nextId, bindingWorkspace: "C:/work/example" };
  return { root, runtime, states, events, registration, send, body, binding, started,
    failWrite: () => { failWrite = true; }, disable: () => { authority.setNodeEnabled(credential.nodeId, false, true); }, hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => release!() };
}

test("public report updates native state, preserves open fields and overrides report metadata", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.send(f.body("1", { arbitraryState: ["ready"], reportSequence: 999, agentAdapterType: "forged" })), { status: 200, body: { code: 0 } });
  const state = f.states.get("example")!.codex!;
  assert.equal(state.reportSequence, 1); assert.equal(state.agentAdapterType, "codex"); assert.equal(state.reportGeneration, "process-one"); assert.deepEqual(state.arbitraryState, ["ready"]);
  assert.ok(Number.isFinite(Date.parse(String(state.updatedAt))));
  assert.deepEqual(await f.send(f.body(1, { arbitraryState: "stale" })), { status: 202, body: { code: 0, ignored: true } });
  assert.deepEqual(f.states.get("example")!.codex!.arbitraryState, ["ready"]);
  assert.equal((await f.send({ ...f.body(2), generation: "retired-process" })).status, 400);
  assert.equal((await f.send({ ...f.body(2), gatewayId: "missing" })).status, 400);
  assert.equal((await f.send(f.body(0))).status, 400);
});

test("native binding replacement persists exact original definition before publishing", async t => {
  const f = await fixture(t);
  assert.equal((await f.send(f.body(1, f.binding))).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "adapter.json"), "utf8")), { codexThreadId: nextId, codexCwd: "C:/work/example" });
  assert.equal(f.runtime.definition.codexThreadId, nextId); assert.equal(f.events.length, 1);
  assert.equal((await f.send(f.body(1, f.binding))).status, 202); assert.equal(f.events.length, 1);
});

test("stale binding identity cannot replace the native configured task", async t => {
  const f = await fixture(t);
  assert.equal((await f.send(f.body(1, { ...f.binding, bindingPreviousThreadId: nextId }))).status, 200);
  assert.equal(f.runtime.definition.codexThreadId, previousId); assert.equal(f.events.length, 0);
});

test("binding persistence failure reports uncertainty and duplicate sequence does not pretend to persist", async t => {
  const f = await fixture(t); f.failWrite();
  const response = await f.send(f.body(1, f.binding)); assert.equal(response.status, 400); assert.equal(response.body.uncertain, true);
  assert.equal(f.states.get("example")!.codex!.reportSequence, 1); assert.equal(f.events.length, 0);
  assert.equal((await f.send(f.body(1, f.binding))).status, 202); assert.equal(f.events.length, 0);
});

test("operation retirement waits for native config persistence after HTTP disconnect", async t => {
  const f = await fixture(t); f.hold(); const controller = new AbortController();
  const pending = f.send(f.body(1, f.binding), controller.signal).catch(() => undefined); await f.started;
  controller.abort(); await pending; let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  f.release(); await retirement; assert.equal(f.events.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "adapter.json"), "utf8")).codexThreadId, nextId);
});

test("revoking the original authenticated connection suppresses success while preserving accepted native write", async t => {
  const f = await fixture(t); f.hold(); const pending = f.send(f.body(1, f.binding)); await f.started; f.disable(); f.release();
  const response = await pending; assert.equal(response.status, 403); assert.equal(f.runtime.definition.codexThreadId, nextId); assert.equal(f.events.length, 1);
});
