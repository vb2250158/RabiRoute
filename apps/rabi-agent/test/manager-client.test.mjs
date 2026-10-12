import test from "node:test";
import assert from "node:assert/strict";
import { createManagerClient } from "../lib/manager-client.mjs";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const meta = { health: { live: true, state: "healthy", requiredReady: true }, applicationGenerationId: "generation-fixture", managerInstanceId: "manager-fixture" };
const settings = { managerUrl: "http://manager.invalid:1234", credential: "fixture-only", agentId: "agent-fixture" };

test("concurrent operations keep postflight on their own verified origin", async () => {
  let sequence = 0;
  let release;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const firstRelease = new Promise(resolve => { release = resolve; });
  const postflights = [];
  const client = createManagerClient({ ...settings, endpointSession: { ensure: async () => {
    const name = ++sequence === 1 ? "first" : "second";
    return { managerUrl: `http://${name}.invalid`, meta: { ...meta, managerInstanceId: name } };
  } }, fetchImpl: async url => {
    const address = new URL(url);
    if (address.pathname === "/api/write" && address.hostname === "first.invalid") { started(); await firstRelease; }
    if (address.pathname === "/meta") {
      postflights.push(address.hostname);
      return Response.json({ ...meta, managerInstanceId: address.hostname.split(".")[0] });
    }
    return Response.json({ code: 0 });
  } });
  const first = client.invoke("POST", "/api/write", { body: {} });
  await firstStarted;
  const second = await client.invoke("POST", "/api/write", { body: {} });
  release();
  const result = await first;
  assert.deepEqual(postflights, ["second.invalid", "first.invalid"]);
  assert.equal(result.uncertain, false);
  assert.equal(second.uncertain, false);
});

test("client verifies metadata, preserves mutation headers and returns receipts without replay", async () => {
  const calls = [];
  const client = createManagerClient({ ...settings, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return calls.length !== 2 ? Response.json(meta) : Response.json({ ok: true }, { headers: { etag: '"revision-2"', "idempotency-key": "operation-fixture" } });
  } });
  const result = await client.invoke("PATCH", "/api/roles/example/plans/one", { body: { title: "Example" }, headers: { "If-Match": '"revision-1"', "Idempotency-Key": "operation-fixture" } });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${settings.managerUrl}/meta`);
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers["x-rabiroute-agent-id"], settings.agentId);
  assert.equal(calls[1].options.headers["if-match"], '"revision-1"');
  assert.equal(calls[1].options.headers["x-rabiroute-expected-application-generation-id"], meta.applicationGenerationId);
  assert.equal(calls[1].options.headers["x-rabiroute-expected-manager-instance-id"], meta.managerInstanceId);
  assert.equal(result.headers.etag, '"revision-2"');
  assert.equal(result.uncertain, false);
  assert.equal(result.identity.managerInstanceId, "manager-fixture");
});

test("client rejects cross-origin targets and caller credential overrides", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json(meta); } });
  for (const target of ["https://other.invalid/api", "//other.invalid/api", "/\\other.invalid/api", "/api#fragment"]) {
    await assert.rejects(client.invoke("POST", target), /relative path/);
  }
  await assert.rejects(client.invoke("GET", "/api/example", { headers: { authorization: "override" } }), /transport-owned/);
  assert.equal(calls, 0); // Reject invalid targets and transport header overrides before metadata.
});

test("uncertain mutation returns once and does not expose transport secrets", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => {
    if (++calls === 1) return Response.json(meta);
    throw new Error(`Sensitive transport detail ${settings.credential}`);
  } });
  const result = await client.invoke("POST", "/api/agent/send", { body: {} });
  assert.equal(calls, 3);
  assert.equal(result.uncertain, true);
  assert.equal(result.statusCode, 0);
  assert.ok(!result.body.includes(settings.credential));
});

test("business readiness is strict but exact diagnostics and unrelated degradation remain available", async () => {
  for (const health of [undefined, { state: "healthy", requiredReady: true }, { state: "healthy", live: false, requiredReady: true }]) {
    let calls = 0;
    const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json({ ...meta, health }); } });
    await assert.rejects(client.invoke("POST", "/api/agent/send"), /not ready/);
    assert.equal(calls, 1);
    assert.equal((await client.invoke("GET", "/meta")).ok, true);
  }
  const client = createManagerClient({ ...settings, fetchImpl: async () => Response.json({ ...meta, health: { ...meta.health, state: "degraded" } }) });
  assert.equal((await client.invoke("GET", "/api/example")).ok, true);
});

test("metadata envelopes preserve mutation identity", async () => {
  const client = createManagerClient({ ...settings, fetchImpl: async url =>
    new URL(url).pathname === "/meta" ? Response.json({ code: 0, data: meta }) : Response.json({ code: 0 }) });
  const result = await client.invoke("PATCH", "/api/example", { body: {} });
  assert.equal(result.identityChanged, false);
  assert.equal(result.uncertain, false);
});

test("stateful GET never replays and reports uncertainty on failures", async () => {
  for (const failure of ["transport", "server", "generation"]) {
    let operations = 0;
    let discoveries = 0;
    const client = createManagerClient({ ...settings,
      endpointSession: { ensure: async () => { discoveries++; return { managerUrl: settings.managerUrl, meta }; } },
      fetchImpl: async url => {
        if (new URL(url).pathname === "/meta") return Response.json(failure === "generation" ? { ...meta, managerInstanceId: "changed" } : meta);
        operations++;
        if (failure === "transport") throw new Error("transport failure");
        return Response.json({ code: failure === "server" ? 1 : 0 }, { status: failure === "server" ? 503 : 200 });
      }
    });
    const result = await client.invoke("GET", "/api/roles/example/memory/recent/one");
    assert.equal(operations, 1);
    assert.equal(discoveries, 1);
    assert.equal(result.uncertain, true);
  }
});

test("replaySafe only narrows replay and never enables mutation replay", async () => {
  for (const [method, options] of [["GET", { replaySafe: false }], ["POST", { replaySafe: true, body: {} }]]) {
    let operations = 0;
    let discoveries = 0;
    const client = createManagerClient({ ...settings,
      endpointSession: { ensure: async () => { discoveries++; return { managerUrl: settings.managerUrl, meta }; } },
      fetchImpl: async url => {
        if (new URL(url).pathname === "/meta") return Response.json(meta);
        operations++;
        return Response.json({ code: 1 }, { status: 503 });
      }
    });
    const result = await client.invoke(method, "/api/example", options);
    assert.equal(operations, 1);
    assert.equal(discoveries, 1);
    assert.equal(result.uncertain, true);
  }
});

test("local Host mode uses verified loopback without fabricated node credentials", async () => {
  let calls = 0;
  const endpointSession = { ensure: async () => ({ managerUrl: "http://127.0.0.1:1234", meta }) };
  const client = createManagerClient({ managerUrl: "http://127.0.0.1:1234", localHost: true, endpointSession,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers["x-rabiroute-agent-id"], undefined);
      return Response.json(new URL(url).pathname === "/meta" ? meta : { code: 0 });
    }
  });
  assert.equal((await client.invoke("GET", "/api/example")).ok, true);
  assert.equal(calls, 2);
  assert.throws(() => createManagerClient({ ...settings, localHost: true, endpointSession }), /without remote credentials/);
  assert.throws(() => createManagerClient({ managerUrl: settings.managerUrl, localHost: true }), /Host endpoint/);
  const invalid = createManagerClient({ managerUrl: settings.managerUrl, localHost: true,
    endpointSession: { ensure: async () => ({ managerUrl: settings.managerUrl, meta }) }, fetchImpl: async () => { throw new Error("Must not reach network"); }
  });
  await assert.rejects(invalid.invoke("GET", "/api/example"), /loopback/);
});

test("OPTIONS uses verified identity and caller cannot override generation headers", async () => {
  const calls = [];
  const client = createManagerClient({ ...settings, fetchImpl: async (url, options) => {
    calls.push(options);
    return Response.json(new URL(url).pathname === "/meta" ? meta : { code: 0 });
  } });
  assert.equal((await client.invoke("OPTIONS", "/api/example")).ok, true);
  assert.equal(calls[1].method, "OPTIONS");
  assert.equal(calls[1].headers["x-rabiroute-expected-manager-instance-id"], meta.managerInstanceId);
  await assert.rejects(client.invoke("POST", "/api/example", { headers: { "x-rabiroute-expected-manager-instance-id": "forged" } }), /transport-owned/);
});

async function httpFixture(t, handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("new plugin paths accept business headers, exact raw/bytes/stream bodies and responses above 4 MiB", async t => {
  const seen = [];
  const large = "x".repeat(4 * 1024 * 1024 + 5);
  const zip = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128]);
  const managerUrl = await httpFixture(t, async (request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ target: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    if (request.url === "/plugin/new/text") { response.end(large); return; }
    response.setHeader("content-type", "application/zip");
    response.setHeader("x-plugin-revision", "fixture-r1");
    response.setHeader("set-cookie", "private-fixture");
    response.end(zip);
  });
  const client = createManagerClient({ ...settings, managerUrl });
  for (const options of [{ bodyText: "not JSON\n原文" }, { bodyBytes: zip }, { bodyStream: (async function* () { yield zip.subarray(0, 2); yield zip.subarray(2); })() }]) {
    const result = await client.request("POST", "/plugin/new/archive?version=fixture", { ...options, responseMode: "bytes", headers: { "content-type": "application/custom", "x-plugin-operation": "fixture", "x-rabiroute-expected-revision": "r1" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.bodyBytes, zip);
    assert.equal(result.headers["x-plugin-revision"], "fixture-r1");
    assert.equal(result.headers["set-cookie"], undefined);
  }
  assert.deepEqual(seen.map(item => item.body), [Buffer.from("not JSON\n原文"), zip, zip]);
  for (const item of seen) {
    assert.equal(item.headers["x-plugin-operation"], "fixture");
    assert.equal(item.headers["x-rabiroute-expected-revision"], "r1");
    assert.equal(item.headers.authorization, `Bearer ${settings.credential}`);
    assert.equal(item.headers["x-rabiroute-agent-id"], settings.agentId);
    assert.equal(item.headers["x-rabiroute-expected-manager-instance-id"], meta.managerInstanceId);
  }
  assert.equal((await client.request("GET", "/plugin/new/text")).body, large);
  const bounded = await client.request("GET", "/plugin/new/text", { maxResponseBytes: 1024, replaySafe: false });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.transportError, "TRANSPORT");
});

test("deny transport headers without introducing a business allowlist", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json(meta); } });
  for (const name of ["Authorization", "Host", "Cookie", "Content-Length", "Connection", "Proxy-Authorization", "X-Forwarded-For", "X-RabiRoute-Agent-Id", "X-RabiRoute-Node-Id", "X-RabiRoute-Host-Token", "X-RabiRoute-WebGUI-Token", "X-RabiRoute-Expected-Application-Generation-Id", "X-RabiRoute-Expected-Manager-Instance-Id", "X-RabiLink-Internal-Hop", "X-RabiLink-Tunnel-Device-Id", "X-RabiLink-Resource-Owner", "X-RabiLink-Token", "bad header"]) {
    await assert.rejects(client.request("GET", "/plugin/new", { headers: { [name]: "forged" } }), /transport-owned/);
  }
  await assert.rejects(client.request("POST", "/plugin/new", { bodyText: "x", bodyBytes: Buffer.from("x") }), /one Manager/);
  await assert.rejects(client.request("GET", "/plugin/new", { headers: { "x-plugin": "bad\r\nvalue" } }), /valid HTTP/);
  assert.equal(calls, 0);
});

test("HTTP event-stream disconnect, timeout, cancellation and mutation generation changes never replay", async t => {
  const counts = new Map();
  let current = meta;
  const managerUrl = await httpFixture(t, async (request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(current)); return; }
    counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
    if (request.url === "/plugin/new/change") {
      current = { ...meta, managerInstanceId: "changed-fixture" };
      response.end("done"); return;
    }
    if (request.url === "/plugin/new/write-timeout") return;
    response.setHeader("content-type", "text/event-stream");
    response.write("data: first\n\n");
    if (request.url === "/plugin/new/disconnect") setTimeout(() => response.destroy(), 15);
  });
  let discoveries = 0;
  const client = createManagerClient({ ...settings, managerUrl, timeoutMs: 1000, endpointSession: { ensure: async () => { discoveries++; return { managerUrl, meta }; } } });
  for (const target of ["/plugin/new/disconnect", "/plugin/new/stall", "/plugin/new/cancel"]) {
    const controller = new AbortController();
    const chunks = [];
    const result = await client.request("GET", target, { responseMode: "stream", replaySafe: true, timeoutMs: 70, signal: controller.signal, onChunk: bytes => { chunks.push(bytes); if (target.endsWith("cancel")) controller.abort(); } });
    assert.equal(result.ok, false);
    assert.equal(result.noReplay, true);
    assert.equal(result.uncertain, true);
    assert.ok(Buffer.concat(chunks).includes(Buffer.from("first")));
    assert.equal(counts.get(target), 1);
  }
  const mutation = await client.request("POST", "/plugin/new/write-timeout", { bodyText: "fixture", replaySafe: true, timeoutMs: 30 });
  assert.equal(mutation.uncertain, true);
  assert.equal(counts.get("/plugin/new/write-timeout"), 1);
  const change = await client.request("POST", "/plugin/new/change", { bodyText: "fixture", replaySafe: true });
  assert.equal(change.identityChanged, true);
  assert.equal(change.uncertain, true);
  assert.equal(counts.get("/plugin/new/change"), 1);
  assert.equal(discoveries, 5);
});

test("buffered safe reads replay once and replaySafe false narrows recovery", async () => {
  for (const replaySafe of [true, false]) {
    let operations = 0;
    let discoveries = 0;
    const client = createManagerClient({ ...settings, endpointSession: { ensure: async () => { discoveries++; return { managerUrl: settings.managerUrl, meta }; } }, fetchImpl: async url => {
      if (new URL(url).pathname === "/meta") return Response.json(meta);
      return new Response("fixture", { status: ++operations === 1 ? 503 : 200 });
    } });
    const result = await client.request("GET", "/plugin/new/read", { replaySafe });
    assert.equal(result.ok, replaySafe);
    assert.equal(operations, replaySafe ? 2 : 1);
    assert.equal(discoveries, operations);
  }
});

test("stream consumer errors are sanitized and never replay after bytes escape", async () => {
  let operations = 0;
  let discoveries = 0;
  const client = createManagerClient({ ...settings, endpointSession: { ensure: async () => { discoveries++; return { managerUrl: settings.managerUrl, meta }; } }, fetchImpl: async url => {
    if (new URL(url).pathname === "/meta") return Response.json(meta);
    operations++;
    return new Response("fixture events", { headers: { "content-type": "text/event-stream" } });
  } });
  const result = await client.request("GET", "/plugin/new/events", { responseMode: "stream", replaySafe: true, onChunk: () => { throw new Error(settings.credential); } });
  assert.equal(result.ok, false);
  assert.equal(result.noReplay, true);
  assert.equal(operations, 1);
  assert.equal(discoveries, 1);
  assert.ok(!JSON.stringify(result).includes(settings.credential));
});

test("HTTP stream generation change is visible but cannot replay delivered chunks", async t => {
  let changed = false;
  let operations = 0;
  const managerUrl = await httpFixture(t, (request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(changed ? { ...meta, managerInstanceId: "changed" } : meta)); return; }
    operations++;
    changed = true;
    response.setHeader("content-type", "text/event-stream");
    response.end("data: fixture\n\n");
  });
  const chunks = [];
  const client = createManagerClient({ ...settings, managerUrl, endpointSession: { ensure: async () => ({ managerUrl, meta }) } });
  const result = await client.request("GET", "/plugin/new/events", { responseMode: "stream", replaySafe: true, onChunk: bytes => chunks.push(bytes) });
  assert.equal(result.identityChanged, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.noReplay, true);
  assert.equal(operations, 1);
  assert.equal(Buffer.concat(chunks).toString(), "data: fixture\n\n");
});

test("generic binary output commits only complete same-generation bytes without overwrite", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-public-response-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "fixture.zip");
  const zip = Buffer.from([80, 75, 3, 4, 0, 255]);
  let changed = false;
  let change = false;
  let operations = 0;
  const managerUrl = await httpFixture(t, (request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(changed ? { ...meta, managerInstanceId: "changed" } : meta)); return; }
    operations++;
    response.setHeader("content-type", "application/zip");
    response.end(zip);
    if (change) changed = true;
  });
  const client = createManagerClient({ ...settings, managerUrl });
  const result = await client.request("GET", "/plugin/new/export", { outputPath });
  assert.equal(result.outputCommitted, true);
  assert.deepEqual(await fs.readFile(outputPath), zip);
  const existing = await client.request("GET", "/plugin/new/export", { outputPath });
  assert.equal(existing.ok, false);
  assert.equal(operations, 1);
  change = true;
  const rejectedPath = path.join(directory, "changed.zip");
  const rejected = await client.request("GET", "/plugin/new/export", { outputPath: rejectedPath, replaySafe: true });
  assert.equal(rejected.outputCommitted, false);
  assert.equal(rejected.identityChanged, true);
  assert.equal(operations, 2);
  assert.deepEqual(await fs.readdir(directory), ["fixture.zip"]);
});

test("unready metadata prevents business request", async () => {
  let calls = 0;
  const client = createManagerClient({ ...settings, fetchImpl: async () => { calls++; return Response.json({ ...meta, health: { state: "starting" } }); } });
  await assert.rejects(client.invoke("POST", "/api/agent/send"), /not ready/);
  assert.equal(calls, 1);
});
