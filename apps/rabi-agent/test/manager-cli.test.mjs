import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runManagerCommand } from "../lib/manager-cli.mjs";

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
  const result = await runManagerCommand(["--api", "POST", "/plugin/new/export", "--agent", "worker", "--body-file", inputPath, "--header", "Content-Type: application/custom", "--header", "X-Plugin-Operation: fixture", "--output", outputPath], configPath);
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(outputPath), bytes);
  assert.deepEqual(seen[0].body, bytes);
  assert.equal(seen[0].headers["x-plugin-operation"], "fixture");
  assert.ok(!JSON.stringify(result).includes(config.nodeCredential));
  const rawResult = await runManagerCommand(["--api", "PATCH", "/plugin/new/raw", "--agent", "worker", "--raw-stdin", "--header", "X-Plugin-Operation: raw"], configPath, { readInput: async () => "原文 not JSON\n" });
  assert.equal(rawResult.transportError, "RESPONSE_MODE_REQUIRED");
  assert.deepEqual(seen[1].body, Buffer.from("原文 not JSON\n"));
  await assert.rejects(runManagerCommand(["--api", "GET", "/plugin/new/events", "--agent", "worker", "--stream"], configPath), /stdout callbacks and WebSocket are not supported/);
  await assert.rejects(runManagerCommand(["--api", "POST", "/plugin/new", "--agent", "worker", "--header", "Authorization: forged"], configPath), /transport-owned/);
  await assert.rejects(runManagerCommand(["--api", "POST", "/plugin/new", "--agent", "worker", "--body-stdin", "--raw-stdin"], configPath), /one API body/);
  const reflected = await runManagerCommand(["--api", "GET", "/plugin/new/reflect", "--agent", "worker"], configPath, { fetchImpl: async url => String(url).endsWith("/meta") ? Response.json(meta) : new Response(`fixture ${config.nodeCredential}`, { headers: { "x-business": config.nodeCredential, "authorization": "private" } }) });
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
  assert.equal((await runManagerCommand(["--api", "GET", "/plugin/new/finite", "--agent", "worker", "--stream", "--output", finitePath], configPath)).ok, true);
  assert.equal(fs.readFileSync(finitePath, "utf8"), "data: fixture\n\n");
  const stalled = await runManagerCommand(["--api", "GET", "/plugin/new/stall", "--agent", "worker", "--stream", "--output", path.join(directory, "stall.txt"), "--timeout-ms", "40"], configPath);
  assert.equal(stalled.ok, false);
  assert.equal(stalled.noReplay, true);
  assert.equal(counts.get("/plugin/new/stall"), 1);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["config.json", "finite.txt"]);
});

test("CLI uses registered identity, preserves stdin JSON and never exports credentials", async () => {
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
    const receipt = await runManagerCommand(["--api", "POST", "/api/roles/example/plans", "--agent", "worker", "--body-stdin", "--idempotency-key", "fixture-key"], configPath, { fetchImpl, readInput: async () => body });
    assert.equal(receipt.ok, true);
    assert.equal(calls[1].body, body);
    assert.equal(calls[1].headers["idempotency-key"], "fixture-key");
    assert.ok(!JSON.stringify(receipt).includes(config.nodeCredential));
    const largeBody = JSON.stringify({ text: "x".repeat(1024 * 1024 + 1) });
    assert.equal((await runManagerCommand(["--api", "POST", "/api/fixture", "--agent", "worker", "--body-stdin"], configPath, { fetchImpl, readInput: async () => largeBody })).ok, true);
    assert.equal(calls.at(-2).body, largeBody);
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta"], configPath, { fetchImpl }), /registered Agent/);
    config.agents[0].enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const beforeLegacyRequest = calls.length;
    assert.equal((await runManagerCommand(["--api", "GET", "/meta", "--agent", "worker"], configPath, { fetchImpl })).ok, true);
    assert.ok(calls.length > beforeLegacyRequest);
    // The same stale local field cannot override a Manager disable either.
    const afterManagedRequest = calls.length;
    assert.equal((await runManagerCommand(["--api", "GET", "/meta", "--agent", "worker"], configPath, { fetchImpl: async () => Response.json({ code: 403 }, { status: 403 }) })).ok, false);
    delete config.nodeCredential;
    config.lanLinkToken = "old-shared-fixture";
    fs.writeFileSync(configPath, JSON.stringify(config));
    await assert.rejects(runManagerCommand(["--api", "GET", "/meta", "--agent", "worker"], configPath, { fetchImpl }), /independent node credential/);
    assert.equal(calls.length, afterManagedRequest);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
