import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ALL_DAY_MESSAGE_INGRESS, handleAllDayMessageIngress, projectAllDayMessage } from "./allDayMessageIngress.js";

test("gateway text projection requires an authorized route and the active Manager generation", async t => {
  const identity = { applicationGenerationId: "current-generation", managerInstanceId: "current-manager" };
  const roleId = "fixture-role";
  const routeId = "本机角色/fixture";
  const capability = "test-capability";
  const received: unknown[] = [];
  const server = http.createServer((request, response) => {
    void handleAllDayMessageIngress(request, new URL(request.url!, "http://127.0.0.1"), response, {
      identity,
      authorize: (route, role, token) => route === routeId && role === roleId && token === capability,
      async readJson<T>(incoming: http.IncomingMessage, maxBytes: number): Promise<T> {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert.ok(body.length <= maxBytes);
        return JSON.parse(body.toString());
      },
      async receive(role, category, message, authorize) {
        authorize?.();
        received.push({ role, category, ...message });
        return true;
      },
      json: (out, status, data) => out.writeHead(status).end(JSON.stringify(data))
    }).catch(() => response.writeHead(500).end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { GATEWAY_MANAGER_URL: origin, GATEWAY_ID: routeId, PERSONA_MESSAGING_CAPABILITY: capability,
    RABIROUTE_APPLICATION_GENERATION_ID: identity.applicationGenerationId, RABIROUTE_MANAGER_INSTANCE_ID: identity.managerInstanceId };
  for (const [key, value] of Object.entries(env)) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    process.env[key] = value;
  }
  const message = { roleId, category: "weixin" as const, id: "fixture-event", time: Date.now(), text: "test inbound text" };
  const anonymous = await fetch(`${origin}${ALL_DAY_MESSAGE_INGRESS}`, { method: "POST", body: JSON.stringify(message) });
  assert.equal(anonymous.status, 403);
  await anonymous.body?.cancel();
  await assert.rejects(projectAllDayMessage({ ...message, roleId: "another-role" }), /HTTP 403/);
  process.env.RABIROUTE_APPLICATION_GENERATION_ID = "stale-generation";
  await assert.rejects(projectAllDayMessage(message), /HTTP 403/);
  assert.deepEqual(received, []);
  process.env.RABIROUTE_APPLICATION_GENERATION_ID = identity.applicationGenerationId;
  await projectAllDayMessage(message);
  assert.deepEqual(received, [{ role: roleId, category: message.category, id: message.id, time: message.time, text: message.text }]);
});
