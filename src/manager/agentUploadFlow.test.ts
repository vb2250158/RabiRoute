import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleAgentSend, type AgentSendRequest } from "../agentSend.js";
import type { AgentReplyOptions } from "../outbox.js";
import { executeIdempotentAgentSend } from "./agentSendIdempotency.js";
import { createAgentUploadRoutes } from "./agentUploadRoutes.js";
import { AgentUploadStore, type AgentUploadDto } from "./agentUploadStore.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource, type TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

// The transport is an actual ESM client outside tsconfig.rootDir, with no TS declarations.
const clientModuleUrl = new URL("../../apps/rabi-agent/lib/manager-client.mjs", import.meta.url).href;
type ClientReceipt = { statusCode: number; ok: boolean; body: string; uncertain: boolean; headers: Record<string, string> };
type ManagerClient = {
  upload(filePath: string, uploadId: string): Promise<ClientReceipt>;
  invoke(method: string, target: string): Promise<ClientReceipt>;
};

async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fixture(t: test.TestContext, captionFails = false, hashSink = false) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-upload-flow-"));
  const servers: http.Server[] = [];
  let uploads: ReturnType<typeof createAgentUploadRoutes> | undefined;
  t.after(async () => {
    try {
      await uploads?.stopAcceptingAndDrain();
      await Promise.all(servers.map(close));
    } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
  });
  const authority = new LanAgentAuthority({ statePath: path.join(rootDir, "authority.json") });
  const nodeId = "fixture-node";
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, nodeId);
  for (const agentId of ["fixture-a", "fixture-b"]) {
    authority.approveAndEnableAgent(nodeId, { agentId, provider: "dsh", sessionId: `${agentId}-session` }, authority.getSnapshot().revision);
  }
  const storeRoot = path.join(rootDir, "uploads");
  let now = Date.now();
  const store = new AgentUploadStore({ rootDir: storeRoot, ttlMs: 60_000, now: () => now });
  const assertAuthorized = (source: TrustedLanAgentSource) => {
    const binding = authority.getApprovedAgentBinding(source.nodeId, source.agentId);
    if (!authority.isAgentEnabled(source.nodeId, source.agentId) || binding?.sessionId !== source.sessionId || binding.provider !== source.provider) {
      throw new Error("Fixture Agent authority revoked or rebound.");
    }
  };
  uploads = createAgentUploadRoutes({ store, assertAuthorized });
  const sources = new Map<string, TrustedLanAgentSource>();
  const uploadRequests: string[] = [];
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const manager = http.createServer((request, response) => {
    const access = evaluateLanAgentRequest(request, authority, true);
    if (access.kind !== "agent") {
      json(response, access.kind === "denied" ? access.status : 401, { code: "forbidden" });
      return;
    }
    const binding = authority.getApprovedAgentBinding(access.nodeId, access.agentId);
    if (!binding?.sessionId || binding.provider !== "dsh") { json(response, 403, { code: "forbidden" }); return; }
    setTrustedLanAgentSource(request, { ...access, provider: binding.provider, sessionId: binding.sessionId, sessionName: "Fixture" });
    sources.set(access.agentId, getTrustedLanAgentSource(request)!);
    if (request.url === "/meta") {
      json(response, 200, { health: { state: "healthy", requiredReady: true }, applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" });
      return;
    }
    uploadRequests.push(`${request.method} ${request.url}`);
    if (!uploads!.handler(request, new URL(request.url!, "http://fixture.invalid"), response)) json(response, 404, {});
  });
  servers.push(manager);
  const managerUrl = await listen(manager);
  const { createManagerClient } = await import(clientModuleUrl);
  const client = (agentId = "fixture-a"): ManagerClient => createManagerClient({ managerUrl, credential: credential.token, agentId });
  const calls: Array<{ action: string; body: Record<string, unknown>; bytes?: Buffer; size?: number; sha256?: string; largestChunk?: number }> = [];
  const napcat = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const action = request.url!;
        if (action === "/upload_group_file" && hashSink) {
          const digest = createHash("sha256");
          let size = 0;
          let largestChunk = 0;
          for await (const chunk of fs.createReadStream(String(body.file), { highWaterMark: 64 * 1024 })) {
            assert.ok(Buffer.isBuffer(chunk));
            digest.update(chunk);
            size += chunk.length;
            largestChunk = Math.max(largestChunk, chunk.length);
          }
          calls.push({ action, body, size, sha256: digest.digest("hex"), largestChunk });
        } else {
          calls.push({ action, body, ...(action === "/upload_group_file" ? { bytes: fs.readFileSync(String(body.file)) } : {}) });
        }
        json(response, 200, action === "/upload_group_file"
          ? { status: "ok", retcode: 0, data: { file_id: "fixture-platform-file" } }
          : captionFails ? { status: "failed", retcode: 1, wording: "fixture caption rejected" }
            : { status: "ok", retcode: 0, data: { message_id: 123 } });
      } catch { json(response, 500, { status: "failed", retcode: 1 }); }
    });
  });
  servers.push(napcat);
  const napcatUrl = await listen(napcat);
  let leases = 0;
  const options = (source: TrustedLanAgentSource): AgentReplyOptions => ({
    rootDir, routeRoot: path.join(rootDir, "data", "route"), rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [{ id: "fixture-route", enabled: true,
      napcatInstances: [{ id: "fixture-napcat", enabled: true, httpUrl: napcatUrl, accessToken: "" }],
      messageAdapterPolicies: { napcat: { outputEnabled: true, supportedOutputs: ["file"], allowedFileRoots: [] } }
    }],
    withManagedGroupFile: (fileId, expectedSha256, send) => {
      assertAuthorized(source);
      return store.withFile({ nodeId: source.nodeId, agentId: source.agentId }, fileId, file => {
        assertAuthorized(source);
        if (file.sha256 !== expectedSha256) throw new Error("Managed upload content no longer matches its receipt.");
        leases++;
        return send(file);
      });
    }
  });
  const send = async (request: AgentSendRequest, agentId = "fixture-a") => {
    const source = sources.get(agentId);
    assert.ok(source, "A real authenticated HTTP request must establish the approved source first.");
    assertAuthorized(source);
    return executeIdempotentAgentSend(request, {
      rootDir, deliver: () => handleAgentSend(request, options(source))
    });
  };
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
  const localFile = path.join(rootDir, "报告-fixture.bin");
  fs.writeFileSync(localFile, bytes);
  const request = (dto: AgentUploadDto, agentId = "fixture-a"): AgentSendRequest => ({
    deliveryId: randomUUID(), sender: { agentType: "primary_persona", sessionId: `${agentId}-session` },
    routeId: "fixture-route", channel: "napcat",
    params: { target: "group", groupId: "456", instanceId: "fixture-napcat", replyToMessageId: "" },
    payload: { type: "file", fileId: dto.id, fileSha256: dto.sha256, text: "Fixture caption" }
  });
  return { authority, nodeId, store, storeRoot, client, calls, uploadRequests, localFile, bytes, request, send,
    expire: () => { now += 60_001; }, leases: () => leases };
}

test("real client upload and GET feed store-owned bytes and DTO filename to the group sink", async t => {
  const f = await fixture(t);
  const uploadId = randomUUID();
  const put = await f.client().upload(f.localFile, uploadId);
  assert.equal(put.statusCode, 200);
  assert.equal(put.ok, true);
  assert.equal(put.uncertain, false);
  assert.equal(put.headers["idempotency-key"], uploadId);
  const dto: AgentUploadDto = JSON.parse(put.body).data;
  assert.deepEqual(Object.keys(dto).sort(), ["expiresAt", "fileName", "id", "sha256", "size"]);
  assert.equal(dto.id, uploadId);
  assert.equal(dto.fileName, path.basename(f.localFile));
  assert.equal(dto.size, f.bytes.length);
  assert.equal(dto.sha256, createHash("sha256").update(f.bytes).digest("hex"));
  const get = await f.client().invoke("GET", `/api/agent/uploads/${dto.id}`);
  assert.equal(get.statusCode, 200);
  assert.deepEqual(JSON.parse(get.body).data, dto);
  assert.equal(f.calls.length, 0, "Upload and GET must not send anything.");
  fs.unlinkSync(f.localFile); // The remote source file is no longer available to the sink.
  const sent = await f.send(f.request(dto));
  assert.equal(sent.body.status, "sent");
  assert.equal(sent.body.sentFileName, dto.fileName);
  assert.equal(sent.body.sentFileId, "fixture-platform-file");
  assert.deepEqual(f.calls.map(call => call.action), ["/upload_group_file", "/send_group_msg"]);
  assert.equal(f.calls[0].body.file, f.store.resolve({ nodeId: f.nodeId, agentId: "fixture-a" }, dto.id).path);
  assert.equal(f.calls[0].body.name, dto.fileName);
  assert.notEqual(path.basename(String(f.calls[0].body.file)), dto.fileName);
  assert.deepEqual(f.calls[0].bytes, f.bytes);
  assert.equal(f.leases(), 1);
  assert.ok(!JSON.stringify(sent).includes(f.storeRoot));
});

test("caption failure stays sent and stable delivery replay never uploads the file again", async t => {
  const f = await fixture(t, true);
  const put = await f.client().upload(f.localFile, randomUUID());
  assert.equal(put.ok, true);
  const dto: AgentUploadDto = JSON.parse(put.body).data;
  const request = f.request(dto);
  const first = await f.send(request);
  assert.equal(first.body.status, "sent");
  assert.match(first.body.reason!, /follow-up text failed/);
  assert.equal(first.body.idempotency.duplicate, false);
  const replay = await f.send(request);
  assert.equal(replay.body.status, "sent");
  assert.equal(replay.body.idempotency.duplicate, true);
  assert.equal(replay.body.sentFileId, first.body.sentFileId);
  assert.deepEqual(f.calls.map(call => call.action), ["/upload_group_file", "/send_group_msg"]);
  assert.equal(f.leases(), 1);
  assert.equal(f.uploadRequests.filter(value => value.startsWith("PUT ")).length, 1);
});

test("a different approved Agent cannot GET or send another Agent's fileId", async t => {
  const f = await fixture(t);
  const put = await f.client().upload(f.localFile, randomUUID());
  assert.equal(put.ok, true);
  const dto: AgentUploadDto = JSON.parse(put.body).data;
  const deniedGet = await f.client("fixture-b").invoke("GET", `/api/agent/uploads/${dto.id}`);
  assert.equal(deniedGet.statusCode, 404);
  const deniedSend = await f.send(f.request(dto, "fixture-b"), "fixture-b");
  assert.equal(deniedSend.body.status, "failed");
  assert.equal(deniedSend.body.reason, "Managed group file delivery failed.");
  assert.equal(f.leases(), 0);
  assert.equal(f.calls.length, 0);
});

test("expired UUID reuse cannot send replacement bytes through an old content receipt", async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const original = await f.client().upload(f.localFile, id);
  assert.equal(original.ok, true);
  const oldDto: AgentUploadDto = JSON.parse(original.body).data;
  const staleRequest = f.request(oldDto);
  f.expire();
  const replacementBytes = Buffer.from("different fixture content");
  fs.writeFileSync(f.localFile, replacementBytes);
  const replacement = await f.client().upload(f.localFile, id);
  assert.equal(replacement.ok, true, JSON.stringify(replacement));
  const newDto: AgentUploadDto = JSON.parse(replacement.body).data;
  assert.equal(newDto.id, oldDto.id);
  assert.notEqual(newDto.sha256, oldDto.sha256);
  const denied = await f.send(staleRequest);
  assert.equal(denied.body.status, "failed");
  assert.equal(f.calls.length, 0);
  assert.equal(f.leases(), 0);
  const freshRequest = f.request(newDto);
  freshRequest.payload = { type: "file", fileId: newDto.id, fileSha256: newDto.sha256 };
  assert.equal((await f.send(freshRequest)).body.status, "sent");
  assert.deepEqual(f.calls.map(call => call.action), ["/upload_group_file"]);
  assert.deepEqual(f.calls[0].bytes, replacementBytes);
});

test("734 MiB file streams through real client, managed storage and the group-file sink", {
  skip: process.env.RABI_TEST_LARGE_UPLOAD !== "1",
  timeout: 10 * 60_000
}, async t => {
  const f = await fixture(t, false, true);
  const size = 734 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 0xa7);
  const digest = createHash("sha256");
  const file = await fs.promises.open(f.localFile, "w");
  try {
    for (let written = 0; written < size; written += chunk.length) {
      let offset = 0;
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset);
        assert.ok(result.bytesWritten > 0);
        offset += result.bytesWritten;
      }
      digest.update(chunk);
    }
  } finally { await file.close(); }
  const expectedHash = digest.digest("hex");
  // Catch whole-file Buffer allocations/concatenation without relying on noisy RSS limits.
  // This opt-in case runs sequentially; mocks are restored even if any assertion fails.
  const allocationLimit = 8 * 1024 * 1024;
  const alloc = Buffer.alloc;
  const allocUnsafe = Buffer.allocUnsafe;
  const allocUnsafeSlow = Buffer.allocUnsafeSlow;
  const concat = Buffer.concat;
  t.mock.method(Buffer, "alloc", (length: number, ...args: Parameters<typeof Buffer.alloc> extends [number, ...infer R] ? R : never) => {
    assert.ok(length <= allocationLimit, `Unbounded Buffer.alloc(${length})`);
    return alloc(length, ...args);
  });
  t.mock.method(Buffer, "allocUnsafe", (length: number) => { assert.ok(length <= allocationLimit); return allocUnsafe(length); });
  t.mock.method(Buffer, "allocUnsafeSlow", (length: number) => { assert.ok(length <= allocationLimit); return allocUnsafeSlow(length); });
  t.mock.method(Buffer, "concat", (list: readonly Uint8Array[], length?: number) => {
    assert.ok((length ?? list.reduce((n, value) => n + value.byteLength, 0)) <= allocationLimit, "Whole-file Buffer.concat");
    return concat(list, length);
  });
  const put = await f.client().upload(f.localFile, randomUUID());
  assert.equal(put.ok, true, put.body);
  assert.equal(put.uncertain, false);
  const dto: AgentUploadDto = JSON.parse(put.body).data;
  assert.equal(dto.size, size);
  assert.equal(dto.sha256, expectedHash);
  assert.equal(f.calls.length, 0);
  fs.unlinkSync(f.localFile);
  const request = f.request(dto);
  request.payload = { type: "file", fileId: dto.id, fileSha256: dto.sha256 };
  const sent = await f.send(request);
  assert.equal(sent.body.status, "sent");
  assert.equal((await f.send(request)).body.idempotency.duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].size, size);
  assert.equal(f.calls[0].sha256, expectedHash);
  assert.equal(f.calls[0].body.name, dto.fileName);
  assert.ok(f.calls[0].largestChunk! <= chunk.length);
  assert.equal(f.calls[0].bytes, undefined);
  assert.equal(f.leases(), 1);
  t.diagnostic(`Streamed ${size} bytes; SHA-256 ${expectedHash}; sink chunks <= ${chunk.length} bytes.`);
});

test("disabled Agent and revoked node reject upload and deny a previously approved send source", async t => {
  const f = await fixture(t);
  const uploaded = await f.client().upload(f.localFile, randomUUID());
  assert.equal(uploaded.ok, true);
  const dto: AgentUploadDto = JSON.parse(uploaded.body).data;
  f.authority.setAgentEnabled(f.nodeId, "fixture-a", false);
  const disabledId = randomUUID();
  const disabled = await f.client().upload(f.localFile, disabledId);
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.ok, false);
  assert.throws(() => f.store.get({ nodeId: f.nodeId, agentId: "fixture-a" }, disabledId), /not_found/);
  await assert.rejects(() => f.send(f.request(dto)), /revoked/);
  f.authority.setAgentEnabled(f.nodeId, "fixture-a", true);
  f.authority.revokeNode(f.nodeId);
  const revokedId = randomUUID();
  const revoked = await f.client().upload(f.localFile, revokedId);
  assert.equal(revoked.statusCode, 403);
  assert.equal(revoked.ok, false);
  assert.throws(() => f.store.get({ nodeId: f.nodeId, agentId: "fixture-a" }, revokedId), /not_found/);
  await assert.rejects(() => f.send(f.request(dto)), /revoked/);
  assert.equal(f.calls.length, 0);
});
