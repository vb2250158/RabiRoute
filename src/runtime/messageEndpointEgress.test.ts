import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { handleAgentReply, inspectAgentReplyDelivery, type AgentReplyOptions } from "../outbox.js";
import { napcatEndpointFixture } from "../manager/napcatEndpointPlugin.fixture.js";

test("the actual NapCat package drains the original upload and caption lease while rejecting new replies", { timeout: 90_000 }, async () => {
  const fixture = await napcatEndpointFixture();
  let releaseUpload!: () => void, uploadStarted!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const calls: Array<{ url: string; authorization?: string }> = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => { void (async () => {
      calls.push({url: request.url!, authorization: request.headers.authorization});
      if (request.url === "/upload_group_file") { uploadStarted(); await uploadGate; }
      response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({status: "ok", retcode: 0,
        data: request.url === "/get_login_info" ? { user_id: 7777 } : request.url === "/upload_group_file" ? { file_id: "uploaded-original" } : { message_id: 123 }}));
    })(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const file = path.join(fixture.root, "lease.txt");
  await fs.writeFile(file, "original bytes");
  const options: AgentReplyOptions = { rootDir: fixture.root, routeRoot: path.join(fixture.root, "route"), rolesRoot: path.join(fixture.root, "roles"),
    endpointEgress: capability => fixture.kernel.current().services.services.get(capability)?.value as MessageEndpointEgressProvider | undefined,
    runtimes: [{ id: "route", enabled: true, pipeline: { outputAdapter: "qq", outputPipeline: "qq" },
      messageAdapterPolicies: {napcat: { outputEnabled: true, supportedOutputs: ["file", "text"], allowedFileRoots: [fixture.root] }},
      napcatInstances: [{ id: "qq", enabled: true, httpUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, accessToken: "original-test-token" }] }] };
  try {
    await fixture.kernel.switch([fixture.candidate("original")]);
    const provider = options.endpointEgress!("endpoint.napcat.egress@1")!;
    assert.ok(provider);
    const accepted = handleAgentReply({ explicitTarget: true, sendChannel: "napcat", routeProfileId: "route", targetType: "group", groupId: "20002", instanceId: "qq",
      payloadType: "file", filePath: file, text: "original caption", deliveryId: "original-lease" }, options);
    await started;
    let retired = false;
    const retiring = fixture.kernel.switch([]).then(() => { retired = true; });
    const deadline = Date.now() + 5_000;
    while (options.endpointEgress!("endpoint.napcat.egress@1")) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(retired, false);
    const blockedRequest = { explicitTarget: true, sendChannel: "napcat", routeProfileId: "route", targetType: "group", groupId: "20002", instanceId: "qq", text: "new blocked reply", deliveryId: "blocked-original-id" };
    const blocked = await handleAgentReply(blockedRequest, options);
    assert.equal(blocked.status, "blocked");
    const readback = await inspectAgentReplyDelivery(blockedRequest, options);
    assert.equal(readback.state, "completed");
    if (readback.state === "completed") assert.equal(readback.result.status, "blocked");
    assert.equal(calls.filter(call => call.url === "/send_group_msg").length, 0);
    releaseUpload();
    const result = await accepted;
    assert.equal(result.status, "sent", JSON.stringify(result));
    assert.equal(result.sentFileId, "uploaded-original");
    await retiring;
    assert.equal(retired, true);
    assert.equal(calls.filter(call => call.url === "/upload_group_file").length, 1);
    assert.equal(calls.filter(call => call.url === "/send_group_msg").length, 1);
    assert.ok(calls.every(call => call.authorization === "Bearer original-test-token"));
    assert.throws(() => provider.acquire({}), /disabled or retiring/);
  } finally {
    releaseUpload();
    await fixture.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
