import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AgentRequestStore, type AgentRequestRecord } from "../agentRequests/store.js";
import { createAgentCommunicationRecordOperations } from "./agentCommunicationRecordOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

test("executable record routes use the existing store, preserve terminal cancellation and expose read-only traces", async t => {
  const record: AgentRequestRecord = { id: "original-request", deliveryId: "original-delivery", status: "awaiting_response",
    source: { threadId: "source-session", agentType: "dsh" }, target: { threadId: "target-session", agentType: "codex" },
    responseInstruction: "reply", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", reminderCount: 0 };
  let persisted: unknown = { version: 1, requests: { [record.id]: record } };
  let writes = 0; let refreshed = 0; const events: string[] = [];
  const store = new AgentRequestStore({ read: () => structuredClone(persisted), write: state => { persisted = structuredClone(state); writes++; } });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("records", createAgentCommunicationRecordOperations({
    agentRequests: store, refreshAgentRequestReminderTimers: () => { refreshed++; }, publishManagerEvent: type => { events.push(type); },
    findSendTraces: query => { assert.deepEqual(query, { channel: "napcat", sentMessageId: "example-message", routeId: null }); return []; }
  }));
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const list = await fetch(root + "/api/agent/requests?status=awaiting_response");
  assert.equal(list.status, 200); assert.equal((await list.json()).data.requests[0].id, record.id);
  assert.equal(writes, 0);
  const url = root + "/api/agent/requests/" + record.id;
  const initial = await fetch(url); assert.equal(initial.status, 200); assert.equal((await initial.json()).data.status, record.status);
  const cancel = async (reason: unknown) => {
    const response = await fetch(url + "/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
    assert.equal(response.status, 200); return (await response.json()).data;
  };
  const first = await cancel("original cancellation"); assert.equal(first.status, "cancelled");
  const second = await cancel("replacement reason"); assert.deepEqual(second, first);
  assert.equal(writes, 1); assert.equal(refreshed, 2); assert.deepEqual(events, ["agent_requests_changed", "agent_requests_changed"]);
  const final = await fetch(url); assert.equal((await final.json()).data.cancelReason, "original cancellation");
  const missing = await fetch(root + "/api/agent/requests/missing"); assert.equal(missing.status, 404);
  const traces = await fetch(root + "/api/agent/send/traces?channel=napcat&sentMessageId=example-message");
  assert.equal(traces.status, 200); assert.deepEqual((await traces.json()).data.matches, []);
  assert.equal((await fetch(root + "/api/agent/send/traces?channel=napcat")).status, 400);
  assert.equal(writes, 1);
});
