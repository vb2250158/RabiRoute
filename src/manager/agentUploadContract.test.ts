import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentUploadContract } from "./agentUploadContract.js";
import { listAgentApiOperations } from "./agentApiPolicy.js";
import { AgentUploadStore } from "./agentUploadStore.js";
import { createAgentUploadRoutes } from "./agentUploadRoutes.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

function assertFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertFrozen(child);
}

test("only upload GET/PUT publish immutable partial machine contracts, never a full verification claim", () => {
  const described = listAgentApiOperations().filter(item => item.help.machineReadable);
  assert.deepEqual(described.map(item => item.method).sort(), ["GET", "PUT"]);
  for (const item of described) {
    assert.equal(item.pathTemplate, "/api/agent/uploads/:uploadId");
    assert.equal(item.help.contractLevel, "baseline");
    assert.equal(item.help.coverage.exactRequestSchema, false);
    assert.equal(item.help.coverage.exactResponseSchema, false);
    assert.ok(item.help.coverage.missing.length > 0);
    const contract = item.help.machineReadable!;
    assertFrozen(contract);
    assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract);
    assert.deepEqual(Object.keys(contract.responses), ["200"]);
    assert.equal(contract.responses["200"].scope, "success-body-shape");
    assert.equal(contract.responses["200"].schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  }
  assert.equal(getAgentUploadContract("POST", "/api/agent/uploads/:uploadId"), undefined);
  assert.equal(getAgentUploadContract("GET", "/api/agent/send"), undefined);
});

test("request metadata separates wire locations and never models raw bytes as JSON", () => {
  const put = getAgentUploadContract("PUT", "/api/agent/uploads/:uploadId")!;
  assert.equal(put.request.body.kind, "binary");
  assert.equal("schema" in put.request.body, false);
  assert.deepEqual(put.request.query.allowed, []);
  const wire = JSON.parse(JSON.stringify(put));
  assert.equal(wire.request.body.mediaType, "application/octet-stream");
  assert.equal(wire.request.headers["idempotency-key"].equalsPathParameter, "uploadId");
  assert.equal(wire.request.headers["content-encoding"].forbidden, true);
  assert.equal(wire.request.headers["content-type"].parametersAllowed, false);
  assert.equal(wire.request.headers["x-rabiroute-file-name"].encoding, "encodeURIComponent");
  assert.equal(wire.request.headers["content-length"].required, false);
  for (const name of ["idempotency-key", "content-type", "x-rabiroute-content-sha256", "x-rabiroute-file-name"]) {
    assert.equal(wire.request.headers[name].required, true);
    assert.equal(wire.request.headers[name].singleValue, true);
  }
  const uuid = new RegExp(put.request.path.uploadId.schema.pattern);
  assert.ok(uuid.test("abcdef00-0000-4000-8000-000000000001"));
  for (const id of ["ABCDEF00-0000-4000-8000-000000000001", "00000000-0000-0000-0000-000000000000", "../file"]) assert.equal(uuid.test(id), false);
  const get = getAgentUploadContract("GET", "/api/agent/uploads/:uploadId")!;
  assert.deepEqual(get.request.body, { kind: "none", enforcement: "handler-does-not-read-body" });
  assert.deepEqual(get.request.headers, {});
});

test("real HTTP route and isolated store return exactly the documented success DTO for PUT and GET", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-contract-"));
  const store = new AgentUploadStore({ rootDir: root, maxFileBytes: 128 });
  const routes = createAgentUploadRoutes({ store, assertAuthorized() {} });
  const server = http.createServer((req, res) => {
    setTrustedLanAgentSource(req, { nodeId: "fixture-node", agentId: "fixture-agent", provider: "dsh", sessionId: "fixture-session", sessionName: "Fixture" });
    routes.handler(req, new URL(req.url!, "http://localhost"), res);
  });
  t.after(async () => {
    server.closeAllConnections();
    await routes.stopAcceptingAndDrain();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const id = randomUUID();
  const bytes = Buffer.from([0, 255, 128, 1]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = `http://127.0.0.1:${address.port}/api/agent/uploads/${id}`;
  const put = await fetch(url, { method: "PUT", headers: {
    "content-type": "application/octet-stream", "idempotency-key": id,
    "x-rabiroute-content-sha256": sha256.toUpperCase(), "x-rabiroute-file-name": encodeURIComponent("示例.bin")
  }, body: bytes });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  const get = await fetch(url); assert.equal(get.status, 200);
  const getBody = await get.json(); assert.deepEqual(getBody, putBody);
  for (const [method, body] of [["PUT", putBody], ["GET", getBody]] as const) {
    const schema = getAgentUploadContract(method, "/api/agent/uploads/:uploadId")!.responses["200"].schema;
    const value = body as { code: number; data: Record<string, unknown> };
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort());
    assert.equal(value.code, schema.properties.code.const);
    const dto = schema.properties.data;
    assert.equal(dto.additionalProperties, false);
    assert.deepEqual(Object.keys(value.data).sort(), [...dto.required].sort());
    assert.deepEqual(Object.keys(dto.properties).sort(), [...dto.required].sort());
    assert.match(String(value.data.id), new RegExp(dto.properties.id.pattern));
    assert.match(String(value.data.sha256), new RegExp(dto.properties.sha256.pattern));
    assert.equal(typeof value.data.fileName, dto.properties.fileName.type);
    assert.equal(Number.isInteger(value.data.size), true);
    assert.ok(Number(value.data.size) >= dto.properties.size.minimum);
    assert.equal(typeof value.data.expiresAt, dto.properties.expiresAt.type);
    assert.ok(Number.isFinite(Date.parse(String(value.data.expiresAt))));
    assert.deepEqual({ ...value.data, expiresAt: undefined }, { id, fileName: "示例.bin", size: 4, sha256, expiresAt: undefined });
  }
});
