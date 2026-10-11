import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { issueInternalManagerHopHeaders, validateInternalManagerHop } from "./internalManagerHop.js";

const input = { kind: "peer" as const, generation: "fixture-generation", scope: "a".repeat(64), deviceId: "eye:one", method: "POST", target: "/api/future/resource?flag" };
function request(headers: Record<string, string>, address = "127.0.0.1") {
  const socket = new Socket(); Object.defineProperty(socket, "remoteAddress", { value: address });
  const req = new IncomingMessage(socket); req.method = input.method; req.url = input.target; req.headers = { ...headers };
  return req;
}
test("internal hop admits a signed request repeatedly but rejects a new request replay", () => {
  const headers = issueInternalManagerHopHeaders(input), req = request(headers);
  const claims = validateInternalManagerHop(req, input);
  assert.equal(claims?.deviceId, input.deviceId); assert.equal(claims?.kind, "peer");
  assert.equal(Object.isFrozen(claims), true); assert.equal(validateInternalManagerHop(req, input), claims);
  assert.equal(validateInternalManagerHop(request(headers), input), null);
  assert.equal(validateInternalManagerHop(req, { ...input, generation: "next-generation" }), null);
  assert.equal(validateInternalManagerHop(req, { ...input, scope: "b".repeat(64) }), null);
});
test("raw loopback identity, authenticated-connection markers, or remote signed requests cannot attest a hop", () => {
  const headers = issueInternalManagerHopHeaders(input);
  const raw = { ...headers }; delete raw["x-rabilink-internal-hop"];
  assert.equal(validateInternalManagerHop(request(raw), input), null);
  assert.equal(validateInternalManagerHop(request(headers, "192.0.2.1"), input), null);
  assert.equal(validateInternalManagerHop(request({ ...headers, "x-rabiroute-relay-proxy": "1" }), input), null);
});
test("MAC binds all claims and the actual method, raw path, identity, and proof", () => {
  for (const field of ["kind", "generation", "scope", "deviceId", "method", "target", "nonce", "issuedAt"]) {
    const headers = issueInternalManagerHopHeaders(input), [encoded, signature] = headers["x-rabilink-internal-hop"].split(".");
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString());
    value[field] = field === "issuedAt" ? value[field] + 1 : String(value[field]) + "tampered";
    headers["x-rabilink-internal-hop"] = Buffer.from(JSON.stringify(value)).toString("base64url") + "." + signature;
    assert.equal(validateInternalManagerHop(request(headers), input), null, field);
  }
  for (const mutate of [
    (req: IncomingMessage) => { req.method = "GET"; },
    (req: IncomingMessage) => { req.url = input.target + "=other"; },
    (req: IncomingMessage) => { req.headers["x-rabilink-tunnel-device-id"] = "eye:other"; },
    (req: IncomingMessage) => { req.headers["x-rabilink-tunnel-local"] = "next-generation"; },
    (req: IncomingMessage) => { req.headers["x-rabiroute-peer-proxy"] = "0"; },
    (req: IncomingMessage) => { req.headers["x-rabilink-internal-hop"] = "malformed"; }
  ]) {
    const req = request(issueInternalManagerHopHeaders(input));
    assert.ok(validateInternalManagerHop(req, input)); mutate(req);
    assert.equal(validateInternalManagerHop(req, input), null);
  }
});
test("expired proofs cannot admit requests while an admitted stream retains only its current fences", t => {
  const start = Date.now(); let now = start; t.mock.method(Date, "now", () => now);
  const headers = issueInternalManagerHopHeaders(input), req = request(headers);
  assert.ok(validateInternalManagerHop(req, input)); now += 31_001;
  assert.equal(validateInternalManagerHop(request(headers), input), null);
  assert.ok(validateInternalManagerHop(req, input));
  assert.equal(validateInternalManagerHop(req, { ...input, scope: "b".repeat(64) }), null);
  now = start - 1_001;
  assert.equal(validateInternalManagerHop(request(headers), input), null);
});
test("Relay application and device identities both require their own fresh proof", () => {
  for (const deviceId of ["$application", "eye:one"]) {
    const value = { ...input, kind: "relay" as const, deviceId };
    const claims = validateInternalManagerHop(request(issueInternalManagerHopHeaders(value), "::ffff:127.0.0.1"), value);
    assert.equal(claims?.kind, "relay"); assert.equal(claims?.deviceId, deviceId);
  }
  assert.throws(() => issueInternalManagerHopHeaders({ ...input, target: "//outside.test/path" }));
});

test("owned authority is rechecked before admission and after proof-cache cleanup", t => {
  let now = Date.now(), active = true; t.mock.method(Date, "now", () => now);
  const header = issueInternalManagerHopHeaders(input, () => active);
  active = false;
  assert.equal(validateInternalManagerHop(request(header), input), null);
  active = true;
  const req = request(header);
  assert.ok(validateInternalManagerHop(req, input));
  now += 32_000;
  issueInternalManagerHopHeaders(input); // Trigger bounded nonce/guard-table cleanup.
  assert.ok(validateInternalManagerHop(req, input));
  active = false;
  assert.equal(validateInternalManagerHop(req, input), null);
  assert.throws(() => issueInternalManagerHopHeaders(input, () => false));
});

test("original authentication time is MAC-bound and is never refreshed by hop issuance", t => {
  const now = Date.now(); t.mock.method(Date, "now", () => now);
  const authenticatedAt = now - 44_000;
  const header = issueInternalManagerHopHeaders({ ...input, authenticatedAt });
  assert.equal(validateInternalManagerHop(request(header), input)?.authenticatedAt, authenticatedAt);
  const [encoded, signature] = header["x-rabilink-internal-hop"].split(".");
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString()); value.authenticatedAt = now;
  const tampered = { ...header, "x-rabilink-internal-hop": Buffer.from(JSON.stringify(value)).toString("base64url") + "." + signature };
  assert.equal(validateInternalManagerHop(request(tampered), input), null);
  assert.throws(() => issueInternalManagerHopHeaders({ ...input, authenticatedAt: now + 1 }));
  assert.throws(() => issueInternalManagerHopHeaders({ ...input, authenticatedAt: 1.5 }));
});
