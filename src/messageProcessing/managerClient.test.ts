import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { findReferencedAgentSenders } from "./managerClient.js";

test("referenced Agent sender lookup uses the exact channel, platform message id, and Route", async (t) => {
  let requestedPath = "";
  const server = http.createServer((request, response) => {
    requestedPath = request.url || "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      code: 0,
      data: {
        matches: [
          {
            deliveryId: "delivery-7788",
            result: {
              sender: {
                agentType: "message_processing",
                sessionId: "019f0000-0000-7000-8000-000000000072"
              }
            }
          },
          { deliveryId: "missing-sender", result: {} }
        ]
      }
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const senders = await findReferencedAgentSenders(`http://127.0.0.1:${address.port}`, {
    channel: "napcat",
    sentMessageId: "qq-outbound-7788",
    routeId: "route-main"
  });

  const requestUrl = new URL(requestedPath, "http://127.0.0.1");
  assert.equal(requestUrl.pathname, "/api/agent/send/traces");
  assert.equal(requestUrl.searchParams.get("channel"), "napcat");
  assert.equal(requestUrl.searchParams.get("sentMessageId"), "qq-outbound-7788");
  assert.equal(requestUrl.searchParams.get("routeId"), "route-main");
  assert.deepEqual(senders, [{
    deliveryId: "delivery-7788",
    agentType: "message_processing",
    sessionId: "019f0000-0000-7000-8000-000000000072"
  }]);
});
