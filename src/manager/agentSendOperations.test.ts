import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { AGENT_SEND_CHANNEL_HELP, AGENT_SEND_REQUEST_CONTRACT } from "../agentSendContracts.js";
import { prepareAgentSendRequest } from "../agentSend.js";
import { agentSendOperationContract, createAgentSendOperations, agentSendError } from "./agentSendOperations.js";
import { ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { agentSendReceiptResponse, executeIdempotentAgentSend } from "./agentSendIdempotency.js";
import { apiDigest, compileApiOperation, readApiOperationInput, validateApiOperationResult } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard, setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createAgentReceiptMaintenanceOperations } from "./agentSendReceiptOperations.js";
import { verifyAgentSendDelivery, settleAgentSendDelivery } from "./agentSendReconciliation.js";
import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";

const base = { deliveryId: "same-delivery", sender: { agentType: "dsh", sessionId: "example-session" }, routeId: "example-route" };

test("Manager read failures are service failures, not invalid send requests", () => {
  const result = agentSendError(new ManagerReadWorkerError("Manager read conversation_window exceeded 30000 ms.", "timeout"));
  const body = result.body as Record<string, unknown>;
  assert.equal(result.status, 503);
  assert.equal(body.errorCode, "MANAGER_READ_TIMEOUT");
  assert.equal(body.status, "failed");
  assert.match(String(body.message), /conversation_window/);
  assert.equal(agentSendError(new Error("Missing deliveryId")).status, 400);
});

test("HTTP send schema migrates retired voice aliases without advertising or mutating them", async () => {
  const operation = compileApiOperation({ contract: agentSendOperationContract, handler: () => ({ status: 200 }) });
  const read = async (body: unknown) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
    request.headers = { "content-type": "application/json" };
    return readApiOperationInput(operation, request, new URL("http://localhost/api/agent/send"), {} as http.ServerResponse);
  };
  assert.equal(AGENT_SEND_CHANNEL_HELP.some(item => String(item.channel) === "fennenote"), false);
  for (const params of [{ sessionId: "voice-session", mode: "message" }, { sessionId: "voice-session", mode: "playback" }]) {
    const body = { ...base, channel: "fennenote", params, payload: { type: "text", text: "hello" } };
    const before = structuredClone(body);
    assert.deepEqual((await read(body)).body, before);
    const prepared = prepareAgentSendRequest(body);
    assert.equal(prepared.channel, "speech");
    assert.deepEqual(body, before);
  }
  await read({ ...base, channel: "speech", params: {}, payload: { type: "text", text: "hello" } });
  for (const params of [{ sessionId: "voice-session", mode: "invalid" }, { sessionId: "voice-session" }, { mode: "message" }]) {
    await assert.rejects(read({ ...base, channel: "fennenote", params, payload: { type: "text", text: "hello" } }));
  }
});

test("send executable schema accepts established channel examples and normalization without a second channel map", async () => {
  const operation = compileApiOperation({ contract: agentSendOperationContract, handler: () => ({ status: 200 }) });
  for (const example of [...AGENT_SEND_CHANNEL_HELP.map(value => value.example),
    { channel: ["speech"], params: {}, payload: { type: ["text"], text: 456 } },
    { channel: "napcat", params: { target: "private", userId: 123 }, payload: { type: "image", segments: [{ type: "text", text: "caption" }, { type: "image", url: "https://example.invalid/image.png" }] } },
    { channel: "napcat", params: { target: "group", groupId: "example", replyToMessageId: "" }, payload: {
      type: "file", fileId: "12345678-1234-4234-8234-123456789012", fileSha256: "a".repeat(64), planAttachment: null
    } }]) {
    const body = { ...base, ...example };
    assert.doesNotThrow(() => prepareAgentSendRequest(body));
    const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
    request.headers = { "content-type": "application/json" };
    const input = await readApiOperationInput(operation, request, new URL("http://localhost/api/agent/send"), {} as http.ServerResponse);
    assert.deepEqual(input.body, body);
  }
});

test("real send routes publish the executed schema, preserve remote source guards and retain durable duplicate receipts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-send-contract-"));
  let deliveries = 0;
  let ownerCalls = 0;
  const context: Pick<AgentCommunicationRoutesContext, "send" | "receiptResponse" | "maintenance"> = {
    send: async (request, options) => {
      ownerCalls++;
      assert.equal(options?.remoteSource?.sessionId, "example-session");
      return executeIdempotentAgentSend(request, { rootDir: root, requestAuthority: options?.requestAuthority,
        deliver: async () => { deliveries++; return { ok: true, status: "sent" }; } });
    }, receiptResponse: id => agentSendReceiptResponse(root, id), maintenance: {
      verify: (id, originalRequest, options) => verifyAgentSendDelivery(id, originalRequest, { rootDir: root,
        requestAuthority: options.requestAuthority, verify: async () => ({ platformVerification: "unknown", evidence: { fixture: true } }) }),
      settle: (id, originalRequest, options) => settleAgentSendDelivery(id, originalRequest, { rootDir: root,
        requestAuthority: options.requestAuthority, verify: async () => ({ platformVerification: "unknown", evidence: { fixture: true } }) })
    }
  };
  const operations = [...createAgentSendOperations(context), ...createAgentReceiptMaintenanceOperations(context)];
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("communication", operations);
  const source = { nodeId: "fixture-node", agentId: "fixture-agent", provider: "dsh" as const, sessionId: "example-session", sessionName: "Example" };
  const server = http.createServer((request, response) => {
    setTrustedLanAgentSource(request, source);
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://localhost").pathname, body, source));
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("api-send-contract-"));
    await rm(root, { recursive: true, force: true }); });
  const capabilities = await fetch(url + "/api/agent/send/capabilities");
  assert.equal(capabilities.status, 200);
  const discovered = (await capabilities.json()).data;
  assert.deepEqual(discovered.requestContract, AGENT_SEND_REQUEST_CONTRACT);
  assert.equal(discovered.requestContractDigest, apiDigest(AGENT_SEND_REQUEST_CONTRACT));
  const snapshot = registry.catalogSnapshot();
  const published = snapshot.operations.find(value => value.contract.operationId === "agent.send")!;
  assert.deepEqual(published.contract.request.body, agentSendOperationContract.request.body);
  assert.match(discovered.contract.qq, /private managed-file upload is not implemented/);
  assert.equal(deliveries, 0);
  const body = { ...base, channel: "speech", params: {}, payload: { type: "text", text: "hello" } };
  const post = (value: unknown) => fetch(url + "/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  for (const duplicate of [false, true]) {
    const response = await post(body); const sent = await response.json(); assert.equal(response.status, 202, JSON.stringify(sent));
    assert.equal(response.headers.get("x-rabiroute-api-contract"), published.contractDigest);
    assert.equal(sent.idempotency.duplicate, duplicate);
    assert.equal(sent.idempotency.deliveryId, body.deliveryId);
  }
  assert.equal(deliveries, 1);
  const receipt = await fetch(url + "/api/agent/send/receipts/" + body.deliveryId);
  assert.equal(receipt.status, 202); assert.equal((await receipt.json()).idempotency.state, "completed");
  for (const [action, status, state] of [["verify", 200, "verified"], ["settle", 409, "conflict"]] as const) {
    const response = await fetch(url + `/api/agent/send/receipts/${body.deliveryId}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ originalRequest: body })
    });
    assert.equal(response.status, status); const evidence = await response.json(); assert.equal(evidence.state, state);
    assert.equal(evidence.deliveredNow, false); assert.equal(evidence.retryAllowed, false);
  }
  assert.equal(deliveries, 1);
  const before = ownerCalls;
  const invalidSource = await post({ ...body, sender: { agentType: "dsh", sessionId: " whitespace-session " } });
  assert.equal(invalidSource.status, 400); assert.equal((await invalidSource.json()).errorCode, "API_REQUEST_SOURCE_INVALID");
  const otherSource = await post({ ...body, sender: { agentType: "dsh", sessionId: "other-session" } });
  assert.equal(otherSource.status, 400); assert.equal((await otherSource.json()).errorCode, "API_REQUEST_SOURCE_INVALID");
  const privateFile = await post({ ...base, channel: "napcat", params: { target: "private", userId: "example" }, payload: {
    type: "file", fileId: "12345678-1234-4234-8234-123456789012", fileSha256: "a".repeat(64)
  } });
  assert.equal(privateFile.status, 400); assert.equal((await privateFile.json()).errorCode, "API_REQUEST_SCHEMA_INVALID");
  assert.equal(ownerCalls, before); assert.equal(deliveries, 1);
  for (const operation of operations) compileApiOperation(operation);
});

test("executable response boundary suppresses results after an admitted connection is revoked while awaiting", async t => {
  let revoked = false;
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("fixture", [{ contract: { ...agentSendOperationContract,
    operationId: "example.revocation", pathTemplate: "/api/example/revocation", request: { ...agentSendOperationContract.request, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", properties: { secret: { type: "string" } } } } }
  }, handler: async () => { started(); await pending; return { status: 200, body: { secret: "fixture-sensitive-result" } }; } }]);
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request, () => { if (revoked) throw new Error("fixture revoked"); });
    registry.handle(request, new URL(request.url!, "http://localhost"), response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { finish(); await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const result = fetch(`http://127.0.0.1:${address.port}/api/example/revocation`, { method: "POST" });
  await entered; revoked = true; finish();
  const response = await result; assert.equal(response.status, 403);
  const wire = await response.text(); assert.equal(wire.includes("fixture-sensitive-result"), false);
  const error = JSON.parse(wire); assert.equal(error.errorCode, "API_REQUEST_AUTHORITY_REVOKED");
  assert.equal(error.uncertain, true); assert.equal(error.retryable, false);
  validateApiOperationResult(compileApiOperation({ contract: agentSendOperationContract, handler: () => ({ status: 200 }) }), {
    status: 403, body: { ...error, operationId: "agent.send" }
  });
});
