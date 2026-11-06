import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
import { handleAgentReply, inspectAgentReplyDelivery, type AgentReplyOptions } from "../outbox.js";
import { napcatEndpointFixture } from "../manager/napcatEndpointPlugin.fixture.js";
import { verifyQqFileCurrentPresence, type CurrentQqFileBinding, type OriginalQqFileBinding } from "../manager/agentDeliveryVerification.js";

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
      messageAdapterPolicies: {napcat: { outputEnabled: true, supportedOutputs: ["file", "text"] }},
      napcatInstances: [{ id: "qq", enabled: true, httpUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, accessToken: "original-test-token" }] }] };
  try {
    await fixture.kernel.switch([fixture.candidate("original")]);
    const provider = options.endpointEgress!("endpoint.napcat.egress@1")!;
    assert.ok(provider);
    const accepted = handleAgentReply({ explicitTarget: true, sendChannel: "napcat", routeProfileId: "route", targetType: "group", groupId: "20002", instanceId: "qq",
      payloadType: "file", filePath: file, text: "original caption", deliveryId: "original-lease" }, options);
    await Promise.race([started, accepted.then(result => { throw new Error(`Upload completed before its owned read: ${JSON.stringify(result)}`); })]);
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

test("owned sticker preparation and the final send keep the accepted original endpoint through retirement", { timeout: 90_000 }, async () => {
  const fixture = await napcatEndpointFixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const id = "0123456789abcdef0123456789abcdef";
  const calls: Array<{ action: string; authorization?: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => { void (async () => {
      const action = request.url!;
      calls.push({ action, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (action === "/fetch_custom_face_detail") { started(); await gate; }
      const data = action === "/fetch_custom_face_detail" ? [{ md5: id, url: `https://example.invalid/${id}`, desc: "favorite" }]
        : action === "/get_login_info" ? { user_id: 7777 } : { message_id: 123 };
      response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({ status: "ok", retcode: 0, data }));
    })(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const options: AgentReplyOptions = { rootDir: fixture.root, routeRoot: path.join(fixture.root, "route"), rolesRoot: path.join(fixture.root, "roles"),
    endpointEgress: capability => fixture.kernel.current().services.services.get(capability)?.value as MessageEndpointEgressProvider | undefined,
    runtimes: [{ id: "route", enabled: true, pipeline: { outputAdapter: "qq", outputPipeline: "qq" },
      messageAdapterPolicies: {napcat: { outputEnabled: true, supportedOutputs: ["image"] }},
      napcatInstances: [{ id: "original-qq", enabled: true, httpUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, accessToken: "original-test-token" }] }] };
  try {
    await fixture.kernel.switch([fixture.candidate("sticker-original")]);
    const request = { explicitTarget: true, sendChannel: "napcat", routeProfileId: "route", targetType: "private", userId: "20002", instanceId: "original-qq",
      payload: { type: "sticker", stickerId: id, text: "caption" }, deliveryId: "sticker-original-lease" };
    const accepted = handleAgentReply(request, options);
    await Promise.race([reading, accepted.then(result => { throw new Error(`Sticker send completed before its owned read: ${JSON.stringify(result)}`); })]);
    let retired = false;
    const retiring = fixture.kernel.switch([]).then(() => { retired = true; });
    const deadline = Date.now() + 5_000;
    while (options.endpointEgress!("endpoint.napcat.egress@1")) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(retired, false);
    assert.equal((await handleAgentReply({ ...request, deliveryId: "sticker-blocked" }, options)).status, "blocked");
    release();
    assert.equal((await accepted).status, "sent");
    await retiring;
    const sends = calls.filter(call => call.action === "/send_private_msg");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.user_id, 20002);
    assert.deepEqual(sends[0].body.message.at(-1), { type: "image", data: { file: `https://example.invalid/${id}`, sub_type: 1, summary: "favorite" } });
    assert.ok(calls.every(call => call.authorization === "Bearer original-test-token"));
  } finally {
    release();
    await fixture.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("group-file verification reads through the real owned provider and drains only its original lease", { timeout: 90_000 }, async () => {
  const fixture = await napcatEndpointFixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const original: OriginalQqFileBinding = { routeId: "route", instanceId: "original-qq", groupId: "20002", platformFileId: "original-file", selfId: "7777", bindingRevision: "revision-original" };
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => { void (async () => {
      calls++;
      assert.equal(request.url, "/get_group_root_files");
      assert.equal(request.headers.authorization, "Bearer original-test-token");
      started(); await gate;
      response.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({ status: "ok", retcode: 0,
        data: { files: [{ file_id: "original-file", file_name: "original.txt" }], folders: [] } }));
    })(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const binding: CurrentQqFileBinding = { ...original, readAllowed: true, endpoint: { httpUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, accessToken: "original-test-token" } };
  const dependencies = { readCurrentBinding: () => binding, readAccountIdentity: async () => ({ selfId: "7777" }),
    endpointEgress: (capability: string) => fixture.kernel.current().services.services.get(capability)?.value as MessageEndpointEgressProvider | undefined };
  try {
    await fixture.kernel.switch([fixture.candidate("group-read-original")]);
    const accepted = verifyQqFileCurrentPresence(original, dependencies);
    await Promise.race([reading, accepted.then(result => { throw new Error(`Verification completed before its owned read: ${JSON.stringify(result)}`); })]);
    let retired = false;
    const retiring = fixture.kernel.switch([]).then(() => { retired = true; });
    const deadline = Date.now() + 5_000;
    while (dependencies.endpointEgress("endpoint.napcat.egress@1")) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(retired, false);
    assert.equal((await verifyQqFileCurrentPresence(original, dependencies)).status, "unknown");
    assert.equal(calls, 1);
    release();
    assert.equal((await accepted).status, "present");
    await retiring;
    assert.equal(retired, true);
    assert.equal(calls, 1);
  } finally {
    release();
    await fixture.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
