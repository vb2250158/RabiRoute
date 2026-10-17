import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { connectDshOwner, migrateDshOwner, dshAuthenticatedFetch } from "./dshHttpAuth.js";
import { DshConnectionStore } from "./dshConnectionStore.js";
import { createLocalSecretProtector } from "./shared/localSecretProtection.js";

test("disconnect during a legacy login exchange prevents the pending task RPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-disconnect-race-"));
  const priorRoot = process.env.RABIROUTE_STATE_ROOT;
  const priorConfig = process.env.RABI_DSH_AUTH_FILE;
  const priorFetch = globalThis.fetch;
  const origin = "http://127.0.0.1:39276";
  const config = path.join(root, "auth.json");
  const log = path.join(root, "launch.log");
  process.env.RABIROUTE_STATE_ROOT = root;
  process.env.RABI_DSH_AUTH_FILE = config;
  fs.writeFileSync(config, JSON.stringify({ endpoints: [{ baseUrl: origin, launchLogPath: log }] }));
  fs.writeFileSync(log, `dsh web: ${origin}/?token=fixture-token\n`);
  const store = new DshConnectionStore(path.join(root, "data", "dsh-connections", "connections.json"));
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      store.disconnect(origin, 0);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "dsh-auth-fixture=fixture.signature; Path=/; HttpOnly" } });
    };
    await assert.rejects(dshAuthenticatedFetch(origin, "session/prompt", "{}"), /authorization changed/);
    assert.equal(calls, 1);
    const other = "http://127.0.0.1:39278";
    fs.writeFileSync(config, JSON.stringify({ endpoints: [{ baseUrl: other, launchLogPath: log }] }));
    fs.writeFileSync(log, `dsh web: ${other}/?token=fixture-token\n`);
    globalThis.fetch = async () => {
      calls++;
      store.disconnect(other, 1);
      store.connect(other, { cookie: "dsh-auth-fixture=reconnected.signature", expiresAt: Date.now() + 60_000 }, 2);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "dsh-auth-fixture=fixture.signature; Path=/; HttpOnly" } });
    };
    await assert.rejects(dshAuthenticatedFetch(other, "session/prompt", "{}"), /authorization changed/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.RABIROUTE_STATE_ROOT; else process.env.RABIROUTE_STATE_ROOT = priorRoot;
    if (priorConfig === undefined) delete process.env.RABI_DSH_AUTH_FILE; else process.env.RABI_DSH_AUTH_FILE = priorConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("saved authorization survives independent store reads and 401 never replays or falls back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-saved-rpc-"));
  const priorRoot = process.env.RABIROUTE_STATE_ROOT;
  const priorFetch = globalThis.fetch;
  process.env.RABIROUTE_STATE_ROOT = root;
  const origin = "http://127.0.0.1:39275";
  const dir = path.join(root, "data", "dsh-connections");
  const store = new DshConnectionStore(path.join(dir, "connections.json"), createLocalSecretProtector(dir));
  let calls = 0;
  try {
    store.connect(origin, { cookie: "dsh-auth-fixture=v1.fixture.signature", expiresAt: Date.now() + 60_000 }, 0);
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("cookie"), "dsh-auth-fixture=v1.fixture.signature");
      return new Response(null, { status: calls === 1 ? 200 : 401 });
    };
    await dshAuthenticatedFetch(origin, "session/list", "{}");
    await assert.rejects(dshAuthenticatedFetch(origin, "session/prompt", "{}"), /not replayed/);
    assert.equal(calls, 2);
    assert.equal(store.readMetadata().connections[0]?.state, "expired");
    await assert.rejects(dshAuthenticatedFetch(origin, "session/prompt", "{}"), /reconnect/);
    assert.equal(calls, 2);
    assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /v1\.fixture/);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.RABIROUTE_STATE_ROOT; else process.env.RABIROUTE_STATE_ROOT = priorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit DSH connection verifies owner RPC, protects credentials and rejects redirects/foreign origins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString("utf8")
  });
  const prior = globalThis.fetch;
  const origin = "http://127.0.0.1:39270";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  let calls = 0;
  let redirect = false;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, "manual");
      if (url.pathname === "/") return new Response(null, { status: 303, headers: { location: redirect ? "https://example.invalid/" : "/",
        "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      assert.equal(url.pathname, "/api/session/list");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.payload, { args: { _request: { paged: true } } });
      return Response.json({ rpcId: body.rpcId, result: { ok: true, value: { items: [] } } });
    };
    const connected = await connectDshOwner(`${origin}/?token=fixture-token`, 0, store);
    assert.equal(connected.state, "connected");
    assert.equal(calls, 2);
    assert.equal(store.resolve(origin)?.state, "connected");
    assert.doesNotMatch(JSON.stringify(connected), /fixture|cookie|token/);
    await assert.rejects(connectDshOwner("https://example.invalid/?token=fixture-token", 1, store), /local/);
    await assert.rejects(connectDshOwner(`${origin}/?token=fixture-token&other=x`, 1, store), /one token/);
    assert.equal(calls, 2);
    redirect = true;
    await assert.rejects(connectDshOwner(`${origin}/?token=fixture-token`, 1, store), /rejected/);
    assert.equal(store.readMetadata().revision, 1);
    assert.equal(calls, 3);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(migrateDshOwner(origin, 1, store), /API verification failed/);
    assert.equal(store.resolve(origin)?.state, "connected");
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(migrateDshOwner(origin, 1, store), /rejected/);
    assert.equal(store.resolve(origin)?.state, "expired");
    assert.equal(store.readMetadata().revision, 2);
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => {
      if (init?.method !== "POST") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      const body = JSON.parse(String(init.body));
      controller.abort();
      return Response.json({ rpcId: body.rpcId, result: { ok: true } });
    };
    await assert.rejects(connectDshOwner(`${origin}/?token=fixture-token`, 2, store, controller.signal));
    assert.equal(store.readMetadata().revision, 2);
  } finally { globalThis.fetch = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH connection validation requests only the first page and accepts responses above 8 MiB", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-paged-large-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString("utf8")
  });
  const prior = globalThis.fetch;
  const origin = "http://127.0.0.1:39271";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  let rpcSignal: AbortSignal | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.payload, { args: { _request: { paged: true } } });
      rpcSignal = init?.signal as AbortSignal;
      const prefix = Buffer.from(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }));
      const padding = Buffer.alloc(9 * 1024 * 1024, 32);
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) { controller.close(); return; }
          sent = true;
          controller.enqueue(prefix);
          controller.enqueue(padding);
        }
      });
      return new Response(stream, { status: 200 });
    };
    const connected = await connectDshOwner(`${origin}/?token=fixture-token`, 0, store);
    assert.equal(connected.state, "connected");
    assert.equal(rpcSignal?.aborted, false);
  } finally { globalThis.fetch = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH connection validation accepts a response taking longer than the former 10-second timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-slow-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString("utf8")
  });
  const prior = globalThis.fetch;
  const origin = "http://127.0.0.1:39273";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  let rpcSignal: AbortSignal | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      const body = JSON.parse(String(init?.body));
      rpcSignal = init?.signal as AbortSignal;
      await new Promise(resolve => setTimeout(resolve, 10_100));
      assert.equal(rpcSignal.aborted, false);
      return Response.json({ rpcId: body.rpcId, result: { ok: true } });
    };
    const connected = await connectDshOwner(`${origin}/?token=fixture-token`, 0, store);
    assert.equal(connected.state, "connected");
    assert.equal(rpcSignal?.aborted, false);
  } finally { globalThis.fetch = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH connection validation rejects responses above 32 MiB", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-over-limit-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString("utf8")
  });
  const prior = globalThis.fetch;
  const origin = "http://127.0.0.1:39272";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  try {
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      const body = JSON.parse(String(init?.body));
      const prefix = Buffer.from(JSON.stringify({ rpcId: body.rpcId, result: { ok: true } }));
      const padding = Buffer.alloc(33 * 1024 * 1024, 32);
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) { controller.close(); return; }
          sent = true;
          controller.enqueue(prefix);
          controller.enqueue(padding);
        }
      });
      return new Response(stream, { status: 200 });
    };
    await assert.rejects(connectDshOwner(`${origin}/?token=fixture-token`, 0, store), /too large/);
    assert.equal(store.readMetadata().connections.length, 0);
  } finally { globalThis.fetch = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH verification sends object args and reports DSH's error without credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connect-object-args-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: text => Buffer.from(text).toString("base64"), unprotect: text => Buffer.from(text, "base64").toString("utf8")
  });
  const prior = globalThis.fetch;
  const origin = "http://127.0.0.1:39279";
  const cookieName = `dsh-auth-${createHash("sha256").update(new URL(origin).host).digest("base64url")}`;
  try {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${cookieName}=v1.fixture.signature; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600` } });
      const body = JSON.parse(String(init?.body));
      assert.equal(Array.isArray(body.payload.args), false);
      assert.deepEqual(body.payload.args, { _request: { paged: true } });
      return Response.json({ rpcId: body.rpcId, result: { ok: false, error: { code: "invalid_payload", message: `Remote payload must contain exactly one plain-object args field ${cookieName}=v1.fixture.signature` } } });
    };
    await assert.rejects(connectDshOwner(`${origin}/?token=fixture-token`, 0, store), (error: Error) => {
      assert.match(error.message, /not ready/);
      assert.match(error.message, /invalid_payload/);
      assert.match(error.message, /plain-object args field/);
      assert.doesNotMatch(error.message, /fixture\.signature|fixture-token/);
      return true;
    });
  } finally { globalThis.fetch = prior; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH connection request budget exceeds the verification timeout", async () => {
  const { DSH_CONNECTION_REQUEST_TIMEOUT_MS } = await import("./manager/dshConnectionRoutes.js");
  assert.ok(DSH_CONNECTION_REQUEST_TIMEOUT_MS > 60_000);
});
