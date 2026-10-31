import assert from "node:assert/strict";
import type http from "node:http";
import test, { type TestContext } from "node:test";
import { dshConnectionRequestAllowed, handleDshConnectionRequest } from "./dshConnectionRoutes.js";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshConnectionStore } from "../dshConnectionStore.js";
import { createHash } from "node:crypto";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

test("local Agent without Origin connects with the target login and preserves its original expiry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-browser-route-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: value => Buffer.from(value).toString("base64"), unprotect: value => Buffer.from(value, "base64").toString("utf8")
  });
  const origin = "http://127.0.0.1:39277";
  const authority = new URL(origin).host;
  const name = `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}`;
  const expiresAt = Date.now() + 60_000;
  const value = (payload: unknown) => `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixtureSignature`;
  const valid = `${name}=${value({ version: 1, authority, issuedAt: Date.now() - 1000, expiresAt })}`;
  const url = new URL("http://127.0.0.1:12345/api/agent-adapters/dsh/connection");
  const make = (cookie: string, expectedRevision: number, baseUrl = origin) => Object.assign(Readable.from([JSON.stringify({ baseUrl, expectedRevision })]), {
    method: "POST", headers: { host: url.host, cookie, "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }
  }) as unknown as http.IncomingMessage;
  const priorFetch = globalThis.fetch;
  let calls = 0;
  let reject = false;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), `${origin}/api/session/list`);
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("cookie"), valid);
      if (reject) return new Response(null, { status: 401 });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.method, "session/list");
      return Response.json({ rpcId: body.rpcId, result: { ok: true } });
    };
    const result = await handleDshConnectionRequest(make(`unrelated=private; dsh-auth-other=private; ${valid}`, 0), url, store);
    assert.equal(result.connection?.state, "connected");
    assert.ok(result.connection && "expiresAt" in result.connection);
    assert.equal(result.connection.expiresAt, expiresAt);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /cookie|fixtureSignature|private/);
    assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /fixtureSignature/);
    // Saved login works even in a browser with no DSH cookie.
    await handleDshConnectionRequest(make("", 1), url, store);
    assert.equal(calls, 2);
    store.disconnect(origin, 2);
    await assert.rejects(handleDshConnectionRequest(make("", 3), url, store), /Reconnect/);
    await assert.rejects(handleDshConnectionRequest(make(valid, 3, "http://localhost:39277"), url, store), /Log in/);
    await assert.rejects(handleDshConnectionRequest(make(`${valid}; ${valid}`, 3), url, store), /invalid/);
    const expired = `${name}=${value({ version: 1, authority, issuedAt: Date.now() - 2000, expiresAt: Date.now() - 1000 })}`;
    await assert.rejects(handleDshConnectionRequest(make(expired, 3), url, store), /expired/);
    const wrongAuthority = `${name}=${value({ version: 1, authority: "127.0.0.1:9999", issuedAt: Date.now() - 1000, expiresAt })}`;
    await assert.rejects(handleDshConnectionRequest(make(wrongAuthority, 3), url, store), /invalid/);
    assert.equal(calls, 2);
    reject = true;
    await assert.rejects(handleDshConnectionRequest(make(valid, 3), url, store), /rejected/);
    assert.equal(calls, 3);
    assert.equal(store.resolve(origin)?.state, "disconnected");
    reject = false;
    // Only explicit reconnect with a valid login can replace a disconnected record.
    await handleDshConnectionRequest(make(valid, 3), url, store);
    assert.equal(store.resolve(origin)?.state, "connected");
    assert.equal(calls, 4);
    await assert.rejects(handleDshConnectionRequest(make(valid, 3), url, store), /changed/);
    assert.equal(calls, 4);
  } finally { globalThis.fetch = priorFetch; fs.rmSync(root, { recursive: true, force: true }); }
});

test("DSH metadata and disconnect API fence revisions without exposing secrets or reviving legacy auth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-route-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), { scheme: "test", protect: value => value, unprotect: value => value });
  const origin = "http://127.0.0.1:39277";
  const make = (method: string, body?: unknown) => Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method, headers: { host: "127.0.0.1:12345", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }
  }) as unknown as http.IncomingMessage;
  const url = new URL("http://127.0.0.1:12345/api/agent-adapters/dsh/connection");
  try {
    const empty = await handleDshConnectionRequest(make("GET"), new URL(`${url}s`), store);
    assert.equal(empty.revision, 0);
    await handleDshConnectionRequest(make("DELETE", { baseUrl: origin, expectedRevision: 0 }), url, store);
    assert.equal(store.resolve(origin)?.state, "disconnected");
    await assert.rejects(handleDshConnectionRequest(make("DELETE", { baseUrl: origin, expectedRevision: 0 }), url, store), /changed/);
    await assert.rejects(handleDshConnectionRequest(make("DELETE", { baseUrl: origin }), url, store), /revision/);
    await assert.rejects(handleDshConnectionRequest(make("POST", { launchUrl: "fixture", baseUrl: origin, expectedRevision: 1 }), url, store), /one DSH/);
    const meta = await handleDshConnectionRequest(make("GET"), new URL(`${url}?baseUrl=${encodeURIComponent(origin)}`), store);
    assert.equal(meta.revision, 1);
    assert.doesNotMatch(JSON.stringify(meta), /cookie|token|protectedCredential/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const request = (address: string, headers: http.IncomingHttpHeaders) => ({ socket: { remoteAddress: address }, headers }) as http.IncomingMessage;
test("DSH local requests allow an absent Origin while preserving browser and proxy checks", () => {
  const headers = { host: "127.0.0.1:12345", origin: "http://127.0.0.1:12345" };
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", headers)), true);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { host: headers.host })), true);
  assert.equal(dshConnectionRequestAllowed(request("192.0.2.1", headers)), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, origin: "http://attacker.invalid" })), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { host: "attacker.invalid", origin: "http://attacker.invalid" })), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, "x-forwarded-for": "192.0.2.1" })), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, "sec-fetch-site": "cross-site" })), false);
});

function connectionFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-connection-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DshConnectionStore(path.join(root, "connections.json"), {
    scheme: "test", protect: value => value, unprotect: value => value
  });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const url = new URL("http://manager.example/api/agent-adapters/dsh/connection");
  const body = { baseUrl: "http://127.0.0.1:39277", expectedRevision: 0 };
  let policy = { enabled: true, incarnation: "initial" };
  let connectionActive = true;
  const make = (kind: "agent" | "connection", beforeBody?: () => void) => {
    const input = Object.assign(Readable.from((async function* () {
      beforeBody?.();
      yield JSON.stringify(body);
    })()), {
      method: "DELETE", url: url.pathname,
      headers: { host: url.host, "content-type": "application/json" } as http.IncomingHttpHeaders,
      socket: { remoteAddress: "192.0.2.1" }
    }) as unknown as http.IncomingMessage;
    if (kind === "agent") {
      input.headers.authorization = `Bearer ${credential.token}`;
      input.headers["x-rabiroute-agent-id"] = "fixture-agent";
      assert.equal(evaluateLanAgentRequest(input, authority, true, () => policy).kind, "agent");
    } else {
      input.headers["x-rabilink-tunnel-local"] = "fixture-transport";
      markAuthenticatedConnectionRequest(input, () => {
        if (!connectionActive) throw new Error("Connection was revoked.");
      });
    }
    return input;
  };
  return { store, authority, url, body, make,
    replacePolicy: () => { policy = { enabled: true, incarnation: "replacement" }; },
    revokeConnection: () => { connectionActive = false; } };
}

test("enabled remote Agent and authenticated RabiLink connection can save DSH settings without Origin", async t => {
  for (const kind of ["agent", "connection"] as const) {
    const fixture = connectionFixture(t);
    const result = await handleDshConnectionRequest(fixture.make(kind), fixture.url, fixture.store);
    assert.equal(result.revision, 1);
    const reread = new DshConnectionStore(fixture.store.filePath, {
      scheme: "test", protect: value => value, unprotect: value => value
    });
    assert.equal(reread.resolve(fixture.body.baseUrl)?.state, "disconnected");
  }
});

test("DSH body wait cannot write after Agent or connection authority is revoked or replaced", async t => {
  for (const variant of ["agent-revoke", "agent-aba", "global-aba", "connection"] as const) {
    const fixture = connectionFixture(t);
    const input = fixture.make(variant === "connection" ? "connection" : "agent", () => {
      if (variant === "connection") fixture.revokeConnection();
      else if (variant === "global-aba") fixture.replacePolicy();
      else { fixture.authority.revokeNode("fixture-node"); }
    });
    await assert.rejects(handleDshConnectionRequest(input, fixture.url, fixture.store), { status: 403 });
    assert.equal(fixture.store.readMetadata().revision, 0);
    assert.equal(fs.existsSync(fixture.store.filePath), false);
  }
});

test("DSH authorization ignores copied connection identities and rejects forged Agent or Relay headers", () => {
  const remote = request("192.0.2.1", { host: "manager.example", "x-rabilink-tunnel-local": "forged" });
  assert.equal(dshConnectionRequestAllowed(remote), false);
  markAuthenticatedConnectionRequest(remote);
  assert.equal(dshConnectionRequestAllowed(remote), true);
  assert.equal(dshConnectionRequestAllowed({ ...remote } as http.IncomingMessage), false);
  const local = request("127.0.0.1", { host: "127.0.0.1:12345", "x-rabiroute-agent-id": "forged" });
  markAuthenticatedConnectionRequest(local);
  assert.equal(dshConnectionRequestAllowed(local), false);
});
