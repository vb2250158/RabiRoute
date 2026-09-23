import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createAgentUploadRoutes, type AgentUploadDto, type AgentUploadRouteStore } from "./agentUploadRoutes.js";
import { setTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t: test.TestContext, options: { limit?: number; concurrency?: number; timeout?: number } = {}) {
  let authorized = true;
  let commits = 0;
  let entered!: () => void;
  let sawAuthorization = new Promise<void>(resolve => { entered = resolve; });
  let commitGate: Promise<void> | undefined;
  const rows = new Map<string, AgentUploadDto>();
  const stored: Buffer[] = [];
  const store: AgentUploadRouteStore = {
    limits: { maxFileBytes: options.limit ?? 16 },
    async uploadStream(input) {
      const chunks: Buffer[] = []; for await (const chunk of input.content) chunks.push(Buffer.from(chunk));
      const content = Buffer.concat(chunks);
      if (hash(content) !== input.sha256) throw Object.assign(new Error(), { code: "integrity" });
      await input.beforeCommit?.();
      if (commitGate) await commitGate;
      const key = JSON.stringify([input.owner, input.uploadId]);
      const prior = rows.get(key);
      if (prior && (prior.sha256 !== input.sha256 || prior.fileName !== input.fileName)) throw Object.assign(new Error(), { code: "conflict" });
      if (prior) return prior;
      commits++; stored.push(content);
      const dto = { id: input.uploadId, fileName: input.fileName, size: content.length, sha256: input.sha256, expiresAt: new Date(0).toISOString(), path: "must-not-leak" };
      rows.set(key, dto);
      return dto;
    },
    get(owner, id) { return rows.get(JSON.stringify([owner, id])); }
  };
  const routes = createAgentUploadRoutes({ store, maxConcurrentReaders: options.concurrency, readTimeoutMs: options.timeout ?? 1000, assertAuthorized() { entered(); if (!authorized) throw new Error("revoked"); } });
  const server = http.createServer((req, res) => {
    // Fixture-only authentication: no production identity is derived from headers.
    if (req.headers.authorization === "fixture-a" || req.headers.authorization === "fixture-b") setTrustedLanAgentSource(req, { nodeId: "test-node", agentId: String(req.headers.authorization), provider: "dsh", sessionId: "test-session", sessionName: "Test" });
    if (!routes.handler(req, new URL(req.url!, "http://localhost"), res)) { res.statusCode = 404; res.end(); }
  });
  server.requestTimeout = 2000;
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await routes.stopAcceptingAndDrain(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = address.port;
  function request(id: string, bytes: Buffer = Buffer.from([0, 255, 128, 1]), extra: http.OutgoingHttpHeaders = {}, method = "PUT") {
    const headers: http.OutgoingHttpHeaders = { authorization: "fixture-a", "content-type": "application/octet-stream", "idempotency-key": id, "x-rabiroute-file-name": encodeURIComponent("二进制.bin"), "x-rabiroute-content-sha256": hash(bytes), ...extra };
    let req!: http.ClientRequest;
    const result = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve, reject) => {
      req = http.request({ hostname: "127.0.0.1", port, path: `/api/agent/uploads/${id}`, method, headers }, res => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
    });
    return { req, result, bytes };
  }
  async function send(id = randomUUID(), bytes?: Buffer, extra?: http.OutgoingHttpHeaders, method?: string) { const pending = request(id, bytes, extra, method); pending.req.end(method === "GET" ? undefined : pending.bytes); return pending.result; }
  return { routes, request, send, stored, commits: () => commits, revoke: () => { authorized = false; }, sawAuthorization: () => sawAuthorization, resetSignal: () => { sawAuthorization = new Promise(resolve => { entered = resolve; }); }, gateCommit: (gate: Promise<void>) => { commitGate = gate; } };
}

test("HTTP binary roundtrip, owner isolation, idempotency and DTO allowlist", async t => {
  const f = await fixture(t); const id = randomUUID();
  const put = await f.send(id); assert.equal(put.status, 200); assert.equal(put.body.code, 0); assert.equal(put.headers["idempotency-key"], id);
  assert.equal(put.headers["access-control-allow-origin"], undefined); assert.equal(put.body.data.path, undefined);
  assert.deepEqual(f.stored[0], Buffer.from([0, 255, 128, 1]));
  assert.equal((await f.send(id)).status, 200); assert.equal(f.commits(), 1);
  assert.equal((await f.send(id, Buffer.from("other"))).status, 409);
  assert.deepEqual((await f.send(id, undefined, {}, "GET")).body, put.body);
  assert.equal((await f.send(id, undefined, { authorization: "fixture-b" }, "GET")).status, 404);
});

test("HTTP rejects forged identity, invalid headers, hash, filename and method", async t => {
  const f = await fixture(t);
  assert.equal((await f.send(randomUUID(), Buffer.from('{}'), { authorization: "", "x-rabiroute-agent-id": "fixture-a", "x-rabiroute-node-id": "test-node" })).status, 403);
  for (const [headers, status] of [
    [{ "idempotency-key": randomUUID() }, 400], [{ "content-type": "application/json" }, 415],
    [{ "x-rabiroute-content-sha256": "0".repeat(64) }, 422], [{ "x-rabiroute-file-name": "%2e%2e%2fx" }, 400],
    [{ "x-rabiroute-file-name": "%ZZ" }, 400], [{ "content-encoding": "gzip" }, 415]
  ] as Array<[http.OutgoingHttpHeaders, number]>) assert.equal((await f.send(randomUUID(), undefined, headers)).status, status);
  assert.equal((await f.send(randomUUID(), undefined, {}, "POST")).status, 405);
  assert.equal(f.commits(), 0);
});

test("upload errors preserve legacy code and expose non-replaying repair guidance", async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const invalid = await f.send(id, undefined, { "content-type": "application/json" });
  assert.equal(invalid.status, 415);
  assert.equal(invalid.body.code, "unsupported_media_type");
  assert.equal(invalid.body.errorCode, invalid.body.code);
  assert.match(invalid.body.repair, /application\/octet-stream/);
  assert.equal(invalid.body.retryable, false);
  assert.equal(invalid.body.help.method, "GET");
  assert.equal(new URL(invalid.body.help.path, "http://fixture.invalid").searchParams.get("path"), "/api/agent/uploads/:uploadId");
  assert.equal(f.commits(), 0);
  await f.routes.stopAcceptingAndDrain();
  const stopping = await f.send(id);
  assert.equal(stopping.status, 503);
  assert.equal(stopping.body.code, "upload_stopping");
  assert.equal(stopping.body.retryable, false);
  assert.match(stopping.body.repair, /不自动重传/);
});

test("HTTP bounded chunked body accepts exact limit, rejects extra byte and declared excess", async t => {
  const f = await fixture(t, { limit: 8 });
  assert.equal((await f.send(randomUUID(), Buffer.alloc(8))).status, 200);
  const over = f.request(randomUUID(), Buffer.alloc(9)); over.req.write(Buffer.alloc(8)); over.req.end(Buffer.alloc(1));
  assert.equal((await over.result).status, 413);
  assert.equal((await f.send(randomUUID(), Buffer.alloc(9), { "content-length": 9 })).status, 413);
  assert.equal(f.commits(), 1);
});

test("HTTP revocation while streaming prevents commit", async t => {
  const f = await fixture(t); const pending = f.request(randomUUID()); pending.req.write(pending.bytes.subarray(0, 1));
  await f.sawAuthorization(); f.revoke(); pending.req.end(pending.bytes.subarray(1));
  assert.equal((await pending.result).status, 403); assert.equal(f.commits(), 0);
});

test("HTTP global and per-owner concurrency are bounded and readers release after timeout", async t => {
  const f = await fixture(t, { concurrency: 1, timeout: 150 });
  const slow = f.request(randomUUID()); slow.req.write(slow.bytes.subarray(0, 1)); await f.sawAuthorization();
  assert.equal((await f.send()).status, 429);
  assert.equal((await f.send(randomUUID(), undefined, { authorization: "fixture-b" })).status, 429);
  const timeout = await slow.result;
  assert.equal(timeout.status, 408);
  assert.equal(timeout.body.code, "upload_timeout");
  assert.equal(timeout.body.errorCode, "upload_timeout");
  assert.equal(timeout.body.retryable, false);
  assert.match(timeout.body.repair, /读取超时.*GET 同一 uploadId.*不自动重传/);
  assert.equal(f.commits(), 0);
  assert.equal((await f.send()).status, 200);
});

test("HTTP disconnect never commits; drain waits for accepted store operation", async t => {
  const f = await fixture(t); const partial = f.request(randomUUID()); const disconnected = partial.result.catch(() => undefined);
  partial.req.write(partial.bytes.subarray(0, 1)); await f.sawAuthorization(); partial.req.destroy(); await disconnected;
  assert.equal(f.commits(), 0);
  let release!: () => void; f.gateCommit(new Promise(resolve => { release = resolve; })); f.resetSignal();
  const pending = f.request(randomUUID()); pending.req.end(pending.bytes); await f.sawAuthorization();
  let drained = false; const drain = f.routes.stopAcceptingAndDrain().then(() => { drained = true; });
  assert.equal(drained, false); assert.equal((await f.send()).status, 503);
  release(); assert.equal((await pending.result).status, 200); await drain; assert.equal(f.commits(), 1);
});

test("route configuration cannot exceed store's authoritative limit", () => {
  const store: AgentUploadRouteStore = { limits: { maxFileBytes: 8 }, async uploadStream() { throw new Error(); }, get() { return undefined; } };
  assert.throws(() => createAgentUploadRoutes({ store, assertAuthorized() {}, maxFileBytes: 9 }), /cannot exceed/);
});
