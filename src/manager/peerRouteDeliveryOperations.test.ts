import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { ApiOperationInput } from "./apiOperationContract.js";
import { createPeerRouteDeliveryOperations } from "./peerRouteDeliveryOperations.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";
import { EndpointDeliveryNotSentError } from "../agentRequests/deliveryFailure.js";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-route-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let executions = 0, reads = 0, archived = false, unknown = false, busyOnce = false, lateReceipt = false, recoveries = 0;
  const options: Parameters<typeof createPeerRouteDeliveryOperations>[0] = {
    managerInstanceId: "instance-b", localDeviceId: () => "pc-b", scope: () => "fixture-app",
    principal: () => ({ scope: "fixture-app", sourceDeviceId: "pc-a", deviceOwner: true }), receiptDirectory: directory,
    readLocal: async (_provider, id) => { reads++; return { id, title: id, cwd: directory, updatedAt: "", archived }; },
    localOptions: () => ({ allowedWorkspaces: [directory] }), executeOwner: async delivery => {
      executions++; assert.equal(delivery.target.sessionId, "full-session-b");
      assert.equal("source" in delivery, false); assert.equal("preparation" in delivery, false);
      assert.match(delivery.prompt, /original message/);
      assert.ok(delivery.prompt.includes("/api/rabilink/peer/http/pc-a/manager/api/roles/"));
      if (busyOnce) { busyOnce = false; throw new EndpointDeliveryNotSentError(new Error("fixture native owner busy: no prompt frame")); }
      if (unknown) throw new Error("fixture response lost after native boundary");
      return { threadId: delivery.target.sessionId, action: "started", transport: "test-native-route-owner" };
    }, recoverOwner: async delivery => {
      recoveries++;
      if (!lateReceipt) return undefined;
      assert.equal("prompt" in delivery, false, "receipt-only recovery uses the original persisted evidence without inventing a prompt");
      return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target,
        promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
        accepted: true, action: "receipt_recovered", transport: "test-native-route-owner" };
    }
  };
  const body = { instanceId: "instance-b", provider: "codex", threadId: "full-session-b", deliveryId: "original-route-id",
    prompt: renderRabiDelivery({ messageSource: { type: "message_adapter", messageAdapter: "fixture-channel", conversationType: "private",
      conversationId: "conversation", messageId: "original-message", senderId: "fixture-sender" }, messageContent: "original message", sentAt: "2026-11-02T00:00:00Z" }) };
  const invoke = async (reconcile = false, value: Record<string, unknown> = body) => {
    const operation = createPeerRouteDeliveryOperations(options)[reconcile ? 1 : 0]!;
    return operation.handler({ request: {}, body: value, path: {}, query: {}, url: new URL("http://fixture") } as ApiOperationInput);
  };
  return { invoke, body, directory, operations: () => createPeerRouteDeliveryOperations(options), executions: () => executions, reads: () => reads,
    recoveries: () => recoveries, setLateReceipt: () => { lateReceipt = true; },
    setArchived: () => { archived = true; }, setUnknown: () => { unknown = true; }, setBusyOnce: () => { busyOnce = true; } };
}

test("ordinary Route envelope executes once without an Agent source, registration or Route on B", async t => {
  const f = fixture(t), first = await f.invoke();
  assert.equal(first.status, 200); assert.equal(f.executions(), 1); assert.equal(f.reads(), 1);
  assert.deepEqual((first.body as { result: unknown }).result, { taskId: "original-route-id", status: "delivered" });
  f.setArchived();
  const historical = await f.invoke(true);
  assert.equal(historical.status, 200); assert.equal(f.executions(), 1); assert.equal(f.reads(), 1, "archived owner is irrelevant to its original accepted receipt");
  assert.equal((await f.invoke()).status, 200); assert.equal(f.executions(), 1);
  const { prompt: _prompt, ...query } = f.body;
  const receiptOnly = await f.invoke(true, query);
  assert.equal((receiptOnly.body as { delivery: { state: string } }).delivery.state, "accepted");
  assert.equal(f.reads(), 1);
  const conflict = await f.invoke(false, { ...f.body, prompt: "changed original message" });
  assert.equal(conflict.status, 409); assert.equal((conflict.body as { commitState: string }).commitState, "not_started");
});

test("positive no-frame busy proof lets the same Route ID resume once without rotating unknown attempts", async t => {
  const f = fixture(t); f.setBusyOnce();
  const busy = await f.invoke(); assert.equal(busy.status, 409);
  assert.equal((busy.body as { commitState: string }).commitState, "not_started");
  const { prompt: _prompt, ...query } = f.body;
  const proof = await f.invoke(true, query);
  assert.equal((proof.body as { delivery: { state: string } }).delivery.state, "missing");
  assert.equal((await f.invoke()).status, 200); assert.equal(f.executions(), 2);
  assert.equal((await f.invoke()).status, 200); assert.equal(f.executions(), 2, "accepted native execution is never repeated");
});

test("unknown native Route attempt is reconciled under its original ID and never replayed", async t => {
  const f = fixture(t); f.setUnknown();
  assert.equal((await f.invoke()).status, 202);
  assert.equal((await f.invoke()).status, 202);
  assert.equal((await f.invoke(true)).status, 202); assert.equal(f.executions(), 1);
});

test("receipt-only recovery retains uncertainty for a damaged original content hash", async t => {
  const f = fixture(t); f.setUnknown();
  assert.equal((await f.invoke()).status, 202);
  const ownerDirectory = path.join(f.directory, fs.readdirSync(f.directory)[0]!);
  const evidenceFile = path.join(ownerDirectory, fs.readdirSync(ownerDirectory)[0]!);
  const original = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  const { prompt: _prompt, ...query } = f.body;
  f.setLateReceipt();
  const before = f.recoveries();
  for (const field of ["promptHash", "executionOptionsHash"]) {
    const damaged = { ...original }; delete damaged[field];
    fs.writeFileSync(evidenceFile, JSON.stringify(damaged));
    await assert.rejects(f.invoke(true, query), /original content hashes/);
    assert.equal(f.recoveries(), before); assert.equal(f.executions(), 1);
    assert.equal(JSON.parse(fs.readFileSync(evidenceFile, "utf8")).receipt, undefined);
  }
});

test("registered receipt-only HTTP recovery commits late owner evidence after reconnect without sending again", async t => {
  const f = fixture(t), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("fixture-native-route-recovery", f.operations());
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/route-deliveries`;
  const call = async (body: Record<string, unknown>, suffix = "") => {
    const response = await fetch(base + suffix, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  f.setUnknown();
  assert.equal((await call(f.body)).status, 202);
  const { prompt: _prompt, ...query } = f.body;
  assert.equal((await call(query, "/reconcile")).body.delivery.state, "uncertain");
  const priorRecoveries = f.recoveries();
  const missing = await call({ ...query, deliveryId: "no-original-record" }, "/reconcile");
  assert.equal(missing.body.delivery.state, "missing");
  assert.equal(f.recoveries(), priorRecoveries, "an absent attempt cannot invent an owner receipt");
  f.setArchived(); f.setLateReceipt();
  const recovered = await call(query, "/reconcile");
  assert.equal(recovered.status, 200); assert.equal(recovered.body.delivery.state, "accepted");
  assert.equal(recovered.body.receipt.action, "receipt_recovered");
  const settledRecoveries = f.recoveries();
  assert.equal((await call(query, "/reconcile")).body.delivery.state, "accepted");
  assert.equal(f.recoveries(), settledRecoveries, "a committed receipt is read directly");
  assert.equal(f.executions(), 1); assert.equal(f.reads(), 1, "historical recovery never reopens the current task");
});

test("registered HTTP contracts retain business no-frame and payload-conflict 409 responses", async t => {
  const f = fixture(t), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("fixture-native-route", f.operations());
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/route-deliveries`;
  const call = async (body: Record<string, unknown>, suffix = "") => {
    const response = await fetch(base + suffix, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  f.setBusyOnce();
  const busy = await call(f.body);
  assert.equal(busy.status, 409); assert.equal(busy.body.commitState, "not_started"); assert.equal(busy.body.deliveryId, f.body.deliveryId);
  assert.equal((await call(f.body)).status, 200); assert.equal(f.executions(), 2);
  const conflict = await call({ ...f.body, prompt: "another original message" });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.commitState, "not_started");
  assert.equal(conflict.body.errorCode, undefined, "business conflict is not replaced with a framework validation error");
  const { prompt: _prompt, ...query } = f.body;
  assert.equal((await call(query, "/reconcile")).body.delivery.state, "accepted"); assert.equal(f.executions(), 2);
});
