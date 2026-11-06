import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { normalizeDshBinding, sendDshTask } from "../../../src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs";

test("DSH binds one exact local session and steers both messages without creation", async t => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ rpcId: body.rpcId, result: { ok: body.payload.content[0].text !== "reject" } }));
  });
  // The host may configure ephemeral ports in Node Fetch's forbidden low range.
  const fixturePort = 49_152 + (process.pid % 16_383);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(fixturePort, "127.0.0.1", resolve); });
  const binding = { baseUrl: `http://127.0.0.1:${server.address().port}`, sessionId: "session-fixture" };
  try {
    t.diagnostic(`DSH fixture ${binding.baseUrl}`);
    try { await sendDshTask(binding, "one"); }
    catch (error) {
      t.diagnostic(JSON.stringify({ phase: "first-send", port: fixturePort, receivedRequests: requests.length,
        error: error.message, cause: { message: error.cause?.message, code: error.cause?.code, address: error.cause?.address, port: error.cause?.port } }));
      throw error;
    }
    await sendDshTask(binding, "two");
    assert.deepEqual(requests.map(item => [item.method, item.payload.sessionId, item.payload.mode]), [["session.prompt", "session-fixture", "steer"], ["session.prompt", "session-fixture", "steer"]]);
    await assert.rejects(sendDshTask(binding, "reject"), /rejected/);
    assert.deepEqual(requests.map(item => item.payload.content[0].text), ["one", "two", "reject"]);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(sendDshTask(binding, "offline"));
});

test("DSH rejects a remote endpoint and a missing session", () => {
  assert.throws(() => normalizeDshBinding({ baseUrl: "http://192.168.1.20", sessionId: "session-test" }), /local API/);
  assert.throws(() => normalizeDshBinding({ baseUrl: "http://localhost:1234" }), /session ID/);
});
