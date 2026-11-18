import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { compileApiContract, validateApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { createSourceFileHashOperation } from "./napcatApiSourceFileHash.js";
import { createQqMessageOperations } from "./qqMessageRoutes.js";
import { createSourceFileOperations } from "./napcatApiSourceFileOperations.js";
import { boundedBytes, qqRead, readQqMedia } from "./qqMessageMedia.js";

const source = { routeId: "example", instanceId: "selected", group: { groupId: "789", fileId: "0123456789abcdef0123456789abcdef" } };
const emptyHash = createHash("sha256").digest("hex");
const block = new Uint8Array(65536).fill(37);
function expectedHash(size: number) {
  const hash = createHash("sha256");
  for (let remaining = size; remaining > 0; remaining -= block.length) hash.update(block.subarray(0, Math.min(remaining, block.length)));
  return hash.digest("hex");
}
function input(body: unknown, signal?: AbortSignal): ApiOperationInput {
  return { request: { headers: {}, method: "POST" } as IncomingMessage, response: {}, body,
    url: new URL("http://127.0.0.1/api/agent/qq/files/sha256"), query: {}, path: {}, signal } as ApiOperationInput;
}
function fixture(size = 120000) {
  const route = { id: "example", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
    { id: "selected", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "example-secret", botUserId: "12345" }
  ] } as GatewayDefinition;
  const state = { actualQQ: 12345, status: 200, declaredSize: undefined as number | undefined, cancelled: false,
    hang: false, revoked: false, revokeAfterEof: false, bindingAfterEof: false, switchAfterEof: false, metadataFailure: false, largestChunk: 0, bytes: 0, kind: "group" as "group" | "private" };
  const calls: string[] = [];
  let started!: () => void;
  const streamStarted = new Promise<void>(resolve => { started = resolve; });
  const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
  const context = { local: () => !state.revoked, route: () => route, json: () => {}, transport: async (value: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(value));
    if (url.hostname === "resource.example.invalid") {
      calls.push("bytes");
      let remaining = size;
      const body = new ReadableStream<Uint8Array>({
        start() { started(); },
        pull(controller) {
          if (state.hang) return new Promise<void>(() => {});
          if (!remaining) {
            if (state.switchAfterEof) state.actualQQ = 99999;
            if (state.revokeAfterEof) state.revoked = true;
            if (state.bindingAfterEof) route.napcatInstances![0]!.httpUrl = "http://127.0.0.1:54321";
            controller.close(); return;
          }
          const chunk = block.subarray(0, Math.min(remaining, block.length));
          remaining -= chunk.length; state.bytes += chunk.length; state.largestChunk = Math.max(state.largestChunk, chunk.length);
          controller.enqueue(chunk);
        },
        cancel() { state.cancelled = true; }
      }, { highWaterMark: 0 });
      return new Response(body, { status: state.status, headers: state.declaredSize === undefined ? {} : { "content-length": String(state.declaredSize) } });
    }
    const action = url.pathname.slice(1); calls.push(action);
    if (action === "get_login_info") return envelope({ user_id: state.actualQQ });
    if (action === "get_msg") return envelope({ post_type: "message", message_type: state.kind, message_id: 12, self_id: 12345,
      user_id: 456, ...(state.kind === "group" ? { group_id: 789 } : {}),
      message: [{ type: "file", data: { file: "example.apk", file_id: "/native-uuid-from-original-converter", file_size: String(size) } }] });
    if (action === "get_group_file_url" || action === "get_private_file_url") {
      if (state.metadataFailure) return Response.json({ status: "failed", retcode: 1200, message: "example-secret-native-error" });
      const payload = JSON.parse(String(init?.body));
      assert.ok(payload.file_id === source.group.fileId || payload.file_id === "/native-uuid-from-original-converter");
      return envelope({ url: "https://resource.example.invalid/file?token=example-sensitive-url" });
    }
    throw Error(`Unexpected action ${action}`);
  } };
  return { state, route, context, calls, streamStarted };
}

test("complete788751129-byte hash uses bounded chunks even when materialized-media quota is1byte", async () => {
  const old = process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES;
  process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES = "1";
  try {
    const size = 788751129, f = fixture(size), operation = createSourceFileHashOperation(f.context);
    const before = process.memoryUsage().arrayBuffers;
    const result = await operation.handler(input({ ...source, expectedSize: size, expectedSha256: expectedHash(size) }));
    assert.equal(result.status, 200);
    const body = result.body as { sha256Matches: boolean; actualSize: number; receiptUpdated: boolean };
    assert.equal(body.sha256Matches, true); assert.equal(body.actualSize, size); assert.equal(body.receiptUpdated, false);
    assert.equal(f.state.bytes, size); assert.equal(f.state.largestChunk, 65536);
    assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024);
    assert.equal(f.calls.filter(action => action === "get_login_info").length, 2);
    assert.equal(f.calls.includes("get_file"), false);
    assert.equal(JSON.stringify(result).includes("example-sensitive-url"), false);
    validateApiOperationResult(compileApiContract({ contract: operation.contract }), result);
  } finally { if (old === undefined) delete process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES; else process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES = old; }
});

test("empty stream and digest mismatch return complete independent verification results", async () => {
  const f = fixture(0), operation = createSourceFileHashOperation(f.context);
  const result = await operation.handler(input({ ...source, expectedSize: 0, expectedSha256: emptyHash }));
  assert.equal(result.status, 200); assert.equal((result.body as { sha256: string }).sha256, emptyHash);
  const mismatch = fixture(5);
  const compared = await createSourceFileHashOperation(mismatch.context).handler(input({ ...source, expectedSize: 5, expectedSha256: emptyHash }));
  assert.equal(compared.status, 200); assert.equal((compared.body as { sha256Matches: boolean }).sha256Matches, false);
});

test("short, oversize and false length streams never expose a completed digest", async () => {
  for (const [actual, expected, declared] of [[2, 3, undefined], [4, 3, undefined], [3, 3, 4]]) {
    const f = fixture(actual); f.state.declaredSize = declared;
    const result = await createSourceFileHashOperation(f.context).handler(input({ ...source, expectedSize: expected, expectedSha256: emptyHash }));
    assert.ok(result.status === 409 || result.status === 413);
    assert.equal(JSON.stringify(result.body).includes("sha256"), false);
    if (declared) assert.equal(f.state.bytes, 0);
  }
});

test("HTTP errors, expired cache and account changes are safe failures", async () => {
  for (const mode of ["403", "404", "cache", "account"] as const) {
    const f = fixture(9);
    if (mode === "403" || mode === "404") f.state.status = Number(mode);
    if (mode === "cache") f.state.metadataFailure = true;
    if (mode === "account") f.state.switchAfterEof = true;
    const result = await createSourceFileHashOperation(f.context).handler(input({ ...source, expectedSize: 9, expectedSha256: emptyHash }));
    assert.ok(result.status >= 400); assert.equal(JSON.stringify(result).includes("example-secret"), false);
    assert.equal(JSON.stringify(result.body).includes("sha256"), false);
    assert.equal(f.calls.includes("get_group_root_files"), false);
    if (mode === "403" || mode === "404") assert.equal(f.state.cancelled, true);
  }
});

test("permission revocation or endpoint rebinding at EOF discloses no complete hash", async () => {
  for (const mode of ["revoke", "binding"] as const) {
    const f = fixture(7);
    if (mode === "revoke") f.state.revokeAfterEof = true; else f.state.bindingAfterEof = true;
    const result = await createSourceFileHashOperation(f.context).handler(input({ ...source, expectedSize: 7, expectedSha256: emptyHash }));
    assert.equal(result.status, mode === "revoke" ? 403 : 409);
    assert.equal(JSON.stringify(result.body).includes("sha256"), false);
  }
});

test("caller cancel and configured media deadline terminate a pending stream", async () => {
  for (const mode of ["caller", "timeout"] as const) {
    const old = process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS;
    if (mode === "timeout") process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS = "20";
    try {
      const f = fixture(9); f.state.hang = true;
      const controller = new AbortController();
      const pending = createSourceFileHashOperation(f.context).handler(input({ ...source, expectedSize: 9, expectedSha256: emptyHash }, controller.signal));
      await f.streamStarted; if (mode === "caller") controller.abort();
      const result = await pending;
      assert.equal(result.status, 503); assert.equal(f.state.cancelled, true);
      assert.equal((result.body as { errorCode: string }).errorCode, mode === "caller" ? "QQ_READ_CANCELLED" : "QQ_READ_TIMEOUT");
    } finally { if (old === undefined) delete process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS; else process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS = old; }
  }
});

test("hash operation rejects missing bounds and caller URL/path before any native call", async () => {
  const f = fixture(), operation = createSourceFileHashOperation(f.context);
  for (const body of [source, { ...source, expectedSize: -1, expectedSha256: emptyHash },
    { ...source, expectedSize: Number.MAX_SAFE_INTEGER + 1, expectedSha256: emptyHash },
    { ...source, expectedSize: 1, expectedSha256: emptyHash, timeoutMs: 0 },
    { ...source, expectedSize: 1, expectedSha256: emptyHash, timeoutMs: 2_147_483_648 },
    { ...source, expectedSize: 1, expectedSha256: emptyHash, url: "https://example.invalid" },
    { ...source, expectedSize: 1, expectedSha256: emptyHash, path: "C:/example.bin" }]) {
    assert.equal((await operation.handler(input(body))).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("explicit finite timeoutMs overrides a shorter default without changing global configuration", async () => {
  const old = process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS;
  process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS = "1";
  try {
    const f = fixture(7), transport = f.context.transport;
    f.context.transport = async (value, init) => {
      if (new URL(String(value)).hostname === "resource.example.invalid") await new Promise(resolve => setTimeout(resolve, 20));
      return transport(value, init);
    };
    const operation = createSourceFileHashOperation(f.context);
    assert.equal(operation.contract.request.deadlineMs, undefined);
    const result = await operation.handler(input({ ...source, expectedSize: 7, expectedSha256: expectedHash(7), timeoutMs: 1000 }));
    assert.equal(result.status, 200);
    assert.equal(process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS, "1");
  } finally { if (old === undefined) delete process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS; else process.env.RABIROUTE_QQ_MEDIA_TIMEOUT_MS = old; }
});

test("legacy exact group/private file attachments use the same original cached source capability", async () => {
  for (const kind of ["group", "private"] as const) for (const configured of [true, false]) {
    const f = fixture(30); f.state.kind = kind;
    if (!configured) delete f.route.napcatInstances![0]!.botUserId;
    const operation = createQqMessageOperations(f.context).find(row => row.contract.operationId === "agent.qq.attachment.read")!;
    assert.ok(operation);
    const response = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
    const result = await operation.handler({ ...input(undefined), request: { headers: {}, method: "GET" } as IncomingMessage,
      response, url: new URL(`http://127.0.0.1/api/agent/qq/messages/12/attachments/0?routeId=example&kind=${kind}&target=${kind === "group" ? "789" : "456"}`), path: { messageId: "12", attachmentIndex: "0" } });
    assert.equal(result.status, 200); assert.equal((result.body as Buffer).length, 30);
    assert.equal(f.calls.includes("get_file"), false);
    assert.equal(f.calls.filter(action => action === "get_login_info").length, 2);
    assert.equal(f.calls.filter(action => action === "get_msg").length, 2);
  }
});

test("legacy exact files refuse account switches after EOF", async () => {
  const f = fixture(30); f.state.switchAfterEof = true;
  const operation = createQqMessageOperations(f.context).find(row => row.contract.operationId === "agent.qq.attachment.read")!;
  const response = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
  const result = await operation.handler({ ...input(undefined), request: { headers: {}, method: "GET" } as IncomingMessage,
    response, url: new URL("http://127.0.0.1/api/agent/qq/messages/12/attachments/0?routeId=example&kind=group&target=789"), path: { messageId: "12", attachmentIndex: "0" } });
  assert.equal(result.status, 409); assert.equal((result.body as { errorCode: string }).errorCode, "QQ_READ_ACCOUNT_MISMATCH");
  assert.equal(result.body instanceof Buffer, false);
});

test("HTTP206 matching fragment size/hash is rejected by the complete SHA owner", async () => {
  const size = 37, f = fixture(size); f.state.status = 206; f.state.declaredSize = size;
  const result = await createSourceFileHashOperation(f.context).handler(input({ ...source, expectedSize: size, expectedSha256: expectedHash(size) }));
  assert.equal(result.status, 503);
  assert.equal((result.body as { errorCode: string }).errorCode, "QQ_MEDIA_INCOMPLETE_RESPONSE");
  assert.equal(JSON.stringify(result.body).includes("sha256"), false);
  assert.equal(f.state.bytes, 0); assert.equal(f.state.cancelled, true);
});

test("both complete binary views reject HTTP206 without reading the matching-length fragment", async () => {
  for (const [index, kind] of (["private", "group"] as const).entries()) {
    const f = fixture(37); f.state.status = 206; f.state.declaredSize = 37; f.state.kind = kind;
    const body = kind === "group" ? source : { routeId: "example", instanceId: "selected",
      source: { kind: "private", targetId: "456", messageId: "12", attachmentIndex: 0 } };
    const result = await createSourceFileOperations(f.context)[index]!.handler(input(body));
    assert.equal(result.status, 503); assert.equal((result.body as { errorCode: string }).errorCode, "QQ_MEDIA_INCOMPLETE_RESPONSE");
    assert.equal(f.state.bytes, 0); assert.equal(f.state.cancelled, true);
  }
});

test("legacy exact-source group/private file views also reject HTTP206", async () => {
  for (const kind of ["group", "private"] as const) {
    const f = fixture(37); f.state.kind = kind; f.state.status = 206; f.state.declaredSize = 37;
    const operation = createQqMessageOperations(f.context).find(row => row.contract.operationId === "agent.qq.attachment.read")!;
    const response = Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ServerResponse;
    const result = await operation.handler({ ...input(undefined), request: { headers: {}, method: "GET" } as IncomingMessage,
      response, url: new URL(`http://127.0.0.1/api/agent/qq/messages/12/attachments/0?routeId=example&kind=${kind}&target=${kind === "group" ? "789" : "456"}`),
      path: { messageId: "12", attachmentIndex: "0" } });
    assert.equal(result.status, 503); assert.equal((result.body as { errorCode: string }).errorCode, "QQ_MEDIA_INCOMPLETE_RESPONSE");
    assert.equal(f.state.bytes, 0); assert.equal(f.state.cancelled, true);
  }
});

test("generic JSON and unchanged legacy image paths preserve successful2xx semantics", async () => {
  const json = await boundedBytes(Response.json({ ok: true }, { status: 206 }), 100);
  assert.deepEqual(JSON.parse(json.toString()), { ok: true });
  const endpoint = { httpUrl: "http://127.0.0.1:12345", accessToken: "example-secret" };
  const identity = await qqRead(endpoint, "get_login_info", {}, AbortSignal.timeout(1000), async () =>
    Response.json({ status: "ok", retcode: 0, data: { user_id: 12345 } }, { status: 206 }));
  assert.equal(identity.user_id, 12345);
  const image = await readQqMedia(endpoint, { kind: "image", name: "image.bin", url: "https://resource.example.invalid/image" },
    AbortSignal.timeout(1000), async () => new Response(block.subarray(0, 5), { status: 206 }));
  assert.deepEqual(image, Buffer.from(block.subarray(0, 5)));
});
