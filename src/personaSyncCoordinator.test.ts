import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import { PersonaSyncCoordinator } from "./personaSyncCoordinator.js";
import { findPersonaVoiceIdentity, personaVoiceIdentitiesPath, updatePersonaVoiceIdentity } from "./personaVoiceIdentities.js";
import { listPersonaVoiceTranscriptViews } from "./personaVoiceTranscriptView.js";
import { handlePersonaSyncApi } from "./manager/personaSyncRoutes.js";
import { PersonaSyncLanServer } from "./manager/personaSyncLanServer.js";
import { RabiLinkRelayRuntime } from "./manager/rabiLinkRelayRuntime.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing port."));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for persona sync test state.");
}

test("persona sync coordinator uses Relay discovery and converges peer JSONL over LAN", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-coordinator-"));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  fs.mkdirSync(path.join(rolesA, "Rabi", "conversation"), { recursive: true });
  fs.mkdirSync(path.join(rolesB, "Rabi", "conversation"), { recursive: true });
  fs.writeFileSync(path.join(rolesA, "Rabi", "conversation", "current.jsonl"), `${JSON.stringify({ id: "a", time: 1, text: "A" })}\n`);
  fs.writeFileSync(path.join(rolesB, "Rabi", "conversation", "current.jsonl"), [
    JSON.stringify({ id: "b", time: 2, text: "B" }),
    JSON.stringify({
      schemaVersion: 1,
      id: "voice-b",
      time: 3,
      direction: "inbound",
      adapter: "speech",
      kind: "asr",
      text: "这是用户说的。",
      sourceHostId: "host-b",
      segments: [{ id: 0, start: 0, end: 1.5, text: "这是用户说的。", speakerClusterId: "cluster-user" }]
    })
  ].join("\n") + "\n");
  updatePersonaVoiceIdentity(path.join(rolesA, "Rabi"), {
    sourceHostId: "host-b",
    voiceprintId: "cluster-user",
    displayName: "老板",
    isUser: true,
    aliases: []
  });
  updatePersonaVoiceIdentity(path.join(rolesA, "Rabi"), {
    sourceHostId: "host-shared",
    voiceprintId: "cluster-conflict",
    displayName: "待确认",
    aliases: []
  });
  fs.mkdirSync(path.dirname(personaVoiceIdentitiesPath(path.join(rolesB, "Rabi"))), { recursive: true });
  fs.copyFileSync(
    personaVoiceIdentitiesPath(path.join(rolesA, "Rabi")),
    personaVoiceIdentitiesPath(path.join(rolesB, "Rabi"))
  );
  updatePersonaVoiceIdentity(path.join(rolesA, "Rabi"), {
    sourceHostId: "host-shared",
    voiceprintId: "cluster-conflict",
    displayName: "用户",
    isUser: true,
    aliases: []
  });
  updatePersonaVoiceIdentity(path.join(rolesB, "Rabi"), {
    sourceHostId: "host-shared",
    voiceprintId: "cluster-conflict",
    displayName: "访客",
    isUser: false,
    aliases: []
  });
  fs.writeFileSync(path.join(rolesA, "Rabi", "local.md"), "local only\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "remote.md"), "remote only\n");
  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "base decision\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "base decision\n");
  const serviceA = new PersonaSyncService(() => rolesA, path.join(root, "a", "state"));
  const serviceB = new PersonaSyncService(() => rolesB, path.join(root, "b", "state"));
  const token = "shared-app-token";

  const peerLan = new PersonaSyncLanServer({
    service: serviceB,
    coordinator: {} as PersonaSyncCoordinator,
    token: () => token,
    relay: () => ({ url: "", token, deviceId: "pc-b", deviceGuid: "guid-b" })
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  await peerLan.start();
  t.after(() => peerLan.stop());
  const peerUrl = peerLan.peerUrls()[0];

  let discoveryRequests = 0;
  const relayServer = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/rabilink/peers" || request.headers["x-rabilink-token"] !== token) {
      response.writeHead(401).end();
      return;
    }
    discoveryRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      peers: [{
        id: "pc-b",
        guid: "guid-b",
        name: "Peer B",
        online: true,
        capabilities: ["persona-sync"],
        peerUrls: [peerUrl]
      }]
    }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));

  const coordinator = new PersonaSyncCoordinator(serviceA, path.join(root, "a", "state"), () => ({
    url: `http://127.0.0.1:${relayPort}`,
    token,
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
  const [result, duplicateResult] = await Promise.all([
    coordinator.sync("pc-b", "Rabi"),
    coordinator.sync("pc-b", "Rabi")
  ]);
  assert.equal(result.fileConflicts, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.semanticConflicts.length, 1);
  assert.equal(result.semanticConflicts[0]?.kind, "persona_voice_identity");
  assert.equal(result.semanticConflicts[0]?.voiceprintId, "cluster-conflict");
  assert.ok(result.semanticConflicts[0]?.fields.includes("isUser"));
  assert.deepEqual(duplicateResult, result);
  assert.equal(discoveryRequests, 1);
  const localRows = fs.readFileSync(path.join(rolesA, "Rabi", "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const remoteRows = fs.readFileSync(path.join(rolesB, "Rabi", "conversation", "current.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(localRows.map(row => row.id), ["a", "b", "voice-b"]);
  assert.deepEqual(remoteRows.map(row => row.id), ["a", "b", "voice-b"]);
  assert.equal(listPersonaVoiceTranscriptViews(path.join(rolesA, "Rabi"), { speaker: "user" }).length, 1);
  assert.equal(listPersonaVoiceTranscriptViews(path.join(rolesB, "Rabi"), { speaker: "user" }).length, 1);
  assert.equal(findPersonaVoiceIdentity(path.join(rolesA, "Rabi"), "host-shared", "cluster-conflict")?.conflicted, true);
  assert.equal(findPersonaVoiceIdentity(path.join(rolesB, "Rabi"), "host-shared", "cluster-conflict")?.conflicted, true);
  assert.equal(fs.readFileSync(path.join(rolesA, "Rabi", "remote.md"), "utf8"), "remote only\n");
  assert.equal(fs.readFileSync(path.join(rolesB, "Rabi", "local.md"), "utf8"), "local only\n");

  fs.rmSync(path.join(rolesB, "Rabi", "local.md"));
  const pulledDeletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(pulledDeletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesA, "Rabi", "local.md")), false);

  fs.rmSync(path.join(rolesA, "Rabi", "remote.md"));
  const pushedDeletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(pushedDeletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesB, "Rabi", "remote.md")), false);

  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "local decision\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "remote decision\n");
  const divergent = await coordinator.sync("pc-b", "Rabi");
  assert.equal(divergent.fileConflicts, 1);
  const decisionConflict = serviceA.listConflicts("Rabi").find(item => item.path === "decision.md");
  assert.ok(decisionConflict);
  const decisionResolution = serviceA.resolveConflict({
    conflictId: decisionConflict.conflictId,
    action: "keep_local",
    expectedLocalHash: decisionConflict.localHash
  });
  const publishedResolution = await coordinator.publishConflictResolution(decisionResolution);
  assert.equal(publishedResolution.status, "published");
  assert.equal(publishedResolution.transport, "lan");
  assert.equal(fs.readFileSync(path.join(rolesB, "Rabi", "decision.md"), "utf8"), "local decision\n");
  const convergedResolution = await coordinator.sync("pc-b", "Rabi");
  assert.equal(convergedResolution.fileConflicts, 0);

  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "local second\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "remote second\n");
  const staleConflictSync = await coordinator.sync("pc-b", "Rabi");
  assert.equal(staleConflictSync.fileConflicts, 1);
  const staleConflict = serviceA.listConflicts("Rabi").find(item => item.path === "decision.md");
  assert.ok(staleConflict);
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "remote after evidence\n");
  const staleResolution = serviceA.resolveConflict({
    conflictId: staleConflict.conflictId,
    action: "keep_local",
    expectedLocalHash: staleConflict.localHash
  });
  const refusedPublication = await coordinator.publishConflictResolution(staleResolution);
  assert.equal(refusedPublication.status, "not_published");
  assert.match(refusedPublication.message || "", /changed after this conflict evidence/i);
  assert.equal(fs.readFileSync(path.join(rolesB, "Rabi", "decision.md"), "utf8"), "remote after evidence\n");

  const activeStatePath = (coordinator as unknown as { statePath(peerId: string, token: string): string })
    .statePath("guid-b", token);
  const otherApplicationStatePath = (coordinator as unknown as { statePath(peerId: string, token: string): string })
    .statePath("guid-b", "another-app-token");
  assert.equal(fs.existsSync(activeStatePath), true);
  assert.notEqual(activeStatePath, otherApplicationStatePath);
  assert.doesNotMatch(activeStatePath, /shared-app-token/);
  assert.match(path.basename(path.dirname(activeStatePath)), /^[a-f0-9]{24}$/);
});

test("persona sync coordinator falls back to restricted Relay transit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-relay-sync-"));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  fs.mkdirSync(path.join(rolesA, "Rabi"), { recursive: true });
  fs.mkdirSync(path.join(rolesB, "Rabi"), { recursive: true });
  fs.writeFileSync(path.join(rolesB, "Rabi", "remote.md"), "through relay\n");
  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "relay base\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "relay base\n");
  const serviceA = new PersonaSyncService(() => rolesA, path.join(root, "a", "state"));
  const serviceB = new PersonaSyncService(() => rolesB, path.join(root, "b", "state"));

  const peerServer = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaSyncApi(request, url, response, {
      service: serviceB,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "",
      relay: () => ({ url: "", token: "", deviceId: "pc-b", deviceGuid: "guid-b" })
    })) response.writeHead(404).end();
  });
  const peerPort = await listen(peerServer);
  t.after(() => close(peerServer));

  const relayPort = await freePort();
  const relayDir = path.join(root, "relay");
  const relayChild = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(relayPort),
      RABILINK_RELAY_DATA_DIR: relayDir,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(root, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    relayChild.kill();
    return new Promise<void>(resolve => {
      if (relayChild.exitCode != null) return resolve();
      relayChild.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  });
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  await waitFor(async () => {
    try { return (await fetch(`${relayUrl}/health`)).ok; } catch { return false; }
  });
  const account = await fetch(`${relayUrl}/manage/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "coordinator-relay", password: "strong-test-password" })
  });
  const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
  const app = await fetch(`${relayUrl}/manage/api/apps`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Coordinator relay" })
  });
  const token = (await app.json()).app.token;

  const runtime = new RabiLinkRelayRuntime();
  runtime.sync({
    enabled: true,
    url: relayUrl,
    token,
    deviceId: "pc-b",
    deviceGuid: "guid-b",
    deviceName: "Peer B",
    claimWaitMs: 1_000,
    localWebguiUrl: `http://127.0.0.1:${peerPort}`,
    peerUrls: [],
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });
  t.after(() => runtime.stop());
  await waitFor(() => runtime.status().state === "online");

  const coordinator = new PersonaSyncCoordinator(serviceA, path.join(root, "a", "state"), () => ({
    url: relayUrl,
    token,
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
  const result = await coordinator.sync("pc-b", "Rabi");
  assert.equal(result.transport, "relay");
  assert.equal(result.conflicts, 0);
  assert.equal(fs.readFileSync(path.join(rolesA, "Rabi", "remote.md"), "utf8"), "through relay\n");

  fs.rmSync(path.join(rolesB, "Rabi", "remote.md"));
  const deletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(deletion.transport, "relay");
  assert.equal(deletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesA, "Rabi", "remote.md")), false);

  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "relay local\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "relay remote\n");
  const relayConflict = await coordinator.sync("pc-b", "Rabi");
  assert.equal(relayConflict.fileConflicts, 1);
  const conflict = serviceA.listConflicts("Rabi").find(item => item.path === "decision.md");
  assert.ok(conflict);
  const resolution = serviceA.resolveConflict({
    conflictId: conflict.conflictId,
    action: "keep_local",
    expectedLocalHash: conflict.localHash
  });
  const publication = await coordinator.publishConflictResolution(resolution);
  assert.equal(publication.status, "published");
  assert.equal(publication.transport, "relay");
  assert.equal(fs.readFileSync(path.join(rolesB, "Rabi", "decision.md"), "utf8"), "relay local\n");
});
