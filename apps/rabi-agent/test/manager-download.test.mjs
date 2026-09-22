import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import http from "node:http";
import { createManagerClient, MAX_SKILL_DOWNLOAD_BYTES, isSkillDownloadTarget, SkillDownloadError } from "../lib/manager-client.mjs";
import { runManagerCommand } from "../lib/manager-cli.mjs";

const target = "/api/roles/example/skills/sample/download";
const meta = { health: { live: true, requiredReady: true, state: "healthy" }, applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" };
const settings = { managerUrl: "http://manager.invalid", credential: "fixture-download-only", agentId: "worker" };
// Synthetic bytes only: includes invalid UTF-8 and NUL so text roundtripping cannot pass.
const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))]);
const digest = createHash("sha256").update(bytes).digest("hex");
const headers = { "content-type": "application/zip", "content-length": String(bytes.length), "x-rabiroute-content-sha256": digest };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".download-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "chosen.zip");
  const config = path.join(directory, "config.json");
  await fs.writeFile(config, JSON.stringify({ managerUrl: settings.managerUrl, nodeCredential: settings.credential, agents: [{ agentId: settings.agentId }] }));
  return { directory, output, config };
}
function mock(response = () => new Response(bytes, { headers }), after = meta) {
  const calls = [];
  let metadataCalls = 0;
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (new URL(url).pathname === "/meta") return Response.json(++metadataCalls === 1 ? meta : after);
    return response();
  } };
}
async function noPartial(f, expected = ["config.json"]) { assert.deepEqual((await fs.readdir(f.directory)).sort(), expected.sort()); }

test("download HTTP errors expose only fixed code, status and commitment diagnostics", async t => {
  const f = await fixture(t);
  for (const status of [401, 403, 404, 409, 413, 503]) {
    const transport = mock(() => Response.json({ detail: settings.credential }, { status }));
    await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), error => {
      assert.ok(error instanceof SkillDownloadError);
      assert.equal(error.code, `HTTP_${status}`);
      assert.equal(error.statusCode, status);
      assert.equal(error.committed, false);
      assert.match(error.message, new RegExp(`HTTP_${status}.*HTTP ${status}`));
      assert.equal(error.message.includes(settings.credential), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    await noPartial(f);
  }
});

test("download existing target, hash mismatch and transport have distinct safe codes", async t => {
  const f = await fixture(t);
  const check = code => error => error instanceof SkillDownloadError && error.code === code && error.committed === false && !error.message.includes(settings.credential);
  await fs.writeFile(f.output, "keep");
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: mock().fetchImpl }).download(target, f.output), check("OUTPUT_EXISTS"));
  await fs.unlink(f.output);
  const transport = mock(() => new Response(bytes, { headers: { ...headers, "x-rabiroute-content-sha256": "0".repeat(64) } }));
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), check("HASH_MISMATCH"));
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: async () => { throw new Error(settings.credential); } }).download(target, f.output), check("TRANSPORT"));
  await noPartial(f);
});

test("unsupported hardlink fails closed without copy or rename fallback", async t => {
  const f = await fixture(t);
  const linkMock = t.mock.method(fs, "link", async () => { throw Object.assign(new Error(settings.credential), { code: "ENOTSUP" }); });
  const transport = mock();
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), error => error.code === "LINK_UNSUPPORTED" && error.statusCode === 200 && error.committed === false && !error.message.includes(settings.credential));
  assert.equal(linkMock.mock.callCount(), 1);
  await noPartial(f);
});

test("unlink failure after commit reports complete destination and forbids automatic redownload", async t => {
  const f = await fixture(t);
  const realUnlink = fs.unlink;
  let calls = 0;
  t.mock.method(fs, "unlink", async file => { if (++calls === 1) throw new Error(settings.credential); return realUnlink(file); });
  const transport = mock();
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), error => {
    assert.equal(error.code, "CLEANUP_FAILED");
    assert.equal(error.statusCode, 200);
    assert.equal(error.committed, true);
    assert.match(error.message, /complete destination may already exist.*committed:true.*manually verify its SHA-256/);
    assert.match(error.message, /Do not retry automatically/);
    assert.equal(error.message.includes(settings.credential), false);
    return true;
  });
  assert.deepEqual(await fs.readFile(f.output), bytes);
  await noPartial(f, ["config.json", "chosen.zip"]);
});

test("CLI downloads exact binary bytes, authenticates all requests and emits only local receipt", async t => {
  const f = await fixture(t);
  const transport = mock(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2, 9)); controller.enqueue(bytes.subarray(9)); controller.close();
  } }), { headers: { ...headers, "content-disposition": 'attachment; filename="../../never-use.zip"' } }));
  const result = await runManagerCommand(["--api", "GET", target, "--agent", "worker", "--output", f.output], f.config, { fetchImpl: transport.fetchImpl });
  assert.deepEqual(await fs.readFile(f.output), bytes);
  assert.deepEqual(result, { ok: true, statusCode: 200, path: f.output, sizeBytes: bytes.length, sha256: digest, identity: { applicationGenerationId: meta.applicationGenerationId, managerInstanceId: meta.managerInstanceId } });
  assert.equal(transport.calls.length, 3);
  for (const call of transport.calls) {
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.headers.authorization, `Bearer ${settings.credential}`);
    assert.equal(call.options.headers["x-rabiroute-agent-id"], "worker");
  }
  await noPartial(f, ["config.json", "chosen.zip"]);
});

test("existing final and final created during transfer are never overwritten", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, "keep");
  const transport = mock();
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), /not confirmed/);
  assert.equal(transport.calls.length, 0);
  assert.equal(await fs.readFile(f.output, "utf8"), "keep");
  await fs.unlink(f.output);
  const race = mock(async () => { await fs.writeFile(f.output, "racing writer"); return new Response(bytes, { headers }); });
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: race.fetchImpl }).download(target, f.output));
  assert.equal(await fs.readFile(f.output, "utf8"), "racing writer");
  await noPartial(f, ["config.json", "chosen.zip"]);
});

for (const [name, response] of [
  ["JSON error", () => Response.json({ secret: settings.credential }, { status: 403 })],
  ["JSON pretending success", () => Response.json({ secret: settings.credential })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "http://other.invalid" } })],
  ["oversize declared", () => new Response(bytes, { headers: { ...headers, "content-length": String(MAX_SKILL_DOWNLOAD_BYTES + 1) } })],
  ["unsafe integer length", () => new Response(bytes, { headers: { ...headers, "content-length": "9007199254740993" } })],
  ["missing length", () => new Response(bytes, { headers: { "content-type": "application/zip", "x-rabiroute-content-sha256": digest } })],
  ["zero length", () => new Response(bytes, { headers: { ...headers, "content-length": "0" } })],
  ["fraction length", () => new Response(bytes, { headers: { ...headers, "content-length": "4.5" } })],
  ["invalid hash", () => new Response(bytes, { headers: { ...headers, "x-rabiroute-content-sha256": "not-a-hash" } })],
  ["missing hash", () => new Response(bytes, { headers: { "content-type": "application/zip", "content-length": String(bytes.length) } })],
  ["partial HTTP status", () => new Response(bytes, { status: 206, headers })],
  ["hash mismatch", () => new Response(bytes, { headers: { ...headers, "x-rabiroute-content-sha256": "a".repeat(64) } })],
  ["truncated", () => new Response(bytes.subarray(0, -1), { headers })],
  ["stream larger than declared", () => new Response(bytes, { headers: { ...headers, "content-length": "4" } })],
  ["invalid signature", () => { const b = Buffer.alloc(bytes.length, 42); return new Response(b, { headers: { ...headers, "x-rabiroute-content-sha256": createHash("sha256").update(b).digest("hex") } }); }],
  ["stream error", () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 8)); }, pull(c) { c.error(new Error(settings.credential)); } }), { headers })]
]) test(`download rejects ${name} and removes partial without leaking`, async t => {
  const f = await fixture(t);
  const transport = mock(response);
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output), error => !error.message.includes(settings.credential) && /not confirmed/.test(error.message));
  await noPartial(f);
  assert.equal(transport.calls.filter(c => !c.url.endsWith("/meta")).length, 1);
});

test("generation and instance changes reject; unrelated post-download health changes do not", async t => {
  const f = await fixture(t);
  for (const after of [{ ...meta, applicationGenerationId: "next" }, { ...meta, managerInstanceId: "next" }, {}]) {
    const transport = mock(undefined, after);
    await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output));
    await noPartial(f);
  }
  const transport = mock(undefined, { ...meta, health: { state: "unhealthy", live: false, requiredReady: false } });
  assert.equal((await createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output)).ok, true);
});

test("invalid metadata and unavailable post-metadata remove partial", async t => {
  const f = await fixture(t);
  for (const failingCall of [1, 3]) {
    let calls = 0;
    const fetchImpl = async () => ++calls === failingCall ? new Response("not JSON") : calls === 2 ? new Response(bytes, { headers }) : Response.json(meta);
    await assert.rejects(createManagerClient({ ...settings, fetchImpl }).download(target, f.output));
    await noPartial(f);
  }
});

test("preflight admits unrelated degraded health but requires live and ready", async t => {
  const f = await fixture(t);
  for (const health of [{ live: false, requiredReady: true, state: "healthy" }, { live: true, requiredReady: false, state: "healthy" }]) {
    let calls = 0;
    await assert.rejects(createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json({ ...meta, health }); } }).download(target, f.output));
    assert.equal(calls, 1);
    await noPartial(f);
  }
  const transport = mock();
  const fetchImpl = (url, init) => String(url).endsWith("/meta") ? Response.json({ ...meta, health: { ...meta.health, state: "degraded", businessReady: false } }) : transport.fetchImpl(url, init);
  assert.equal((await createManagerClient({ ...settings, fetchImpl }).download(target, f.output)).ok, true);
});

test("post-download metadata timeout cleans the fully written temporary file", async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => ++calls === 1 ? Response.json(meta) : calls === 2 ? new Response(bytes, { headers }) : new Promise(() => {});
  // Keep the test process alive while AbortSignal.timeout's unref timer expires.
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(createManagerClient({ ...settings, fetchImpl, downloadTimeoutMs: 50 }).download(target, f.output)); }
  finally { clearInterval(keepAlive); }
  await noPartial(f);
  assert.equal(calls, 3);
});

test("caller cancellation cleans partial even with a stalled readable", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const transport = mock(() => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 4)); setTimeout(() => controller.abort(), 30); } }), { headers }));
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).download(target, f.output, { signal: controller.signal }));
  await noPartial(f);
});

test("CLI SIGINT and SIGTERM cancel downloads and release signal listeners", async t => {
  const f = await fixture(t);
  for (const event of ["SIGINT", "SIGTERM"]) {
    const before = process.listenerCount(event);
    const transport = mock(() => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 4)); setTimeout(() => process.emit(event), 30); } }), { headers }));
    await assert.rejects(runManagerCommand(["--api", "GET", target, "--agent", "worker", "--output", f.output], f.config, { fetchImpl: transport.fetchImpl }));
    assert.equal(process.listenerCount(event), before);
    await noPartial(f);
  }
});

test("real HTTP stream timeout and redirects reject with no destination or partial", async t => {
  const f = await fixture(t);
  let mode = "timeout";
  let redirects = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/meta") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(meta)); }
    else if (req.url === "/elsewhere") { redirects++; res.end("not permitted"); }
    else if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); }
    else { res.writeHead(200, headers); res.write(bytes.subarray(0, 4)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = createManagerClient({ ...settings, managerUrl: `http://127.0.0.1:${server.address().port}`, downloadTimeoutMs: 150 });
  await assert.rejects(client.download(target, f.output));
  await noPartial(f);
  mode = "redirect";
  await assert.rejects(client.download(target, f.output));
  await noPartial(f);
  assert.equal(redirects, 0);
});

test("parse guards reject unsafe combinations before credentials, stdin or network", async t => {
  const f = await fixture(t);
  const options = { fetchImpl: () => { throw new Error("must not fetch"); }, readInput: () => { throw new Error("must not read input"); } };
  for (const args of [
    ["--api", "GET", target],
    ["--api", "POST", target, "--output", f.output],
    ["--api", "GET", target, "--output", f.output, "--api", "POST", "/api/mutation"],
    ["--api", "GET", "/meta", "--output", f.output],
    ["--api", "GET", `${target}?anything=1`, "--output", f.output],
    ["--upload", "file", "--output", f.output],
    ...["--body-stdin", "--if-match", "--idempotency-key", "--upload-id"].map(flag => ["--api", "GET", target, "--output", f.output, flag, "value"]),
    ["--api", "GET", target, "--output"],
    ["--api", "GET", target, "--output", f.output, "--output", f.output]
  ]) await assert.rejects(runManagerCommand([...args, "--agent", "worker"], f.config, options));
  for (const segment of ["..", "%2e%2e", "%2f", "%5c", "%00", "%3a", "NUL", "sample."]) assert.equal(isSkillDownloadTarget(`/roles/example/skills/${segment}/download`), false, segment);
  assert.equal(isSkillDownloadTarget("/roles/example/skills/%E6%B5%8B%E8%AF%95/download"), true);
  await assert.rejects(createManagerClient({ ...settings, fetchImpl: options.fetchImpl }).invoke("GET", target), /explicit download/);
  await noPartial(f);
});

test("alias succeeds, missing parent is not created and generic JSON API will not decode ZIP", async t => {
  const f = await fixture(t);
  let transport = mock();
  const client = createManagerClient({ ...settings, fetchImpl: transport.fetchImpl });
  await assert.rejects(client.download(target, path.join(f.directory, "missing", "output.zip")));
  await noPartial(f);
  transport = mock();
  const aliasClient = createManagerClient({ ...settings, fetchImpl: transport.fetchImpl });
  assert.equal((await aliasClient.download(target.replace("/api", ""), f.output)).ok, true);
  transport = mock();
  const result = await createManagerClient({ ...settings, fetchImpl: transport.fetchImpl }).invoke("GET", "/api/unexpected-binary");
  assert.equal(result.ok, false);
  assert.equal(result.body.includes("PK"), false);
});
