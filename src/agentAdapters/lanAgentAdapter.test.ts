import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { notifyInstanceAgent } from "./lanAgentAdapter.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";

test("LAN adapter sends the selected node and stable delivery identity; offline and missing binding fail", async () => {
  const keys = ["LAN_AGENT_NODE_ID", "LAN_AGENT_ACCESS_TOKEN", "GATEWAY_MANAGER_URL", "GATEWAY_ID"];
  const previous = keys.map(key => process.env[key]);
  const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0, instances: [{ instanceId: "node-fixture", connected: true,
        agents: [{ agentId: "agent-fixture", provider: "codex-desktop", enabled: true, sessionId: "configured-thread", workspace: "C:/workspace" }] }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, body: JSON.parse(raw) });
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 0, result: { taskId: "task-fixture", status: "delivered" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const envelope = { messageSource: { type: "system" as const, eventType: "test", eventName: "LAN test", eventId: "fixture" }, messageContent: "hello", deliveryId: "delivery-fixture" };
  try {
    process.env.LAN_AGENT_NODE_ID = "node-fixture";
    process.env.LAN_AGENT_ACCESS_TOKEN = "fixture-only";
    process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.GATEWAY_ID;
    await notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope, {threadId:"explicit-thread",workspace:"C:/workspace"});
    assert.equal(requests[0]?.url, "/api/lan-agent/instances/node-fixture/agents/agent-fixture/tasks");
    assert.equal(requests[0]?.body.idempotencyKey, "delivery-fixture");
    assert.equal(requests[0]?.body.provider, "codex-desktop");
    assert.equal(requests[0]?.body.threadId, "explicit-thread");
    await assert.rejects(notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope, { imagePaths: ["local.png"] }), /图片/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await assert.rejects(notifyInstanceAgent("codex", { instanceId: "node-fixture", agentId: "agent-fixture" }, envelope));

  } finally {
    server.close();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});

test("Route Peer delivery uses the connected target Manager and preserves non-Agent envelope and delivery ID", async () => {
  const keys = ["LAN_AGENT_ACCESS_TOKEN", "GATEWAY_MANAGER_URL", "GATEWAY_ID"], previous = keys.map(key => process.env[key]);
  let calls = 0;
  const envelope = { messageSource: { type: "system" as const, eventType: "route", eventName: "Route event", eventId: "event" },
    messageContent: "ordinary Route content", deliveryId: "stable-route-id", sentAt: "2026-11-02T00:00:00Z" };
  const server = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    assert.equal(request.url, "/api/rabilink/peer/http/pc-b/manager/api/agent/route-deliveries");
    const body = JSON.parse(raw); assert.equal(body.deliveryId, envelope.deliveryId); assert.equal(body.prompt, renderRabiDelivery(envelope));
    assert.equal(body.instanceId, "instance-b"); assert.equal(body.threadId, "full-session-b"); assert.equal(body.provider, "codex");
    assert.equal(body.sourceThreadId, undefined); assert.equal(body.messageSource, undefined);
    response.writeHead(++calls === 1 ? 200 : 202, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0, result: { taskId: body.deliveryId, status: calls === 1 ? "delivered" : "awaiting_confirmation" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    process.env.LAN_AGENT_ACCESS_TOKEN = "fixture-only"; delete process.env.GATEWAY_ID;
    process.env.GATEWAY_MANAGER_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const binding = { ownerDeviceId: "pc-b", instanceId: "instance-b", agentId: "not-registered" };
    await notifyInstanceAgent("codex", binding, envelope, { threadId: "full-session-b" });
    await assert.rejects(notifyInstanceAgent("codex", binding, envelope, { threadId: "full-session-b" }), /unconfirmed/);
    assert.equal(calls, 2, "uncertain result must not cause an automatic retransmission");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }); }
});
