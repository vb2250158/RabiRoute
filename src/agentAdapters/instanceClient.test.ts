import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { primaryAgentInstanceBindings } from "../shared/routeAgentTargets.js";
import { configuredInstanceBinding, requestInstanceThread, instanceWorkerStateDirectory } from "./instanceClient.js";
import { requestPeerRouteDelivery } from "./peerRouteClient.js";

test("new child environment isolates primary target from all same-provider saved targets", () => {
  const keys = ["PRIMARY_AGENT_TARGET", "REMOTE_AGENT_TARGETS", "AGENT_INSTANCE_BINDINGS"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const remote = { id: "remote:node:agent", instanceId: "node", agentId: "agent", provider: "codex" as const };
  try {
    process.env.REMOTE_AGENT_TARGETS = JSON.stringify([remote]);
    process.env.AGENT_INSTANCE_BINDINGS = JSON.stringify({ codex: remote });
    for (const primaryAgentTarget of ["local:codex", "", "remote:missing:agent"]) {
      process.env.PRIMARY_AGENT_TARGET = primaryAgentTarget;
      assert.equal(configuredInstanceBinding("codex"), undefined);
    }
    process.env.PRIMARY_AGENT_TARGET = remote.id;
    assert.deepEqual(configuredInstanceBinding("codex"), { instanceId: "node", agentId: "agent" });
    assert.equal(configuredInstanceBinding("dsh"), undefined);
    assert.deepEqual(primaryAgentInstanceBindings({ agentAdapters: [], remoteAgentTargets: [remote], primaryAgentTarget: remote.id }), { codex: { instanceId: "node", agentId: "agent" } });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("Peer worker sends use native Route receipts and preserve exact IDs through readback and explicit conflict", async () => {
  const saved = { url: process.env.GATEWAY_MANAGER_URL, token: process.env.LAN_AGENT_ACCESS_TOKEN };
  const requests: { url?: string; body: Record<string, unknown> }[] = [];
  let conflict = false;
  const server = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: request.url, body });
    assert.equal(request.headers.authorization, undefined, "loopback Manager admission does not require enabling LAN access");
    if (request.url === "/api/agent/threads") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body.action === "list" ? { code: 0, threads: [{ id: "worker-b" }] } : { code: 0, thread: { id: body.threadId } }));
      return;
    }
    response.writeHead(conflict ? 409 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(conflict ? { code: -1, commitState: "not_started", message: "Original ID has another payload" }
      : request.url?.endsWith("/reconcile") ? { code: 0, delivery: { state: "accepted" }, result: { status: "delivered" } }
      : { code: 0, result: { status: "delivered" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const binding = { ownerDeviceId: "pc-b", instanceId: "instance-b", agentId: "not-registered" };
  try {
    process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    delete process.env.LAN_AGENT_ACCESS_TOKEN;
    await assert.rejects(requestInstanceThread(binding, { action: "reconcile_delivery", agentAdapter: "codex", threadId: "worker-b" }), /original delivery ID/);
    await assert.rejects(requestPeerRouteDelivery(binding, { action: "read", agentAdapter: "codex", threadId: "worker-b", deliveryId: " " }), /original delivery ID/);
    assert.equal(requests.length, 0, "receipt queries never generate a replacement delivery ID or dispatch a request without the original");
    const sent = await requestInstanceThread(binding, { action: "send", agentAdapter: "codex", threadId: "worker-b", cwd: "/native/b",
      prompt: "worker request", messageSource: { type: "system", eventType: "worker", eventName: "Message worker", eventId: "batch-1" },
      messageDelivery: { deliveryId: "batch-1" }, sentAt: "2026-11-02T00:00:00Z" });
    assert.equal(sent.delivery.deliveryId, "batch-1"); assert.equal(sent.delivery.state, "accepted");
    assert.equal(requests[0]!.url, "/api/rabilink/peer/http/pc-b/manager/api/agent/route-deliveries");
    assert.equal(requests[0]!.body.deliveryId, "batch-1"); assert.match(String(requests[0]!.body.prompt), /worker request/);
    assert.equal(requests[0]!.body.sourceThreadId, undefined);
    const read = await requestInstanceThread(binding, { action: "read", agentAdapter: "codex", threadId: "worker-b", deliveryId: "batch-1" });
    assert.equal(read.delivery.state, "accepted"); assert.equal(requests[1]!.body.prompt, undefined);
    assert.equal(requests[1]!.url, "/api/rabilink/peer/http/pc-b/manager/api/agent/route-deliveries/reconcile");
    const list = await requestInstanceThread(binding, { action: "list", agentAdapter: "codex" });
    const metadata = await requestInstanceThread(binding, { action: "read", agentAdapter: "codex", threadId: "worker-b" });
    assert.equal(list.threads[0].id, "worker-b"); assert.equal(metadata.thread.id, "worker-b");
    assert.equal(requests[2]!.url, "/api/agent/threads"); assert.equal(requests[3]!.url, "/api/agent/threads");
    assert.deepEqual(requests[3]!.body.instanceBinding, binding);
    conflict = true;
    await assert.rejects(requestInstanceThread(binding, { action: "send", agentAdapter: "codex", threadId: "worker-b", prompt: "changed", deliveryId: "batch-1" }), error => {
      const result = error as Error & { response: { commitState: string; deliveryId: string; delivery?: unknown; error: { commitState: string } } };
      return result.response.commitState === "not_started" && result.response.error.commitState === "not_started"
        && result.response.deliveryId === "batch-1" && !result.response.delivery;
    });
    assert.equal(requests.length, 5, "explicit conflicts never trigger readback of the old successful receipt");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (saved.url === undefined) delete process.env.GATEWAY_MANAGER_URL; else process.env.GATEWAY_MANAGER_URL = saved.url;
    if (saved.token === undefined) delete process.env.LAN_AGENT_ACCESS_TOKEN; else process.env.LAN_AGENT_ACCESS_TOKEN = saved.token;
  }
});

test("instance requests select the bound owner and never fall back to local tasks", async () => {
  const saved = { url: process.env.GATEWAY_MANAGER_URL, token: process.env.LAN_AGENT_ACCESS_TOKEN, bindings: process.env.AGENT_INSTANCE_BINDINGS };
  const binding = { instanceId: "computer-a", agentId: "agent-a" };
  let online = true;
  let failed = false;
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++;
    assert.equal(request.headers.authorization, "Bearer instance-test");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "GET"
      ? { code: 0, instances: [{ instanceId: "computer-a", connected: online, agents: [{ agentId: "agent-a", enabled: true, sessionId: "task-a", workspace: "/remote/project" }] }] }
      : { code: 0, result: { statusCode: failed ? 409 : 200, data: failed ? { message: "owner unavailable" } : { thread: { id: "task-a" } } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  process.env.LAN_AGENT_ACCESS_TOKEN = "instance-test";
  process.env.AGENT_INSTANCE_BINDINGS = JSON.stringify({ codex: binding });
  try {
    assert.deepEqual(configuredInstanceBinding("codex"), binding);
    assert.equal((await requestInstanceThread(binding, { action: "read", agentAdapter:"dsh",threadId:"task-a" })).thread.id, "task-a");
    online = false;
    failed = true;
    await assert.rejects(requestInstanceThread(binding, { action: "open" }), /owner unavailable/);
    const before = calls;
    await assert.rejects(requestInstanceThread(binding, { action: "send", imagePaths: ["/local/image.png"] }), /local image/);
    assert.equal(calls, before);
    assert.notEqual(instanceWorkerStateDirectory("data", binding, "task-a"), instanceWorkerStateDirectory("data", binding, "task-b"));
    assert.notEqual(instanceWorkerStateDirectory("data", binding, "task-a"), instanceWorkerStateDirectory("data", { ...binding, instanceId: "computer-b" }, "task-a"));
  } finally {
    for (const [key, value] of Object.entries({ GATEWAY_MANAGER_URL: saved.url, LAN_AGENT_ACCESS_TOKEN: saved.token, AGENT_INSTANCE_BINDINGS: saved.bindings })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
