import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { discoverManager, createDiscoveryCooldown } from "../lib/manager-discovery.mjs";
import { createEndpointSession, businessReady } from "../lib/endpoint-session.mjs";

for (const failure of ["timeout", "generation", "guid"]) {
  test(`final endpoint verification fails closed on ${failure}`, async () => {
    const config = { managerUrl: "http://localhost:5432", managerGuid: "stable", nodeId: "node", nodeCredential: "fixture-credential", applicationGenerationId: "old", managerInstanceId: "old" };
    let publicReads = 0;
    const session = createEndpointSession({ config, discover: async () => null, fetchImpl: async url => {
      const identity = { guid: "stable", applicationGenerationId: "new", managerInstanceId: "instance" };
      if (url.endsWith("/.well-known/rabiroute-manager")) {
        if (++publicReads > 1) {
          if (failure === "timeout") throw new Error("verification timed out");
          if (failure === "generation") identity.applicationGenerationId = "changed";
          if (failure === "guid") identity.guid = "other";
        }
        return Response.json({ code: 0, data: { protocolVersion: "1", ...identity } });
      }
      if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: "node" } });
      if (url.endsWith("/meta")) return Response.json({ rabiGuid: identity.guid, applicationGenerationId: identity.applicationGenerationId, managerInstanceId: identity.managerInstanceId, health: { live: true, requiredReady: true, state: "healthy" } });
      throw new Error("Unexpected request");
    } });
    await assert.rejects(session.ensure());
    assert.equal(publicReads, 2);
    assert.deepEqual(session.config, config);
  });
}

test("concurrent diagnostics do not inherit business readiness rejection", async () => {
  const identity = { guid: "stable", applicationGenerationId: "generation", managerInstanceId: "instance" };
  const session = createEndpointSession({ config: { managerUrl: "http://manager.invalid", managerGuid: "stable", nodeId: "node", nodeCredential: "fixture" }, fetchImpl: async url => {
    if (url.endsWith("/.well-known/rabiroute-manager")) return Response.json({ code: 0, data: { ...identity, protocolVersion: 1 } });
    if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: "node" } });
    return Response.json({ ...identity, rabiGuid: identity.guid, health: { live: true, requiredReady: false, state: "starting" } });
  } });
  const [business, diagnostic] = await Promise.allSettled([session.ensure(), session.ensure({ diagnostic: true })]);
  assert.equal(business.status, "rejected");
  assert.equal(diagnostic.status, "fulfilled");
});

test("identity read accepts the current Manager metadata envelope", async () => {
  const identity = { guid: "stable", applicationGenerationId: "generation", managerInstanceId: "instance" };
  const session = createEndpointSession({ config: { managerGuid: "stable", nodeCredential: "fixture" }, fetchImpl: async url =>
    url.endsWith("/.well-known/rabiroute-manager")
      ? Response.json({ code: 0, data: { protocolVersion: 1, ...identity } })
      : Response.json({ code: 0, data: { rabiGuid: identity.guid, ...identity } }) });
  assert.equal((await session.identity("http://manager.invalid")).managerInstanceId, identity.managerInstanceId);
});

test("business readiness requires an explicit live signal", () => {
  for (const live of [undefined, false]) assert.equal(businessReady({ health: { live, requiredReady: true, state: "healthy" } }), false);
  assert.equal(businessReady({ health: { live: true, requiredReady: true, state: "degraded" } }), true);
});

test("DNS-SD discovery returns dynamic endpoint and fences identity", async () => {
  const result = await discoverManager({ expected: { generation: "g", instance: "i", guid: "u" }, browse: async () => [{ port: 5432, addresses: ["192.168.1.4"], txt: { protocol: "1", generation: "g", instance: "i", guid: "u" } }], fetchImpl: async url => { assert.equal(url, "http://192.168.1.4:5432/.well-known/rabiroute-manager"); return Response.json({ code: 0, data: { protocolVersion: "1", applicationGenerationId: "g", managerInstanceId: "i", guid: "u", version: "x" } }); } });
  assert.equal(result.managerUrl, "http://192.168.1.4:5432");
});

test("multiple verified interfaces of one generation are not ambiguous", async () => {
  const result = await discoverManager({ expected: { guid: "stable" }, browse: async () => [
    { port: 5432, addresses: ["192.168.1.4", "10.0.0.4"], txt: { protocol: "1", applicationGenerationId: "g", managerInstanceId: "i", guid: "stable" } }
  ], fetchImpl: async () => Response.json({ code: 0, data: { protocolVersion: 1, guid: "stable", applicationGenerationId: "g", managerInstanceId: "i" } }) });
  assert.ok(result);
});

test("different live generations of the same stable GUID stay ambiguous", async () => {
  const result = await discoverManager({ expected: { guid: "stable" }, browse: async () => [
    { port: 5432, addresses: ["192.168.1.4"], txt: { protocol: "1", generation: "g1", instance: "i1", guid: "stable" } },
    { port: 5433, addresses: ["192.168.1.5"], txt: { protocol: "1", generation: "g2", instance: "i2", guid: "stable" } }
  ], fetchImpl: async url => Response.json({ code: 0, data: { protocolVersion: 1, guid: "stable", applicationGenerationId: url.includes(":5432") ? "g1" : "g2", managerInstanceId: url.includes(":5432") ? "i1" : "i2" } }) });
  assert.equal(result, null);
});

test("an unreachable extra interface does not discard a verified endpoint at the deadline", async () => {
  const result = await discoverManager({ expected: { guid: "stable" }, timeoutMs: 60,
    browse: async () => [{ port: 5432, addresses: ["192.168.1.4", "10.0.0.4"], txt: { protocol: "1", generation: "g", instance: "i", guid: "stable" } }],
    fetchImpl: async (url, { signal }) => {
      if (url.includes("10.0.0.4")) return new Promise((_, reject) => {
        const deadline = setTimeout(() => reject(new Error("fixture deadline")), 70);
        signal.addEventListener("abort", () => { clearTimeout(deadline); reject(signal.reason); }, { once: true });
      });
      return Response.json({ code: 0, data: { protocolVersion: 1, guid: "stable", applicationGenerationId: "g", managerInstanceId: "i" } });
    } });
  assert.equal(result?.managerUrl, "http://192.168.1.4:5432");
});

test("identity mismatch is rejected", async () => {
  const result = await discoverManager({ browse: async () => [{ port: 1, addresses: ["10.0.0.2"], txt: { protocol: "1", generation: "g", instance: "i", guid: "u" } }], fetchImpl: async () => Response.json({ code: 0, data: { protocolVersion: "1", applicationGenerationId: "other", managerInstanceId: "i", guid: "u" } }) });
  assert.equal(result, null);
});

test("rediscovery cooldown coalesces and bounds calls", async () => {
  const gate = createDiscoveryCooldown(1000); let calls = 0;
  assert.equal(await gate(async () => ++calls), 1); assert.equal(await gate(async () => ++calls), null); assert.equal(calls, 1);
});

// Real isolated writer processes, with only fixture credentials/configs and an
// injected fetch. No Manager, enrolled node, or business endpoint is contacted.
const writerModule = new URL("../lib/endpoint-session.mjs", import.meta.url).href;
const writerScript = `
  import fs from "node:fs";
  const { createEndpointSession } = await import(process.argv[1]);
  const configPath = process.argv[2], mode = process.argv[3];
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const canonical = fs.realpathSync.native(configPath);
  const read = fs.readFileSync;
  if (mode === "hold") fs.readFileSync = function (filename, ...args) {
    if (filename === canonical) {
      process.send({ type: "owned" });
      // Stop exactly after kernel ownership, before reading current config/CAS.
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }
    return read.call(this, filename, ...args);
  };
  const identity = { guid: "stable", applicationGenerationId: "new", managerInstanceId: "new-instance" };
  let publicReads = 0;
  const session = createEndpointSession({ config, configPath, discover: async () => { throw new Error("unexpected discovery after persistence failure"); }, fetchImpl: async url => {
    if (url.endsWith("/.well-known/rabiroute-manager")) {
      if (++publicReads === 2 && mode === "gated") {
        process.send({ type: "verified" });
        await new Promise(resolve => process.once("message", resolve));
      }
      return Response.json({ code: 0, data: { protocolVersion: 1, ...identity } });
    }
    if (url.endsWith("/api/lan-agent/self")) return Response.json({ code: 0, data: { ...identity, nodeId: config.nodeId } });
    if (url.endsWith("/meta")) return Response.json({ code: 0, data: { ...identity, rabiGuid: "stable", health: { live: true, requiredReady: true, state: "healthy" } } });
    throw new Error("Unexpected fixture request");
  } });
  try { await session.ensure(); process.send({ type: "result", ok: true }); }
  catch (error) { process.send({ type: "result", ok: false, error: error.message, unchanged: JSON.stringify(session.config) === JSON.stringify(config) }); }
  process.disconnect();
`;

function fixtureConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-endpoint-fixture-"));
  const configPath = path.join(directory, "config.json");
  const config = { managerUrl: "http://manager.invalid", managerGuid: "stable", applicationGenerationId: "old", managerInstanceId: "old-instance", nodeId: "fixture-node", nodeCredential: "fixture-private", autoUpdate: false, agents: [{ id: "fixture-agent", sessionId: "fixture-session" }], privateSettings: { value: "fixture-setting" } };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { configPath, config, directory };
}

function startWriter(t, configPath, mode = "run") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript, writerModule, configPath, mode], { stdio: ["pipe", "ignore", "inherit", "ipc"] });
  const messages = [], waiters = [];
  const exited = once(child, "exit");
  child.on("message", message => {
    const index = waiters.findIndex(waiter => waiter.type === message.type);
    if (index < 0) messages.push(message); else waiters.splice(index, 1)[0].resolve(message);
  });
  child.once("exit", () => { for (const waiter of waiters.splice(0)) waiter.reject(new Error("Fixture writer exited before " + waiter.type)); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  return { child, exited, message(type) {
    const index = messages.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
  } };
}

// Only used to check the kernel address is free after crash; no business service
// or endpoint discovery is performed, and no alternative port is tried.
function writerAddress(configPath) {
  const canonical = fs.realpathSync.native(configPath);
  const hash = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  return process.platform === "win32" ? { path: `\\\\.\\pipe\\rabi-agent-endpoint-${hash}` }
    : { host: "127.0.0.1", port: 49152 + (Number.parseInt(hash.slice(0, 8), 16) % 16384), exclusive: true };
}

async function assertOwnerReleased(configPath) {
  const probe = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(writerAddress(configPath), resolve); });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

test("killed writer releases kernel ownership; inert old file cannot block reconnect", { timeout: 15000 }, async t => {
  const { configPath, config } = fixtureConfig(t);
  const oldLock = `${configPath}.endpoint-lock`;
  fs.writeFileSync(oldLock, "legacy diagnostic; owner unknown", { mode: 0o600 });
  const writer = startWriter(t, configPath, "hold");
  await writer.message("owned");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
  writer.child.kill("SIGKILL"); await writer.exited;
  await assertOwnerReleased(configPath);
  const reconnect = startWriter(t, configPath);
  assert.equal((await reconnect.message("result")).ok, true); await reconnect.exited;
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(stored, { ...config, applicationGenerationId: "new", managerInstanceId: "new-instance" });
  assert.equal(fs.readFileSync(oldLock, "utf8"), "legacy diagnostic; owner unknown");
});

test("live writer is exclusive across processes and canonical directory aliases", { timeout: 15000 }, async t => {
  const { configPath, config, directory } = fixtureConfig(t);
  const alias = path.join(directory, "alias");
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const writer = startWriter(t, configPath, "hold"); await writer.message("owned");
  const contenders = Array.from({ length: 3 }, () => startWriter(t, path.join(alias, "config.json")));
  for (const contender of contenders) {
    const result = await contender.message("result");
    assert.equal(result.ok, false); assert.match(result.error, /configuration is busy/); assert.equal(result.unchanged, true);
    await contender.exited;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
  // An active owner is never stolen, no matter how many contenders failed.
  writer.child.stdin.write("x");
  assert.equal((await writer.message("result")).ok, true); await writer.exited;
  await assertOwnerReleased(configPath);
});

for (const key of ["nodeId", "nodeCredential", "managerUrl", "managerGuid", "applicationGenerationId", "managerInstanceId"]) {
  test(`concurrent ${key} change fails CAS without overwrite`, { timeout: 15000 }, async t => {
    const { configPath, config } = fixtureConfig(t);
    const writer = startWriter(t, configPath, "gated"); await writer.message("verified");
    const changed = { ...config, [key]: `changed-${key}`, autoUpdate: true, privateSettings: { value: "concurrent-setting" } };
    const text = JSON.stringify(changed);
    fs.writeFileSync(configPath, text); writer.child.send("continue");
    const result = await writer.message("result");
    assert.equal(result.ok, false); assert.match(result.error, /changed concurrently/); assert.equal(result.unchanged, true);
    await writer.exited;
    assert.equal(fs.readFileSync(configPath, "utf8"), text);
    await assertOwnerReleased(configPath);
  });
}

test("verified endpoint merges current private settings and Agent binding changes", { timeout: 15000 }, async t => {
  const { configPath, config } = fixtureConfig(t);
  const writer = startWriter(t, configPath, "gated"); await writer.message("verified");
  const changed = { ...config, autoUpdate: true, agents: [{ id: "fixture-agent", sessionId: "new-fixture-session", cwd: "fixture-workspace" }], privateSettings: { value: "concurrent-private" } };
  fs.writeFileSync(configPath, JSON.stringify(changed)); writer.child.send("continue");
  assert.equal((await writer.message("result")).ok, true); await writer.exited;
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { ...changed, applicationGenerationId: "new", managerInstanceId: "new-instance" });
  await assertOwnerReleased(configPath);
});
