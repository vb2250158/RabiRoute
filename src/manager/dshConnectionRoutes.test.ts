import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import { dshConnectionRequestAllowed, handleDshConnectionRequest } from "./dshConnectionRoutes.js";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DshConnectionStore } from "../dshConnectionStore.js";

test("DSH metadata and disconnect API fence revisions without exposing secrets or reviving legacy auth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-route-"));
  const store = new DshConnectionStore(path.join(root, "connections.json"), { scheme: "test", protect: value => value, unprotect: value => value });
  const origin = "http://127.0.0.1:39277";
  const make = (method: string, body?: unknown) => Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method, headers: { host: "127.0.0.1:12345", origin: "http://127.0.0.1:12345", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }
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

const request = (address: string, headers: http.IncomingHttpHeaders) => ({ socket: { remoteAddress: address }, headers }) as Pick<http.IncomingMessage, "socket" | "headers">;
test("DSH authorization mutations require a same-origin local browser; Relay and rebinding fail closed", () => {
  const headers = { host: "127.0.0.1:12345", origin: "http://127.0.0.1:12345" };
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", headers), true), true);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { host: headers.host }), true), false);
  assert.equal(dshConnectionRequestAllowed(request("192.0.2.1", headers), true), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, origin: "http://attacker.invalid" }), true), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { host: "attacker.invalid", origin: "http://attacker.invalid" }), true), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, "x-forwarded-for": "192.0.2.1" }), true), false);
  assert.equal(dshConnectionRequestAllowed(request("127.0.0.1", { ...headers, "sec-fetch-site": "cross-site" }), true), false);
});
