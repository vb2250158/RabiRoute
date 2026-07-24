import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import { PersonaSyncAutoReconciler } from "./personaSyncAutoReconciler.js";
import { PersonaSyncCoordinator } from "./personaSyncCoordinator.js";
import type { PersonaSyncResult } from "./personaSyncCoordinator.js";
import { PersonaSyncLanServer } from "./manager/personaSyncLanServer.js";

function result(peerId: string, roleId = "Rabi"): PersonaSyncResult {
  return {
    peer: { id: peerId, name: peerId, online: true, capabilities: ["persona-sync"], peerUrls: [] },
    baseUrl: "http://127.0.0.1",
    transport: "lan",
    files: [{
      status: "unchanged",
      roleId,
      path: "persona.md",
      localHash: "hash",
      remoteHash: "hash",
      resultHash: "hash",
      direction: "converged"
    }],
    fileConflicts: 0,
    semanticConflicts: [],
    conflicts: 0
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for automatic persona reconciliation.");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Missing test listener port."));
      else resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test("Relay ready performs one full catch-up and file events coalesce by persona", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-"));
  const calls: Array<{ peerId: string; roleId?: string }> = [];
  const reconciler = new PersonaSyncAutoReconciler({
    peers: async () => [{ id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] }],
    sync: async (peerId, roleId) => {
      calls.push({ peerId, roleId });
      return result(peerId, roleId);
    }
  }, root, { settleMs: 5, retryBaseMs: 10 });
  reconciler.start();
  reconciler.noteRelayEvent("ready");
  await waitFor(() => reconciler.status().state === "idle");
  assert.deepEqual(calls, [{ peerId: "pc-b", roleId: undefined }]);

  reconciler.noteManifestEvent({ kind: "updated", roleId: "Rabi", path: "persona.md", generation: 2 });
  reconciler.noteManifestEvent({ kind: "updated", roleId: "Rabi", path: "memory.md", generation: 3 });
  await waitFor(() => calls.length === 2 && reconciler.status().state === "idle");
  assert.deepEqual(calls[1], { peerId: "pc-b", roleId: "Rabi" });
  assert.equal(reconciler.status().pending, false);
  reconciler.stop();
});

test("pending work survives offline restart and peer-change events wake it without polling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-persist-"));
  const offline = new PersonaSyncAutoReconciler({
    peers: async () => [],
    sync: async (peerId) => result(peerId)
  }, root, { settleMs: 5 });
  offline.start();
  offline.noteManifestEvent({ kind: "created", roleId: "Rabi", path: "persona.md", generation: 1 });
  assert.equal(offline.status().pending, true);
  assert.equal(offline.status().state, "waiting_relay");
  offline.stop();

  let peerOnline = false;
  const calls: Array<{ peerId: string; roleId?: string }> = [];
  const resumed = new PersonaSyncAutoReconciler({
    peers: async () => peerOnline
      ? [{ id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] }]
      : [],
    sync: async (peerId, roleId) => {
      calls.push({ peerId, roleId });
      return result(peerId, roleId);
    }
  }, root, { settleMs: 5, retryBaseMs: 10 });
  resumed.start();
  resumed.noteRelayEvent("ready");
  await waitFor(() => resumed.status().state === "waiting_peer");
  assert.equal(calls.length, 0);
  assert.equal(resumed.status().pending, true);

  peerOnline = true;
  resumed.noteRelayEvent("persona_sync_peer_changed");
  await waitFor(() => resumed.status().state === "idle");
  assert.deepEqual(calls, [{ peerId: "pc-b", roleId: undefined }]);
  assert.equal(resumed.status().pending, false);
  resumed.stop();
});

test("a peer reconnect event automatically converges real persona folders without an explicit sync call", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-real-"));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  const stateA = path.join(root, "a", "sync-state");
  const stateB = path.join(root, "b", "sync-state");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  fs.mkdirSync(roleA, { recursive: true });
  fs.mkdirSync(roleB, { recursive: true });
  fs.writeFileSync(path.join(roleA, "persona.md"), "shared persona\n", "utf8");
  fs.writeFileSync(path.join(roleB, "persona.md"), "shared persona\n", "utf8");

  const token = "same-application-token";
  const serviceA = new PersonaSyncService(() => rolesA, stateA);
  const serviceB = new PersonaSyncService(() => rolesB, stateB);
  const lan = new PersonaSyncLanServer({
    service: serviceB,
    coordinator: {} as PersonaSyncCoordinator,
    token: () => token,
    relay: () => ({ url: "", token, deviceId: "pc-b", deviceGuid: "guid-b" })
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  await lan.start();
  t.after(() => lan.stop());
  let peerOnline = true;
  let peerUrl = lan.peerUrls()[0];

  const relay = http.createServer((request, response) => {
    if (request.headers["x-rabilink-token"] !== token) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      peers: [{
        id: "pc-b",
        guid: "guid-b",
        name: "Peer B",
        online: peerOnline,
        capabilities: ["persona-sync"],
        peerUrls: peerOnline ? [peerUrl] : []
      }]
    }));
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const coordinator = new PersonaSyncCoordinator(serviceA, stateA, () => ({
    url: `http://127.0.0.1:${relayPort}`,
    token,
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
  const reconciler = new PersonaSyncAutoReconciler(coordinator, stateA, { settleMs: 5, retryBaseMs: 10 });
  t.after(() => reconciler.stop());
  reconciler.start();
  reconciler.noteRelayEvent("ready");
  await waitFor(() => reconciler.status().state === "idle");

  peerOnline = false;
  lan.stop();
  reconciler.noteRelayEvent("persona_sync_peer_changed");
  await waitFor(() => reconciler.status().state === "waiting_peer");
  fs.writeFileSync(path.join(roleA, "memory.md"), "written while peer B was offline\n", "utf8");
  reconciler.noteManifestEvent({ kind: "created", roleId: "Rabi", path: "memory.md", generation: 2 });
  assert.equal(reconciler.status().pending, true);

  await lan.start();
  peerUrl = lan.peerUrls()[0];
  peerOnline = true;
  reconciler.noteRelayEvent("persona_sync_peer_changed");
  await waitFor(() => reconciler.status().state === "idle");

  assert.equal(fs.readFileSync(path.join(roleB, "memory.md"), "utf8"), "written while peer B was offline\n");
  assert.equal(reconciler.status().pending, false);
});

test("conflicts become an attention state instead of an automatic retry loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-conflict-"));
  let calls = 0;
  const reconciler = new PersonaSyncAutoReconciler({
    peers: async () => [{ id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] }],
    sync: async (peerId) => {
      calls += 1;
      return { ...result(peerId), fileConflicts: 1, conflicts: 1 };
    }
  }, root, { settleMs: 5, retryBaseMs: 10 });
  reconciler.start();
  reconciler.noteRelayEvent("ready");
  await waitFor(() => reconciler.status().state === "attention");
  assert.equal(calls, 1);
  assert.equal(reconciler.status().pending, false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  reconciler.stop();
});

test("a transient online failure uses a bounded one-shot retry and then clears the durable marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-retry-"));
  let discoveryCalls = 0;
  const reconciler = new PersonaSyncAutoReconciler({
    peers: async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) throw new Error("temporary Relay failure");
      return [{ id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] }];
    },
    sync: async (peerId) => result(peerId)
  }, root, { settleMs: 5, retryBaseMs: 10, maxRetryAttempts: 2 });
  reconciler.start();
  reconciler.noteRelayEvent("ready");
  await waitFor(() => reconciler.status().state === "idle");
  assert.equal(discoveryCalls, 2);
  assert.equal(reconciler.status().pending, false);
  assert.equal(reconciler.status().lastError, undefined);
  reconciler.stop();
});

test("stopping during an in-flight reconciliation preserves stopped state and durable pending work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-auto-stop-"));
  let releaseSync: (() => void) | undefined;
  const syncGate = new Promise<void>(resolve => {
    releaseSync = resolve;
  });
  const reconciler = new PersonaSyncAutoReconciler({
    peers: async () => [{ id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] }],
    sync: async (peerId) => {
      await syncGate;
      return result(peerId);
    }
  }, root, { settleMs: 5, retryBaseMs: 10 });

  reconciler.start();
  reconciler.noteRelayEvent("ready");
  await waitFor(() => reconciler.status().state === "syncing");
  reconciler.stop();
  releaseSync?.();
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(reconciler.status().state, "stopped");
  assert.equal(reconciler.status().pending, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, "auto-sync-state.json"), "utf8")) as {
    needsFullSync?: boolean;
  };
  assert.equal(persisted.needsFullSync, true);
});

test("automatic persona reconciliation contains no fixed polling loop", () => {
  const source = fs.readFileSync(new URL("./personaSyncAutoReconciler.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval\s*\(/);
});
