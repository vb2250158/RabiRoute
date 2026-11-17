import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  deliverWorkbuddyMessage,
  ensureWorkbuddyDeliverable,
  parseWorkbuddyRunActive,
  parseWorkbuddyRunId,
  readWorkbuddyPrimaryBinding,
  waitForWorkbuddyTurn,
  WorkbuddyDeliveryError
} from "./workbuddySessionBridge.js";
import { assertWorkbuddyLoopback, discoverWorkbuddyOwners, invalidateWorkbuddyGatewayPassword, workbuddyGatewayPassword } from "./workbuddyHttpAuth.js";
import { parseWorkbuddySessionDescriptor } from "./workbuddySessionStore.js";

const PASSWORD = "rabi-test-gateway-password-0001";

test("native owner discovery refreshes stale metadata and initializes private endpoint credentials once", async () => {
  const original = parseWorkbuddySessionDescriptor({ pid: process.pid, sessionId: "exact-owner", kind: "interactive",
    lastHeartbeat: 1, processIdentity: { procStartFt: "123" } })!;
  assert.equal(original.stale, true);
  let probes = 0;
  const probe = async () => {
    probes++;
    await Promise.resolve();
    return { owners: [{ pid: process.pid, sessionId: "exact-owner", endpoint: "http://127.0.0.1:5763",
      password: PASSWORD, processStartFileTime: "123" }], warnings: [] };
  };
  try {
    const results = await Promise.all([discoverWorkbuddyOwners([original], { probe }), discoverWorkbuddyOwners([original], { probe })]);
    assert.equal(probes, 1);
    assert.equal(results[0][0].stale, false);
    assert.equal(results[0][0].deliverable, true);
    assert.equal(original.stale, true);
    assert.equal(JSON.stringify(results).includes(PASSWORD), false);
    assert.equal(await workbuddyGatewayPassword({ endpoint: "http://127.0.0.1:5763" }), PASSWORD);
    const reusedPid = { ...original, processStartFileTime: "different-process" };
    assert.equal((await discoverWorkbuddyOwners([reusedPid], { probe }))[0].deliverable, false);
  } finally { invalidateWorkbuddyGatewayPassword(); }
});

test("screenshots use official attachment fields on the original session gateway", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, "screenshot.png"); fs.writeFileSync(image, "fixture");
  const previous = process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const { impl, calls } = fakeFetch([{ status: 202, body: { runId: "image-run" } }, { status: 200, body: { active: false } }]);
    await deliverWorkbuddyMessage({ sessionId: "original-full-session", text: "Inspect screenshot", imagePaths: [image],
      endpoint: "http://127.0.0.1:5762", fetchImpl: impl });
    const sent = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(sent.source.conversation.id, "original-full-session");
    assert.deepEqual(sent.payload.attachments, [{ type: "image", urlType: "local-path", url: image, name: "screenshot.png" }]);
  } finally {
    if (previous === undefined) delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
    else process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = previous;
  }
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabi-workbuddy-bridge-"));
}

/** Minimal fetch double: records calls and replays a scripted response list. */
function fakeFetch(script: Array<{ status: number; body: unknown }>): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("loopback guard rejects non-loopback endpoints before any credential is sent", () => {
  assert.equal(assertWorkbuddyLoopback("http://127.0.0.1:5762"), "http://127.0.0.1:5762");
  assert.equal(assertWorkbuddyLoopback("http://localhost:5762"), "http://localhost:5762");
  assert.throws(() => assertWorkbuddyLoopback("http://10.0.0.5:5762"), /回环/);
  assert.throws(() => assertWorkbuddyLoopback("https://example.com"), /回环/);
  // A tunnel URL with embedded credentials must never be used as a target.
  assert.throws(() => assertWorkbuddyLoopback("http://user:pw@127.0.0.1:5762"), /不带凭据/);
});

test("run id and active flag parse from both flat and data-wrapped shapes", () => {
  assert.equal(parseWorkbuddyRunId({ runId: "r1" }), "r1");
  assert.equal(parseWorkbuddyRunId({ data: { runId: "r2" } }), "r2");
  assert.equal(parseWorkbuddyRunId({}), "");
  assert.equal(parseWorkbuddyRunId(null), "");
  assert.equal(parseWorkbuddyRunActive({ active: true }), true);
  assert.equal(parseWorkbuddyRunActive({ data: { active: false } }), false);
  assert.equal(parseWorkbuddyRunActive({}), null);
});

test("delivery uses conversation.id as the routing key and settles on poll", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const { impl, calls } = fakeFetch([
      { status: 202, body: { data: { runId: "run-1", status: "accepted" } } },
      { status: 200, body: { data: { runId: "run-1", active: true } } },
      { status: 200, body: { data: { runId: "run-1", active: false } } }
    ]);
    const result = await deliverWorkbuddyMessage({
      sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
      text: "hello task",
      endpoint: "http://127.0.0.1:5762",
      fetchImpl: impl,
      settleTimeoutMs: 5_000
    });
    assert.equal(result.ok, true);
    assert.equal(result.runId, "run-1");
    assert.equal(result.settled, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "http://127.0.0.1:5762/api/v1/runs");
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    // Mandatory fields the bundled OpenAPI spec omits.
    assert.equal(typeof sent.id, "string");
    assert.equal(sent.type, "message");
    const source = sent.source as Record<string, unknown>;
    assert.deepEqual(source.conversation, {
      id: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
      type: "direct"
    });
    assert.deepEqual(sent.payload, { text: "hello task" });
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${PASSWORD}`);
    assert.ok(calls.every(call => new Headers(call.init?.headers).get("X-CodeBuddy-Request") === "1"));
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  }
});

test("a 401 fails closed, invalidates the credential, and does not replay", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const { impl, calls } = fakeFetch([{ status: 401, body: { error: { code: "AUTH_REQUIRED" } } }]);
    await assert.rejects(
      () => deliverWorkbuddyMessage({
        sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
        text: "hello",
        endpoint: "http://127.0.0.1:5762",
        fetchImpl: impl
      }),
      (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unauthorized"
    );
    // Exactly one attempt: a rejected credential must never be retried blind.
    assert.equal(calls.length, 1);
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  }
});

test("an unreachable gateway reports a safe-to-retry outcome", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const impl = (async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }) as unknown as typeof fetch;
    await assert.rejects(
      () => deliverWorkbuddyMessage({
        sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
        text: "hello",
        endpoint: "http://127.0.0.1:5762",
        fetchImpl: impl
      }),
      (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unreachable"
    );
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  }
});

test("an accepted request with a lost response remains unknown and is sent once", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  let requests = 0;
  let failure = "socket";
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Receive the complete request before disconnecting. */ }
    requests++;
    if (failure === "server-error") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"response lost after acceptance"}');
    } else if (failure === "body") {
      response.writeHead(202, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"runId":');
      setImmediate(() => response.destroy());
    } else request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    for (const kind of ["socket", "body", "server-error"]) {
      failure = kind;
      await assert.rejects(deliverWorkbuddyMessage({ sessionId: "original-owner", text: "one request", endpoint }),
        (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unknown");
    }
    assert.equal(requests, 3);
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a 2xx without a runId is reported as unknown, not success", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const { impl } = fakeFetch([{ status: 202, body: { status: "accepted" } }]);
    await assert.rejects(
      () => deliverWorkbuddyMessage({
        sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
        text: "hello",
        endpoint: "http://127.0.0.1:5762",
        fetchImpl: impl
      }),
      (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unknown"
    );
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  }
});

test("missing credential is an actionable failure, never an unauthenticated send", async () => {
  const dir = tempDir();
  const missing = path.join(dir, "workbuddy-auth.json");
  const { impl, calls } = fakeFetch([{ status: 202, body: { data: { runId: "x" } } }]);
  process.env.RABI_WORKBUDDY_AUTH_FILE = missing;
  try {
    await assert.rejects(
      () => deliverWorkbuddyMessage({
        sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
        text: "hello",
        endpoint: "http://127.0.0.1:5762",
        fetchImpl: impl
      }),
      (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unauthorized"
    );
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.RABI_WORKBUDDY_AUTH_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty delivery text is rejected before any network call", async () => {
  process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD = PASSWORD;
  try {
    const { impl, calls } = fakeFetch([{ status: 202, body: {} }]);
    await assert.rejects(
      () => deliverWorkbuddyMessage({
        sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
        text: "   ",
        endpoint: "http://127.0.0.1:5762",
        fetchImpl: impl
      }),
      /正文为空/
    );
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.RABI_WORKBUDDY_GATEWAY_PASSWORD;
  }
});

test("turn polling returns false on timeout without failing the delivery", async () => {
  const { impl } = fakeFetch([{ status: 200, body: { data: { runId: "run-1", active: true } } }]);
  const settled = await waitForWorkbuddyTurn("http://127.0.0.1:5762", "run-1", PASSWORD, {
    fetchImpl: impl,
    timeoutMs: 0
  });
  assert.equal(settled, false);
});

test("binding reads the route config and prefers the live session endpoint", () => {
  const dir = tempDir();
  const home = path.join(dir, "home");
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "999999.json"), JSON.stringify({
    pid: process.pid, // must be a live pid: a fake one is treated as an exited owner
    sessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
    kind: "interactive",
    cwd: "C:\\work\\example",
    endpoint: "http://127.0.0.1:6762",
    lastHeartbeat: Date.now()
  }));
  const configPath = path.join(dir, "adapterConfig.json");
  fs.writeFileSync(configPath, JSON.stringify({
    workbuddySessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
    workbuddySessionName: "Rabi 任务",
    workbuddyCwd: "C:\\work\\example",
    // Persisted port is stale by design; the live descriptor must win.
    workbuddyEndpoint: "http://127.0.0.1:1111"
  }));
  process.env.RABI_WORKBUDDY_HOME = home;
  try {
    const binding = readWorkbuddyPrimaryBinding(configPath);
    assert.ok(binding);
    assert.equal(binding.sessionId, "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e");
    assert.equal(binding.endpoint, "http://127.0.0.1:6762");
  } finally {
    delete process.env.RABI_WORKBUDDY_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("binding returns null when the route has no WorkBuddy task", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "adapterConfig.json");
  fs.writeFileSync(configPath, JSON.stringify({ codexPrimaryWorkspace: "C:\\work\\example" }));
  try {
    assert.equal(readWorkbuddyPrimaryBinding(configPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a task with no live owner fails closed instead of starting a replacement", () => {
  const dir = tempDir();
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const dbPath = path.join(home, "workbuddy.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
    is_playground INTEGER, is_background_automation INTEGER, mode TEXT, model TEXT
  )`);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e", "C:\\work\\example", "任务", null,
    "completed", Date.now(), Date.now(), Date.now(), null, 0, 0, "craft", "m"
  );
  db.close();
  const configPath = path.join(dir, "adapterConfig.json");
  fs.writeFileSync(configPath, JSON.stringify({
    workbuddySessionId: "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
    workbuddyCwd: "C:\\work\\example",
    workbuddyEndpoint: "http://127.0.0.1:6762"
  }));
  process.env.RABI_WORKBUDDY_HOME = home;
  try {
    const binding = readWorkbuddyPrimaryBinding(configPath);
    assert.ok(binding, "the persisted endpoint is present, so the binding is readable");
    // Liveness is re-checked at delivery time, where the missing descriptor
    // must surface as a hard failure.
    assert.throws(
      () => ensureWorkbuddyDeliverable(binding),
      (error: unknown) => error instanceof WorkbuddyDeliveryError && error.outcome === "unreachable"
    );
  } finally {
    delete process.env.RABI_WORKBUDDY_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
