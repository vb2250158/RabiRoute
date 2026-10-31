import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { issueInternalManagerHopHeaders } from "../shared/internalManagerHop.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { createDevicePeerBootstrapOperation, DEVICE_PEER_BOOTSTRAP_PATH, type DevicePeerBootstrapAuthority } from "./devicePeerBootstrapRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

const source = "glasses-0123456789abcdef", target = "pc-owner", scope = "a".repeat(64), generation = "manager-generation";
const body = (expiresAt = Date.now() + 40_000) => ({ source, target, publicKey: "Runtime validates actual Ed25519 key", expiresAt,
  nonce: "n".repeat(32), signature: "Runtime validates signed canonical fields" });
function headers(overrides: Partial<Parameters<typeof issueInternalManagerHopHeaders>[0]> = {}) {
  return issueInternalManagerHopHeaders({ kind: "relay", generation, scope, deviceId: source, method: "POST",
    target: DEVICE_PEER_BOOTSTRAP_PATH, authenticatedAt: Date.now(), ...overrides });
}
async function fixture(options: {
  afterBody?: (request: IncomingMessage, state: State) => void | Promise<void>;
  bootstrap?: (authority: DevicePeerBootstrapAuthority, state: State) => Promise<void>;
} = {}) {
  const state: State = { active: true, current: { scope, generation, deviceId: target }, reads: 0, writes: 0 };
  const owner = createDevicePeerBootstrapOperation({ current: () => state.current,
    bootstrap: async (_input, authority) => {
      await options.bootstrap?.(authority, state);
      authority.assertCurrent(); state.writes++; state.lastAuthority = authority;
      return { deviceId: target, sourceDeviceId: authority.sourceDeviceId, publicKey: "fixture-public-key", generation: "peer-generation", managerGeneration: generation, expiresAt: body().expiresAt, epoch: "fixture-epoch" };
    }
  });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("peer", [{ ...owner.operation, prepare: async input => {
    const prepared = await owner.operation.prepare!(input);
    if (typeof prepared !== "function") return prepared;
    state.reads++;
    return async body => { await options.afterBody?.(input.request, state); return prepared(body); };
  } }]);
  const route = { stop: owner.stop, drain: () => registration.dispose() };
  const server = createServer((request, response) => {
    markAuthenticatedConnectionRequest(request, () => { if (!state.active) throw new Error("Original ingress revoked"); });
    const handled = registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response);
    assert.equal(typeof handled, "boolean");
    if (!handled) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { route, state,
    async send(input: unknown = body(), signature = headers(), method = "POST", pathname = DEVICE_PEER_BOOTSTRAP_PATH) {
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { method,
        headers: { "content-type": "application/json", ...signature }, ...(method === "GET" ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: response.status === 404 ? undefined : await response.json() };
    },
    async close() { route.stop(); await route.drain(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
type State = { active: boolean; current: { scope: string; generation: string; deviceId: string }; reads: number; writes: number; lastAuthority?: DevicePeerBootstrapAuthority };

test("device bootstrap matcher is synchronous, exact and does not consume other routes", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send({}, {}, "POST", "/other-route")).status, 404);
    assert.equal((await f.send({}, {}, "GET")).status, 405);
    assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("real HTTP admits only current signed Relay device and retains original authenticated timestamp", async () => {
  const f = await fixture();
  try {
    const authenticatedAt = Date.now() - 5000;
    const result = await f.send(body(authenticatedAt + 40_000), headers({ authenticatedAt }));
    assert.equal(result.status, 200); assert.equal(result.cacheControl, "no-store");
    assert.equal(f.state.writes, 1); assert.equal(f.state.lastAuthority?.issuedAt, authenticatedAt);
    assert.equal(f.state.lastAuthority?.sourceDeviceId, source); assert.equal(f.state.lastAuthority?.scope, scope);
  } finally { await f.close(); }
});

test("device bootstrap preserves provider extensions and the native absence of an application body cap", async () => {
  const f = await fixture();
  try { assert.equal((await f.send({ ...body(), extension: "x".repeat(100000) })).status, 200); assert.equal(f.state.writes, 1); }
  finally { await f.close(); }
});

test("real HTTP denies peer, application, missing original authentication and bare or changed headers before body", async () => {
  const f = await fixture();
  try {
    const wrongHeaders = [
      {}, { "x-rabilink-tunnel-local": generation, "x-rabilink-tunnel-device-id": source, "x-rabiroute-relay-proxy": "1" },
      headers({ kind: "peer" }), headers({ deviceId: "$application" }), headers({ scope: "b".repeat(64) }),
      headers({ generation: "old-generation" }), headers({ deviceId: "phone-fixture" }), headers({ authenticatedAt: undefined }),
      { ...headers(), "x-rabilink-tunnel-device-id": "glasses-fedcba9876543210" }
    ];
    for (const value of wrongHeaders) assert.equal((await f.send(body(), value)).status, 403);
    assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("real HTTP body cannot change source, target, absolute expiry or nonce", async () => {
  const f = await fixture();
  try {
    for (const input of [null, [], { ...body(), source: "glasses-fedcba9876543210" }, { ...body(), target: "another-pc" },
      body(Date.now() - 1), body(Date.now() + 60_000), { ...body(), nonce: "short" }]) {
      assert.equal((await f.send(input)).status, 400);
    }
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("late original authorization cannot obtain a new lease from a fresh local hop", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send(body(), headers({ authenticatedAt: Date.now() - 46_000 }))).status, 400);
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test("same internal signature cannot admit a second HTTP request", async () => {
  const f = await fixture();
  try {
    const proof = headers();
    assert.equal((await f.send(body(), proof)).status, 200);
    assert.equal((await f.send(body(), proof)).status, 403);
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

for (const mutation of ["revoke", "scope", "generation", "source"] as const) {
  test(`body-await fence rejects original ${mutation} change before crypto owner`, async () => {
    const f = await fixture({ afterBody: async (request, state) => {
      await Promise.resolve();
      if (mutation === "revoke") state.active = false;
      if (mutation === "scope") state.current = { ...state.current, scope: "b".repeat(64) };
      if (mutation === "generation") state.current = { ...state.current, generation: "replacement-generation" };
      if (mutation === "source") request.headers["x-rabilink-tunnel-device-id"] = "glasses-fedcba9876543210";
    } });
    try { assert.equal((await f.send()).status, 403); assert.equal(f.state.writes, 0); }
    finally { await f.close(); }
  });
}

test("crypto-await authority rechecks revocation immediately before its state write", async () => {
  const f = await fixture({ bootstrap: async (_authority, state) => { await Promise.resolve(); state.active = false; } });
  try { assert.equal((await f.send()).status, 403); assert.equal(f.state.writes, 0); }
  finally { await f.close(); }
});

test("stop invalidates pending grant and drain waits for the original body task", async () => {
  let release!: () => void, entered!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture({ afterBody: async () => { entered(); await block; } });
  try {
    const response = f.send(); await started; f.route.stop();
    let drained = false; const drain = f.route.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false); release();
    assert.equal((await response).status, 403); await drain; assert.equal(f.state.writes, 0);
  } finally { release(); await f.close(); }
});
