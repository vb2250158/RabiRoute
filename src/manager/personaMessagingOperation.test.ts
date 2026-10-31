import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createPersonaDirectoryOperation, createPersonaMessagingOperations, PERSONA_MESSAGE_LIMITS } from "./personaMessagingRoutes.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { appendRolePanelTimelineMessageIfAbsent, readRolePanelTimeline } from "../rolePanelTimeline.js";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-message-operation-"));
  const originalRoot = path.join(root, "original"), nextRoot = path.join(root, "next");
  const state = { rolesRoot: originalRoot, accepted: 0, failDelivery: false, failAudit: false, proofCalls: 0, rejectRenewedProof: false, disableTargetBeforeDispatch: false };
  const runtimes = new RuntimeRegistry();
  runtimes.set({ id: "alpha-route", name: "Alpha", enabled: true, gatewayPort: 0, agentRoleId: "Alpha", agentAdapters: ["codex"] });
  runtimes.set({ id: "beta-route", name: "Beta", enabled: true, gatewayPort: 0, agentRoleId: "Beta", agentAdapters: ["codex"] });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "persona-node");
  let gate: Promise<void> | undefined, release: (() => void) | undefined, entered: (() => void) | undefined;
  const registry = new ManagerPluginRouteRegistry();
  let ownerEntered: (() => void) | undefined;
  const owner = () => { const ownedRoot = state.rolesRoot; ownerEntered?.();
    return { rootDir: root, rolesRoot: ownedRoot, runtimes: () => runtimes.values(),
      personaPresentations: (): RouteCatalogPersonaPresentation[] => ["Alpha", "Beta"].map(roleId => ({ rolesRoot: ownedRoot, roleId, isPersona: true, displayName: roleId, avatarConfigured: false, files: [], speech: { voiceReady: false } })),
      authorizeSource: (route: string, persona: string, proof: string) => { state.proofCalls++; if (state.disableTargetBeforeDispatch && state.proofCalls > 1) runtimes.get("beta-route")!.definition.enabled = false; return route === "alpha-route" && persona === "Alpha" && proof === "fixture-source-proof" && !(state.rejectRenewedProof && state.proofCalls > 1); },
      deliver: async () => { state.accepted++; entered?.(); if (gate) await gate; if (state.failDelivery) throw new Error("Controlled original delivery acknowledgement failure"); },
      appendTimeline: async (roleId: string, message: import("../rolePanelTimeline.js").RolePanelTimelineMessage) => { if (state.failAudit) throw new Error("Controlled audit failure"); return appendRolePanelTimelineMessageIfAbsent(path.join(ownedRoot, roleId), message); }
    };
  };
  const registration = registry.registerOperations("persona", [createPersonaDirectoryOperation(owner), ...createPersonaMessagingOperations(owner)]);
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { release?.(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const request = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { authorization: "Bearer " + credential.token, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(10000) });
  const send = (deliveryId: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => request("/api/personas/Beta/messages", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ deliveryId, sourceRouteId: "alpha-route", sourceCapability: "fixture-source-proof", text: "original message", ...extra }), signal });
  const hold = () => { const started = new Promise<void>(resolve => { entered = resolve; }); gate = new Promise<void>(resolve => { release = resolve; }); return { started, release: () => release!() }; };
  return { root, originalRoot, nextRoot, state, runtimes, registry, registration, authority, credential, request, send, hold, base, watchOwner: () => new Promise<void>(resolve => { ownerEntered = resolve; }) };
}

test("an enrolled empty node reads personas, sends with original source proof and reuses the persistent receipt", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const detail = await f.request("/api/personas/Beta?extension=ignored"); assert.equal(detail.status, 200); assert.equal((await detail.json()).persona.defaultRouteId, "beta-route");
  const first = await f.send("stable-persona-id", { text: 42, hopCount: "1", extension: true }); assert.equal(first.status, 202, await first.clone().text()); const result = await first.json();
  assert.equal(result.message.text, "42"); assert.equal(result.hopCount, 1); assert.equal(result.idempotency.duplicate, false);
  const duplicate = await f.send("stable-persona-id", { text: "42", hopCount: 1 }); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).idempotency.duplicate, true);
  assert.equal(f.state.accepted, 1); assert.equal((await f.send("stable-persona-id", { text: "changed" })).status, 409);
  const receipt = await f.request("/api/personas/messages/receipts/stable-persona-id?extension=ignored"); assert.equal(receipt.status, 200); const body = await receipt.json();
  assert.equal(body.receipt.state, "completed"); assert.equal(body.receipt.result.status, "delivered"); assert.ok(!JSON.stringify(body).includes("fixture-source-proof"));
});

test("native limits, distinct targets and source provenance reject before real delivery", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.send("bad-proof", { sourceCapability: "different-fixture-proof" })).status, 403);
  assert.equal((await f.send("long-text", { text: "x".repeat(PERSONA_MESSAGE_LIMITS.textChars + 1) })).status, 413);
  assert.equal((await f.send("long-reference", { conversationId: "x".repeat(PERSONA_MESSAGE_LIMITS.referenceChars + 1) })).status, 400);
  assert.equal((await f.send("hop-limit", { hopCount: PERSONA_MESSAGE_LIMITS.maxHops + 1 })).status, 409);
  assert.equal((await f.send("body-limit", { extension: "x".repeat(PERSONA_MESSAGE_LIMITS.requestBytes) })).status, 413);
  assert.equal((await f.request("/api/personas/Absent")).status, 404); assert.equal((await f.request("/api/personas/messages/receipts/absent-id")).status, 404);
  f.runtimes.get("alpha-route")!.definition.agentRoleDeviceId = "remote-owner";
  assert.equal((await f.send("remote-source")).status, 409); assert.equal(f.state.accepted, 0);
});

test("delivery and audit failures preserve durable recovery without resending", { timeout: 15000 }, async t => {
  const f = await fixture(t); f.state.failDelivery = true;
  const failed = await f.send("failed-original"); assert.equal(failed.status, 502, await failed.clone().text()); const failure = await failed.json();
  assert.equal(failure.uncertain, true); assert.ok(failure.messageId); assert.equal(failure.replyContext.gatewayId, "beta-route");
  assert.equal((await f.send("failed-original")).status, 502); assert.equal(f.state.accepted, 1);
  const receipt = await (await f.request("/api/personas/messages/receipts/failed-original")).json(); assert.equal(receipt.receipt.state, "completed"); assert.equal(receipt.receipt.result.status, "failed"); assert.equal(receipt.receipt.result.messageId, failure.messageId);
  f.state.failDelivery = false; f.state.failAudit = true;
  const accepted = await f.send("audit-original"); assert.equal(accepted.status, 202); assert.equal((await accepted.json()).timelineRecorded, false);
  assert.equal((await f.send("audit-original")).status, 202); assert.equal(f.state.accepted, 2);
});

test("accepted persona delivery retains the original target identity and audit root during configuration changes", { timeout: 15000 }, async t => {
  const f = await fixture(t), hold = f.hold(); const pending = f.send("original-target"); await hold.started;
  f.runtimes.get("beta-route")!.definition.id = "replacement-route"; f.state.rolesRoot = f.nextRoot; hold.release();
  const response = await pending; assert.equal(response.status, 202); const result = await response.json();
  assert.equal(result.targetRouteId, "beta-route"); assert.equal(result.message.gatewayId, "beta-route"); assert.equal(result.message.replyContext.targetRouteId, "beta-route");
  assert.equal(readRolePanelTimeline(path.join(f.originalRoot, "Beta")).length, 1); assert.equal(readRolePanelTimeline(path.join(f.nextRoot, "Beta")).length, 0);
});

test("HTTP disconnection joins accepted delivery, audit and the persistent completion before retirement", { timeout: 15000 }, async t => {
  const f = await fixture(t), hold = f.hold(), controller = new AbortController(); const pending = f.send("disconnected-original", {}, controller.signal).catch(() => undefined); await hold.started;
  controller.abort(); await pending; let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false); hold.release(); await retirement;
  assert.equal(f.state.accepted, 1); assert.equal(readRolePanelTimeline(path.join(f.originalRoot, "Beta")).length, 1);
  assert.equal(readDurableDeliveryReceipt(f.root, "persona-message-idempotency", "disconnected-original")?.state, "completed");
});

test("original-node revocation suppresses accepted results and source proof is checked before actual dispatch", { timeout: 15000 }, async t => {
  const f = await fixture(t), hold = f.hold(); const pending = f.send("revoked-original"); await hold.started;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); assert.ok(!(await response.text()).includes("original message")); assert.equal(f.state.accepted, 1);
  const other = await fixture(t); other.state.rejectRenewedProof = true;
  assert.equal((await other.send("expired-source-proof")).status, 403); assert.equal(other.state.accepted, 0);
});


test("a queued body retains its original persona storage owner before parsing", { timeout: 15000 }, async t => {
  const f = await fixture(t), acquired = f.watchOwner();
  const incoming = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(f.base + "/api/personas/Beta/messages", { method: "POST", headers: { authorization: "Bearer " + f.credential.token, "content-type": "application/json" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") })); response.on("error", reject);
    });
    t.after(() => request.destroy()); request.on("error", reject);
    request.write('{"deliveryId":"queued-owner",');
    void acquired.then(() => { f.state.rolesRoot = f.nextRoot; request.end('"sourceRouteId":"alpha-route","sourceCapability":"fixture-source-proof","text":"queued original message"}'); }).catch(reject);
  });
  const response = await incoming; assert.equal(response.status, 202, response.body);
  assert.equal(readRolePanelTimeline(path.join(f.originalRoot, "Beta")).length, 1); assert.equal(readRolePanelTimeline(path.join(f.nextRoot, "Beta")).length, 0); assert.equal(f.state.accepted, 1);
});


test("historical failed receipts remain readable and reusable without inventing missing recovery IDs", { timeout: 15000 }, async t => {
  const f = await fixture(t); const deliveryId = "historical-failure";
  const result = await executeDurableDelivery({ rootDir: f.root, namespace: "persona-message-idempotency", deliveryId,
    payload: { sourceRouteId: "alpha-route", targetPersonaId: "Beta", targetRouteId: "beta-route", conversationId: "persona:" + deliveryId, inReplyToMessageId: undefined, hopCount: 0, text: "original message" },
    deliver: async () => ({ status: "failed", statusCode: 502, message: "Historical delivery acknowledgement failure" }) });
  assert.equal(result.state, "completed");
  const response = await f.send(deliveryId); assert.equal(response.status, 502); const body = await response.json();
  assert.equal(body.idempotency.state, "completed"); assert.equal(body.idempotency.duplicate, true); assert.equal(body.messageId, undefined); assert.equal(f.state.accepted, 0);
});


test("a target disabled during durable admission is rejected before dispatch and the failed receipt remains stable", { timeout: 15000 }, async t => {
  const f = await fixture(t); f.state.disableTargetBeforeDispatch = true;
  const response = await f.send("disabled-after-admission"); assert.equal(response.status, 409); const body = await response.json();
  assert.equal(body.idempotency.state, "completed"); assert.equal(f.state.accepted, 0);
  const receipt = await (await f.request("/api/personas/messages/receipts/disabled-after-admission")).json(); assert.equal(receipt.receipt.result.statusCode, 409);
});
