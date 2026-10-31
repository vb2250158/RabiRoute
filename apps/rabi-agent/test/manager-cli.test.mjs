import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runManagerCommand } from "../lib/manager-cli.mjs";

test("CLI wildcard discovery uses an explicit real HTTP method without a client endpoint mapping", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-wildcard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: "http://127.0.0.1:45002", nodeCredential: "controlled-fixture-credential" }));
  const metadata = { applicationGenerationId: "g", managerInstanceId: "m", health: { live: true, requiredReady: true, state: "healthy" } };
  const seen = [];
  const result = await runManagerCommand(["--operation", "plugin.proxy", ...sourceArgs, "--method", "PROPFIND", "--path-params", '{"suffix":"XYZ/a%20b"}', "--raw-stdin"], configPath, {
    readInput: async () => "original-body",
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      if (target.pathname === "/meta") return Response.json(metadata);
      if (target.pathname === "/api/agent/help") return Response.json({ code: 0, data: {
        schemaVersion: "2", ...metadata, pluginGenerationId: "p", catalogRevision: 1, catalogDigest: "sha256:" + "a".repeat(64), nextCursor: "",
        operations: [{ id: "plugin.proxy", contractDigest: "sha256:" + "a".repeat(64), contract: {
          operationId: "plugin.proxy", contractVersion: "1.0.0", method: "*", transport: "http", pathTemplate: "/api/native/models:suffix",
          request: { pathRemainder: "suffix", body: { kind: "passthrough" } }, httpProxy: { completion: "native" }
        } }]
      } });
      seen.push({ method: options.method, path: target.pathname, body: options.body }); return Response.json({ code: 0 });
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ method: "PROPFIND", path: "/api/native/modelsXYZ/a%20b", body: "original-body" }]);
  await assert.rejects(runManagerCommand(["--api", "GET", "/meta", "--method", "POST"], configPath), /HTTP --operation option/);
});

const sourceArgs = ["--agent-type", "dsh", "--id", "original-source"];

test("CLI operation calls resolve a current plugin path and preserve the original JSON and idempotency key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-operation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: "http://manager.invalid", nodeCredential: "fixture-credential", agents: [{ agentId: "worker" }] }));
  const metadata = { applicationGenerationId: "app", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
  const calls = [];
  const result = await runManagerCommand(["--operation", "plugin.example", ...sourceArgs, "--path-params", '{"recordId":"record one"}',
    "--query", '{"tag":["first","second"]}', "--idempotency-key", "original-key", "--body-stdin"], configPath, {
    readInput: async () => '{ "value": 7 }',
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      if (target.pathname === "/meta") return Response.json(metadata);
      if (target.pathname === "/api/agent/help") return Response.json({ code: 0, data: {
        schemaVersion: "2", ...metadata, pluginGenerationId: "plugins", catalogRevision: 1, catalogDigest: "sha256:" + "a".repeat(64), nextCursor: "",
        operations: [{ id: "plugin.example", contractDigest: "sha256:" + "a".repeat(64),
          contract: { operationId: "plugin.example", contractVersion: "1.0.0", method: "POST", pathTemplate: "/api/new-plugin/:recordId" } }]
      } });
      calls.push({ url: target.pathname + target.search, method: options.method, body: options.body, headers: options.headers });
      return Response.json({ code: 0, data: { received: true } });
    }
  });
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/new-plugin/record%20one?tag=first&tag=second");
  assert.equal(calls[0].body, '{ "value": 7 }'); assert.equal(calls[0].headers["idempotency-key"], "original-key");
});

test("CLI generic HTTP supports raw input, binary file streams, business headers and explicit output", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-public-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const inputPath = path.join(directory, "input.bin");
  const outputPath = path.join(directory, "output.zip");
  const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 128]);
  fs.writeFileSync(inputPath, bytes);
  const seen = [];
  const meta = { health: { live: true, state: "healthy", requiredReady: true }, applicationGenerationId: "g", managerInstanceId: "m" };
  const server = http.createServer(async (request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ body: Buffer.concat(chunks), headers: request.headers });
    response.setHeader("content-type", "application/zip");
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { managerUrl: `http://127.0.0.1:${server.address().port}`, nodeCredential: "fixture-secret", agents: [{ agentId: "worker", enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const beforeListeners = process.listenerCount("SIGINT");
  const result = await runManagerCommand(["--api", "POST", "/plugin/new/export", ...sourceArgs, "--body-file", inputPath, "--header", "Content-Type: application/custom", "--header", "X-Plugin-Operation: fixture", "--output", outputPath], configPath);
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(outputPath), bytes);
  assert.deepEqual(seen[0].body, bytes);
  assert.equal(seen[0].headers["x-plugin-operation"], "fixture");
  assert.ok(!JSON.stringify(result).includes(config.nodeCredential));
  const rawResult = await runManagerCommand(["--api", "PATCH", "/plugin/new/raw", ...sourceArgs, "--raw-stdin", "--header", "X-Plugin-Operation: raw"], configPath, { readInput: async () => "原文 not JSON\n" });
  assert.equal(rawResult.transportError, "RESPONSE_MODE_REQUIRED");
  assert.deepEqual(seen[1].body, Buffer.from("原文 not JSON\n"));
  await assert.rejects(runManagerCommand(["--api", "GET", "/plugin/new/events", ...sourceArgs, "--stream"], configPath), /requires --stream --output FILE/);
  await assert.rejects(runManagerCommand(["--api", "POST", "/plugin/new", ...sourceArgs, "--header", "Authorization: forged"], configPath), /transport-owned/);
  await assert.rejects(runManagerCommand(["--api", "POST", "/plugin/new", ...sourceArgs, "--body-stdin", "--raw-stdin"], configPath), /one API body/);
  const reflected = await runManagerCommand(["--api", "GET", "/plugin/new/reflect", ...sourceArgs], configPath, { fetchImpl: async url => String(url).endsWith("/meta") ? Response.json(meta) : new Response(`fixture ${config.nodeCredential}`, { headers: { "x-business": config.nodeCredential, "authorization": "private" } }) });
  assert.ok(!JSON.stringify(reflected).includes(config.nodeCredential));
  assert.equal(reflected.headers.authorization, undefined);
  assert.equal(process.listenerCount("SIGINT"), beforeListeners);
});

test("CLI finite SSE streams save exact bytes and timeout removes partial without reconnect", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-sse-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const meta = { health: { live: true, state: "healthy", requiredReady: true }, applicationGenerationId: "g", managerInstanceId: "m" };
  const counts = new Map();
  const server = http.createServer((request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
    response.setHeader("content-type", "text/event-stream");
    response.write("data: fixture\n\n");
    if (request.url === "/plugin/new/finite") response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ managerUrl: `http://127.0.0.1:${server.address().port}`, nodeCredential: "fixture-only", agents: [{ agentId: "worker", enabled: true }] }));
  const finitePath = path.join(directory, "finite.txt");
  assert.equal((await runManagerCommand(["--api", "GET", "/plugin/new/finite", ...sourceArgs, "--stream", "--output", finitePath], configPath)).ok, true);
  assert.equal(fs.readFileSync(finitePath, "utf8"), "data: fixture\n\n");
  const stalled = await runManagerCommand(["--api", "GET", "/plugin/new/stall", ...sourceArgs, "--stream", "--output", path.join(directory, "stall.txt"), "--timeout-ms", "40"], configPath);
  assert.equal(stalled.ok, false);
  assert.equal(stalled.noReplay, true);
  assert.equal(counts.get("/plugin/new/stall"), 1);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["config.json", "finite.txt"]);
});

test("CLI uses explicit source IDs, preserves stdin JSON and never exports credentials", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-cli-"));
  const configPath = path.join(dir, "config.json");
  const config = { managerUrl: "http://manager.invalid", nodeCredential: "fixture-node-only", agents: [{ agentId: "worker", enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const meta = { health: { live: true, state: "healthy", requiredReady: true }, applicationGenerationId: "g", managerInstanceId: "m" };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(options);
    return Response.json(String(url).endsWith("/meta") ? meta : { code: 0 });
  };
  try {
    const body = '{ "title": "Example" }';
    const receipt = await runManagerCommand(["--api", "POST", "/api/roles/example/plans", ...sourceArgs, "--body-stdin", "--idempotency-key", "fixture-key"], configPath, { fetchImpl, readInput: async () => body });
    assert.equal(receipt.ok, true);
    assert.equal(calls[1].body, body);
    assert.equal(calls[1].headers["idempotency-key"], "fixture-key");
    assert.ok(!JSON.stringify(receipt).includes(config.nodeCredential));
    const largeBody = JSON.stringify({ text: "x".repeat(1024 * 1024 + 1) });
    assert.equal((await runManagerCommand(["--api", "POST", "/api/fixture", ...sourceArgs, "--body-stdin"], configPath, { fetchImpl, readInput: async () => largeBody })).ok, true);
    assert.equal(calls.at(-2).body, largeBody);
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta"], configPath, { fetchImpl }), /--agent-type/);
    config.agents[0].enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const beforeLegacyRequest = calls.length;
    assert.equal((await runManagerCommand(["--api", "GET", "/meta", ...sourceArgs], configPath, { fetchImpl })).ok, true);
    assert.ok(calls.length > beforeLegacyRequest);
    // The same stale local field cannot override a Manager disable either.
    const afterManagedRequest = calls.length;
    assert.equal((await runManagerCommand(["--api", "GET", "/meta", ...sourceArgs], configPath, { fetchImpl: async () => Response.json({ code: 403 }, { status: 403 }) })).ok, false);
    delete config.nodeCredential;
    config.lanLinkToken = "old-shared-fixture";
    fs.writeFileSync(configPath, JSON.stringify(config));
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta", ...sourceArgs], configPath, { fetchImpl }), /independent node credential/);
    assert.equal(calls.length, afterManagedRequest);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
