import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeerTunnelRuntime } from "./runtime.js";
import { isTunnelPublicKey, loadTunnelIdentity } from "./security.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rabi-tunnel-readonly-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function options(dataDir: string, readOnly = true) {
  return {
    dataDir, deviceId: "test-pc", generation: "test-generation", readOnly,
    allowApplicationConnection: () => true,
    discover: async () => [],
    signal: async () => { throw new Error("Read-only runtime must not signal peers."); },
    relay: () => ({ url: "https://relay.example.test", token: "test-application-token" }),
    services: () => ({}), onStatus: () => {}
  };
}

function request(runtime: PeerTunnelRuntime, action: string, method = "GET") {
  return new Promise<{ status: number; body: unknown }>(resolve => {
    let status = 0, headersSent = false;
    const incoming = { method, socket: { remoteAddress: "127.0.0.1" } } as http.IncomingMessage;
    const response = {
      get headersSent() { return headersSent; },
      writeHead(value: number) { status = value; headersSent = true; },
      end(value: string) { resolve({ status, body: JSON.parse(value) }); }
    } as http.ServerResponse;
    assert.equal(runtime.handler(incoming, new URL("http://localhost/api/rabilink/peer/" + action), response,
      async () => { throw new Error("Read-only runtime must not read a mutation body."); }), true);
  });
}

test("read-only runtime serves status and denies mutations without creating identity files", async t => {
  const root = fixture(t), dataDir = path.join(root, "missing", "rabilink");
  const runtime = new PeerTunnelRuntime(options(dataDir));
  t.after(() => runtime.stop());
  assert.equal(existsSync(dataDir), false);
  runtime.startLanDiscovery(12345);
  assert.equal(Reflect.get(runtime, "bonjour"), undefined);
  assert.equal(isTunnelPublicKey(runtime.identity.publicKey), true);
  assert.deepEqual(await request(runtime, "identity"), { status: 200, body: {
    deviceId: "test-pc", generation: "test-generation", publicKey: runtime.identity.publicKey
  } });
  assert.deepEqual(await request(runtime, "selection"), { status: 200, body: { selectedDeviceId: "" } });
  assert.deepEqual(await request(runtime, "servers"), { status: 200, body: { selectedDeviceId: "", peers: [] } });
  for (const [action, method] of [["selection", "PUT"], ["probe", "POST"], ["http/peer/manager/meta", "GET"]]) {
    assert.deepEqual(await request(runtime, action, method), { status: 423, body: { error: "manager_read_only" } });
  }
  await assert.rejects(runtime.select(""), /manager_read_only/);
  await assert.rejects(runtime.offer({}), /manager_read_only/);
  await assert.rejects(runtime.ensureApplicationConnection("peer"), /manager_read_only/);
  await assert.rejects(runtime.session("peer"), /manager_read_only/);
  const next = new PeerTunnelRuntime(options(dataDir));
  t.after(() => next.stop());
  assert.notEqual(next.identity.publicKey, runtime.identity.publicKey);
  assert.deepEqual(readdirSync(root), []);
});

test("read-only runtime preserves saved selection when no identity exists", async t => {
  const dataDir = fixture(t), file = path.join(dataDir, "tunnel.json");
  const bytes = JSON.stringify({ selectedDeviceId: "saved-peer", trustedDevices: [], services: {} });
  writeFileSync(file, bytes);
  const runtime = new PeerTunnelRuntime(options(dataDir));
  t.after(() => runtime.stop());
  assert.deepEqual(await request(runtime, "selection"), { status: 200, body: { selectedDeviceId: "saved-peer" } });
  assert.deepEqual(await request(runtime, "servers"), { status: 200, body: { selectedDeviceId: "saved-peer", peers: [] } });
  await assert.rejects(runtime.select(""), /manager_read_only/);
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.deepEqual(readdirSync(dataDir), ["tunnel.json"]);
});

test("read-only runtime retains and validates an existing identity without rewriting it", async t => {
  const dataDir = fixture(t), file = path.join(dataDir, "tunnel-identity.json");
  const saved = loadTunnelIdentity(file, "old-device", "old-generation");
  const before = readFileSync(file), beforeStat = statSync(file);
  const runtime = new PeerTunnelRuntime(options(dataDir));
  t.after(() => runtime.stop());
  assert.equal(runtime.identity.publicKey, saved.publicKey);
  assert.equal(runtime.identity.privateKey, saved.privateKey);
  assert.equal(runtime.identity.deviceId, "test-pc");
  assert.equal(runtime.identity.generation, "test-generation");
  await request(runtime, "identity");
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(readdirSync(dataDir), ["tunnel-identity.json"]);
});

test("read-only runtime fails closed on corrupt and mismatched persisted identities", t => {
  const dataDir = fixture(t), file = path.join(dataDir, "tunnel-identity.json");
  const a = loadTunnelIdentity(file, "a", "test");
  const b = loadTunnelIdentity(path.join(dataDir, "other.json"), "b", "test");
  for (const [bytes, expected] of [
    ["not-json", SyntaxError],
    [JSON.stringify({ privateKey: a.privateKey, publicKey: b.publicKey }), /Invalid tunnel identity/]
  ] as const) {
    writeFileSync(file, bytes);
    assert.throws(() => new PeerTunnelRuntime(options(dataDir)), expected);
    assert.equal(readFileSync(file, "utf8"), bytes);
  }
});

test("normal runtime still persists and reuses its identity", t => {
  const dataDir = path.join(fixture(t), "normal"), file = path.join(dataDir, "tunnel-identity.json");
  const first = new PeerTunnelRuntime(options(dataDir, false));
  t.after(() => first.stop());
  const bytes = readFileSync(file);
  assert.equal(JSON.parse(bytes.toString()).publicKey, first.identity.publicKey);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const second = new PeerTunnelRuntime(options(dataDir, false));
  t.after(() => second.stop());
  assert.deepEqual(second.identity, first.identity);
  assert.deepEqual(readFileSync(file), bytes);
});

test("identity loader still fails closed when creation is explicitly disabled", t => {
  const dataDir = path.join(fixture(t), "missing"), file = path.join(dataDir, "tunnel-identity.json");
  assert.throws(() => loadTunnelIdentity(file, "pc", "test", { create: false }), { code: "ENOENT" });
  assert.throws(() => loadTunnelIdentity(file, "pc", "test", { create: false, persist: false }), { code: "ENOENT" });
  assert.equal(existsSync(dataDir), false);
});
