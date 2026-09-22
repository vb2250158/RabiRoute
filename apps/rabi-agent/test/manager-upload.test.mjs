import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createManagerClient, MAX_UPLOAD_BYTES } from "../lib/manager-client.mjs";
import { runManagerCommand } from "../lib/manager-cli.mjs";

const id = "12345678-1234-4234-8234-123456789abc";
const meta = { health: { live: true, state: "healthy", requiredReady: true }, applicationGenerationId: "g-fixture", managerInstanceId: "m-fixture" };
const settings = { managerUrl: "http://manager.invalid", credential: "fixture-upload-secret", agentId: "worker" };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "文件 % binary.bin");
  const binary = Buffer.from([0, 255, 128, 13, 10, 34, 92, 0, 254]);
  fs.writeFileSync(file, binary);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ managerUrl: settings.managerUrl, nodeCredential: settings.credential, agents: [{ agentId: "worker" }] }));
  const dto = { id, fileName: path.basename(file), size: binary.length, sha256: createHash("sha256").update(binary).digest("hex"), expiresAt: "2099-01-01T00:00:00.000Z" };
  return { dir, file, binary, config, dto };
}
function transport(dto, mutate = response => response) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/meta")) return Response.json(meta);
    const chunks = [];
    for await (const chunk of options.body) chunks.push(chunk);
    calls.at(-1).bytes = Buffer.concat(chunks);
    return mutate(Response.json({ code: 0, data: dto }, { headers: { "idempotency-key": id } }));
  } };
}

test("upload CLI preserves binary/hash/name/identity and only uploads", async t => {
  const f = fixture(t);
  const mock = transport(f.dto);
  const receipt = await runManagerCommand(["--upload", f.file, "--agent", "worker", "--upload-id", id], f.config, { fetchImpl: mock.fetchImpl, readInput: () => { throw new Error("stdin must not be read"); } });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.uncertain, false);
  assert.deepEqual(receipt.payload, { type: "file", fileId: id, fileSha256: f.dto.sha256 });
  assert.match(receipt.guidance, /fileSha256 is required/);
  assert.deepEqual(JSON.parse(receipt.body), { code: 0, data: f.dto });
  assert.match(receipt.guidance, /nothing was sent/);
  assert.equal(mock.calls.length, 3);
  const { url, options } = mock.calls[1];
  assert.equal(url, `${settings.managerUrl}/api/agent/uploads/${id}`);
  assert.equal(options.method, "PUT");
  assert.equal(options.redirect, "error");
  assert.deepEqual(mock.calls[1].bytes, f.binary);
  assert.equal(options.duplex, "half");
  assert.equal(options.headers["content-length"], String(f.binary.length));
  assert.equal(options.headers["content-type"], "application/octet-stream");
  assert.equal(options.headers["x-rabiroute-file-name"], encodeURIComponent(path.basename(f.file)));
  assert.equal(options.headers["x-rabiroute-content-sha256"], f.dto.sha256);
  assert.match(options.headers["x-rabiroute-content-sha256"], /^[a-f0-9]{64}$/);
  assert.equal(options.headers["idempotency-key"], id);
  assert.equal(options.headers["x-rabiroute-agent-id"], "worker");
  assert.equal(options.headers.authorization, `Bearer ${settings.credential}`);
  assert.ok(!JSON.stringify(receipt).includes(settings.credential));
  assert.ok(!JSON.stringify(receipt).includes(f.file));
});

test("upload rejects size, directory, symlink and unstable ID before networking", async t => {
  const f = fixture(t);
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; throw new Error("network forbidden"); } });
  const large = path.join(f.dir, "large.bin");
  const fd = fs.openSync(large, "w");
  fs.ftruncateSync(fd, MAX_UPLOAD_BYTES + 1);
  fs.closeSync(fd);
  await assert.rejects(client.upload(large, id), /2 GiB/);
  await assert.rejects(client.upload(f.dir, id), /regular file/);
  for (const invalid of [undefined, "", "not-a-uuid", `${id}/extra`]) await assert.rejects(client.upload(f.file, invalid), /stable.*UUID/);
  const link = path.join(f.dir, "link");
  // Directory junctions do not require Windows symbolic-link privilege.
  fs.symlinkSync(f.dir, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(client.upload(link, id), /symlink/);
  assert.equal(calls, 0);
});

test("upload transport uncertainty never retries, sends, or leaks transport credentials", async t => {
  const f = fixture(t);
  const mock = transport(f.dto, () => { throw new Error(`Timeout with Bearer ${settings.credential}`); });
  const receipt = await createManagerClient({ ...settings, fetchImpl: mock.fetchImpl }).upload(f.file, id);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.uncertain, true);
  assert.deepEqual(receipt.query, { method: "GET", path: `/api/agent/uploads/${id}` });
  assert.match(receipt.guidance, /Do not change/);
  assert.equal(mock.calls.filter(call => call.options.method === "PUT").length, 1);
  assert.equal(mock.calls.length, 3);
  assert.ok(!JSON.stringify(receipt).includes(settings.credential));
  assert.equal(receipt.payload, undefined);
});

test("upload denial and invalid receipts never offer a send payload", async t => {
  const f = fixture(t);
  for (const response of [
    () => Response.json({ code: 403, message: "denied" }, { status: 403 }),
    () => Response.json({ code: 503 }, { status: 503 }),
    () => Response.json({ code: 0, data: { ...f.dto, path: "/private/server/file" } }, { headers: { "idempotency-key": id } }),
    () => Response.json({ code: 0, data: { ...f.dto, sha256: "0".repeat(64) } }, { headers: { "idempotency-key": id } }),
    () => Response.json({ code: 0, data: f.dto }),
    () => Response.json({ code: 0, data: f.dto }, { headers: { "idempotency-key": "wrong" } })
  ]) {
    const mock = transport(f.dto, response);
    const receipt = await createManagerClient({ ...settings, fetchImpl: mock.fetchImpl }).upload(f.file, id);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.payload, undefined);
    assert.equal(receipt.uncertain, receipt.statusCode !== 403);
    assert.equal(mock.calls.length, 3);
    assert.ok(!receipt.body.includes("/private/server/file"));
    assert.ok(mock.calls.every(call => !call.url.endsWith("/send")));
  }
});

test("upload generation change marks successful PUT uncertain", async t => {
  const f = fixture(t);
  let calls = 0;
  const receipt = await createManagerClient({ ...settings, fetchImpl: async () => {
    calls++;
    if (calls === 2) return Response.json({ code: 0, data: f.dto }, { headers: { "idempotency-key": id } });
    return Response.json(calls === 1 ? meta : { ...meta, applicationGenerationId: "changed" });
  } }).upload(f.file, id);
  assert.equal(receipt.uncertain, true);
  assert.equal(receipt.identityChanged, true);
  assert.equal(receipt.payload, undefined);
  assert.equal(calls, 3);
});

test("upload CLI rejects mixed mutation options and unknown agents without networking", async t => {
  const f = fixture(t);
  let calls = 0;
  const options = { fetchImpl: () => { calls++; throw new Error("network forbidden"); } };
  const args = ["--upload", f.file, "--agent", "worker", "--upload-id", id];
  for (const extra of [["--api", "POST", "/api/agent/send"], ["--body-stdin"], ["--if-match", "etag"], ["--idempotency-key", "other"]]) await assert.rejects(runManagerCommand([...args, ...extra], f.config, options));
  await assert.rejects(runManagerCommand(["--upload", f.file, "--agent", "worker"], f.config, options), /stable/);
  await assert.rejects(runManagerCommand(["--upload", f.file, "--agent", "unknown", "--upload-id", id], f.config, options), /registered Agent/);
  assert.equal(calls, 0);
});

test("actual HTTP transport sends raw bytes and times out without redirect or replay", async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const f = fixture(t);
  const requests = [];
  let mode = "success";
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.url === "/meta") return res.end(JSON.stringify(meta));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), f.binary);
    assert.equal(req.headers["x-rabiroute-content-sha256"], f.dto.sha256);
    if (mode === "timeout") return;
    if (mode === "redirect") {
      res.writeHead(307, { location: "/credential-sink" });
      return res.end();
    }
    res.setHeader("Idempotency-Key", id);
    res.end(JSON.stringify({ code: 0, data: f.dto }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = createManagerClient({ ...settings, managerUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 150, uploadTimeoutMs: 150 });
  assert.equal((await client.upload(f.file, id)).ok, true);
  for (const failure of ["timeout", "redirect"]) {
    mode = failure;
    const receipt = await client.upload(f.file, id);
    assert.equal(receipt.uncertain, true);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.payload, undefined);
  }
  assert.equal(requests.filter(req => req.method === "PUT").length, 3);
  assert.equal(requests.length, 9);
  assert.ok(requests.every(req => req.url === "/meta" || req.url === `/api/agent/uploads/${id}`));
});

test("stream chunks are bounded and second-pass mutations never offer a send payload", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, Buffer.alloc(1024 * 1024, 7));
  let chunks = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/meta")) return Response.json(meta);
    fs.writeFileSync(f.file, Buffer.alloc(1024 * 1024, 8));
    for await (const chunk of init.body) {
      chunks++;
      assert.ok(chunk.length <= 256 * 1024);
    }
    throw new Error("Changed bytes must fail before a receipt.");
  } });
  const result = await client.upload(f.file, id);
  assert.ok(chunks >= 4);
  assert.equal(result.uncertain, true);
  assert.equal(result.payload, undefined);
  fs.unlinkSync(f.file);
});

test("early HTTP rejection releases the file and explains Manager limits", async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const f = fixture(t);
  fs.writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024));
  const server = createServer((req, res) => {
    if (req.url === "/meta") return res.end(JSON.stringify(meta));
    req.resume();
    res.writeHead(413);
    res.end(JSON.stringify({ code: 413 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await createManagerClient({ ...settings, managerUrl: `http://127.0.0.1:${server.address().port}`, uploadTimeoutMs: 5000 }).upload(f.file, id);
  assert.equal(result.statusCode, 413);
  assert.equal(result.ok, false);
  assert.match(result.guidance, /configured Manager upload limit/);
  fs.unlinkSync(f.file);
});

test("actual HTTP upload over 25 MiB stays streamed and verifies the full digest", async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const f = fixture(t);
  const block = Buffer.alloc(256 * 1024, 37);
  const hash = createHash("sha256");
  const fd = fs.openSync(f.file, "w");
  try {
    for (let index = 0; index < 128; index++) {
      fs.writeSync(fd, block);
      hash.update(block);
    }
  } finally { fs.closeSync(fd); }
  const size = 32 * 1024 * 1024;
  const sha256 = hash.digest("hex");
  let received = 0;
  let digest;
  const server = createServer(async (req, res) => {
    if (req.url === "/meta") return res.end(JSON.stringify(meta));
    const actual = createHash("sha256");
    for await (const chunk of req) { received += chunk.length; actual.update(chunk); }
    digest = actual.digest("hex");
    res.setHeader("Idempotency-Key", id);
    res.end(JSON.stringify({ code: 0, data: { ...f.dto, size, sha256: digest } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await createManagerClient({ ...settings, managerUrl: `http://127.0.0.1:${server.address().port}` }).upload(f.file, id);
  assert.equal(result.ok, true);
  assert.equal(received, size);
  assert.equal(digest, sha256);
  assert.equal(result.payload.fileSha256, sha256);
});

test("invoke cannot opt into binary or arbitrary upload headers", async () => {
  const mock = transport({});
  const client = createManagerClient({ ...settings, fetchImpl: mock.fetchImpl });
  await assert.rejects(client.invoke("PUT", `/api/agent/uploads/${id}`, { headers: { "x-rabiroute-file-name": "file" } }), /Only If-Match/);
  assert.equal(mock.calls.length, 1);
});
