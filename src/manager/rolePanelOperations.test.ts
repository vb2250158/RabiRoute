import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { appendRolePanelTimelineMessageIfAbsent, readRolePanelTimeline, rolePanelMessagesPath } from "../rolePanelTimeline.js";
import { RuntimeRegistry, type GatewayRuntime } from "./runtimeRegistry.js";
import { createRolePanelOperations } from "./rolePanelOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "role-panel-operation-"));
  const originalRoot = path.join(root, "original"), nextRoot = path.join(root, "next");
  const state = { activeRoot: originalRoot, accepted: 0, failDelivery: false, failAudit: false, failAppender: false, denyObject: false };
  const runtime: GatewayRuntime = { definition: { id: "gateway-a", name: "Gateway A", enabled: true, gatewayPort: 0, agentRoleId: "Builder", agentAdapters: ["codex"] },
    process: null, needsRestart: false, startedAt: null, stoppedAt: null, lastExit: null, readiness: "stopped", endpoints: [], lastError: null, log: [] };
  const runtimes = new RuntimeRegistry(); runtimes.set("gateway-a", runtime);
  let gate: Promise<void> | undefined, release: (() => void) | undefined, entered: (() => void) | undefined;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("persona", createRolePanelOperations({ runtimes: () => runtimes, roleId: () => "Builder", assertLocalOwner: () => { if (state.denyObject) throw new Error("The requested persona belongs to its remote owner."); },
    deliver: async () => { state.accepted++; entered?.(); if (gate) await gate; if (state.failDelivery) throw new Error("Controlled delivery acknowledgement failure"); },
    timelineAppender: () => { if (state.failAppender) throw new Error("Timeline owner not ready"); const ownedRoot = state.activeRoot;
      return async (roleId, message) => { if (state.failAudit) throw new Error("Timeline unavailable after acceptance"); return appendRolePanelTimelineMessageIfAbsent(path.join(ownedRoot, roleId), message); }; },
    readMessages: async (roleId, limit) => readRolePanelTimeline(path.join(state.activeRoot, roleId), limit)
  }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "panel-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { release?.(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const request = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { authorization: "Bearer " + credential.token, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(5000) });
  const send = (body: unknown, signal?: AbortSignal) => request("/api/role-panel/messages", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body), signal });
  const hold = () => { const started = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { release = resolve; }); return { started, release: () => release!() }; };
  return { root, originalRoot, nextRoot, state, runtime, registry, registration, authority, credential, request, send, hold };
}

test("node-authenticated role-panel contracts retain native coercion, timeline persistence and first query values", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const response = await f.send({ text: 42, attachments: [null, { kind: "future-kind", name: " file ", size: "12" }], extension: true });
  assert.equal(response.status, 202); const result = await response.json(); assert.equal(result.status, "delivered"); assert.equal(result.timelineRecorded, true);
  assert.equal(result.message.text, "42"); assert.equal(result.message.attachments[0].kind, "file"); assert.equal(result.message.attachments[0].size, 12);
  assert.equal(f.state.accepted, 1);
  const file = rolePanelMessagesPath(path.join(f.originalRoot, "Builder"));
  fs.appendFileSync(file, JSON.stringify({ id: "legacy", time: "Infinity", roleId: "Builder", text: "legacy" }) + "\n");
  const listed = await (await f.request("/api/roles/Builder/role-panel/messages?limit=1&limit=100&unknown=yes")).json();
  assert.equal(listed.messages.length, 1); assert.equal(listed.messages[0].id, "legacy"); assert.equal(listed.messages[0].time, null);
  assert.ok(f.registry.catalogSnapshot().operations.some(x => x.contract.aliases?.includes("persona:GET:/api/roles/:roleId/role-panel/messages")));
});

test("timeline failure and missing audit owner never resend an accepted role-panel delivery", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.state.failAudit = true;
  const first = await f.send({ text: "accepted once" }); assert.equal(first.status, 202); assert.equal((await first.json()).timelineRecorded, false); assert.equal(f.state.accepted, 1);
  f.state.failAppender = true;
  const second = await f.send({ text: "separate accepted request" }); assert.equal(second.status, 202); assert.equal((await second.json()).timelineRecorded, false); assert.equal(f.state.accepted, 2);
});

test("delivery failure keeps the original receipt identity and reports uncertainty without replay", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.failDelivery = true;
  const response = await f.send({ text: "original request" }); assert.equal(response.status, 502); const result = await response.json();
  assert.equal(result.uncertain, true); assert.equal(result.commitState, "uncertain"); assert.ok(result.messageId.startsWith("role-panel-user-"));
  assert.equal(result.replyContext.gatewayId, "gateway-a"); assert.equal(f.state.accepted, 1);
  const rows = readRolePanelTimeline(path.join(f.originalRoot, "Builder")); assert.equal(rows[0].id, result.messageId); assert.equal(rows[0].status, "failed");
});

test("invalid target, empty payload and original object ownership fail before dispatch", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const body of [{ gatewayId: "absent", text: "text" }, { text: false, attachments: [null, {}] }]) {
    const response = await f.send(body); assert.equal(response.status, 400); assert.equal((await response.json()).commitState, "not_started");
  }
  f.state.denyObject = true; assert.equal((await f.send({ text: "text" })).status, 400); assert.equal(f.state.accepted, 0);
});

test("accepted delivery records its original route and timeline owner across configuration changes", { timeout: 10000 }, async t => {
  const f = await fixture(t), hold = f.hold();
  const pending = f.send({ gatewayId: "gateway-a", text: "original target" }); await hold.started;
  f.runtime.definition.id = "changed-gateway"; f.state.activeRoot = f.nextRoot; hold.release();
  const response = await pending; assert.equal(response.status, 202); const result = await response.json();
  assert.equal(result.replyContext.gatewayId, "gateway-a"); assert.equal(result.message.gatewayId, "gateway-a"); assert.equal(result.message.routeProfileId, "gateway-a");
  assert.equal(readRolePanelTimeline(path.join(f.originalRoot, "Builder")).length, 1); assert.equal(readRolePanelTimeline(path.join(f.nextRoot, "Builder")).length, 0);
});

test("HTTP disconnect retains accepted delivery and audit ownership until completion", { timeout: 10000 }, async t => {
  const f = await fixture(t), hold = f.hold(), controller = new AbortController();
  const pending = f.send({ text: "accepted before disconnect" }, controller.signal).catch(() => undefined); await hold.started; controller.abort(); await pending;
  let disposed = false; const retiring = f.registration.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  hold.release(); await retiring; assert.equal(f.state.accepted, 1); assert.equal(readRolePanelTimeline(path.join(f.originalRoot, "Builder"))[0].status, "sent");
});

test("original caller revocation suppresses a completed role-panel result without replaying the accepted request", { timeout: 10000 }, async t => {
  const f = await fixture(t), hold = f.hold();
  const pending = f.send({ text: "undisclosed original payload" }); await hold.started;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); assert.ok(!(await response.text()).includes("undisclosed original payload"));
  assert.equal(f.state.accepted, 1);
});
