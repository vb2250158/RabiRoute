import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import { PersonaSyncCoordinator, PersonaSyncStaleManifestError } from "./personaSyncCoordinator.js";
import { identityRelationsPath, updateIdentityRelation } from "./identityRelations.js";
import { findPersonaVoiceIdentity, personaVoiceIdentitiesPath, updatePersonaVoiceIdentity } from "./personaVoiceIdentities.js";
import { listPersonaVoiceTranscriptViews } from "./personaVoiceTranscriptView.js";
import { handlePersonaSyncApi } from "./manager/personaSyncRoutes.js";
import { PersonaSyncLanServer } from "./manager/personaSyncLanServer.js";
import { RabiLinkRelayRuntime } from "./manager/rabiLinkRelayRuntime.js";
import { planStorageDirectory } from "./planStorageReconciliation.js";
import { PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY } from "./personaSyncPlanPackage.js";

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

function writeCoordinatorArchive(roleRoot: string, planId: string): { archive: string; completed: Record<string, unknown> } {
  const archive = planStorageDirectory(roleRoot, planId, "archive");
  fs.mkdirSync(archive, { recursive: true });
  const completed = {
    id: planId,
    title: "Coordinator archive",
    focus: "Keep archive canonical",
    status: "已完成",
    createdAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    steps: [{ id: "done", title: "Done", status: "已完成" }],
    keywords: ["archive"]
  };
  const archived = {
    ...completed,
    status: "已归档",
    archivedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z"
  };
  const createdEvent = { id: "created", planId, kind: "created", recordedAt: completed.updatedAt, after: completed };
  const archivedEvent = {
    id: "archived",
    planId,
    kind: "archived",
    recordedAt: archived.updatedAt,
    before: completed,
    after: archived
  };
  fs.writeFileSync(path.join(archive, "plan.json"), `${JSON.stringify(archived, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(archive, "history.jsonl"), `${JSON.stringify(createdEvent)}\n${JSON.stringify(archivedEvent)}\n`, "utf8");
  return { archive, completed };
}

function writeCoordinatorActive(
  roleRoot: string,
  planId: string,
  options: { title?: string; status?: "进行中" | "已完成"; extraFiles?: Record<string, string | Buffer> } = {}
): { active: string; plan: Record<string, unknown> } {
  const active = planStorageDirectory(roleRoot, planId, "active");
  fs.mkdirSync(active, { recursive: true });
  const completed = options.status === "已完成";
  const plan = {
    id: planId,
    title: options.title || "Coordinator active",
    focus: "Keep the plan package atomic",
    status: completed ? "已完成" : "进行中",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...(completed ? { completedAt: "2026-08-01T01:00:00.000Z" } : {}),
    updatedAt: completed ? "2026-08-01T01:00:00.000Z" : "2026-08-01T00:00:00.000Z",
    steps: [{ id: "working", title: "Working", status: completed ? "已完成" : "进行中" }],
    keywords: ["active"]
  };
  const createdEvent = {
    id: `created-${planId}`,
    planId,
    kind: "created",
    recordedAt: plan.updatedAt,
    after: plan
  };
  fs.writeFileSync(path.join(active, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(active, "history.jsonl"), `${JSON.stringify(createdEvent)}\n`, "utf8");
  for (const [relativePath, content] of Object.entries(options.extraFiles || {})) {
    const target = path.join(active, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { active, plan };
}

function archiveCoordinatorActive(roleRoot: string, planId: string): string {
  const active = planStorageDirectory(roleRoot, planId, "active");
  const archive = planStorageDirectory(roleRoot, planId, "archive");
  const completed = JSON.parse(fs.readFileSync(path.join(active, "plan.json"), "utf8")) as Record<string, unknown>;
  assert.equal(completed.status, "已完成");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(active, archive);
  const archived = {
    ...completed,
    status: "已归档",
    archivedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z"
  };
  const event = {
    id: `archived-${planId}`,
    planId,
    kind: "archived",
    recordedAt: archived.updatedAt,
    before: completed,
    after: archived
  };
  fs.writeFileSync(path.join(archive, "plan.json"), `${JSON.stringify(archived, null, 2)}\n`, "utf8");
  fs.appendFileSync(path.join(archive, "history.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  return archive;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readyPlanStorageStartup() {
  return { state: "ready" as const, attempt: 1, incidents: 0, lastTransitionAt: "2026-09-01T00:00:00.000Z" };
}

function publishingService(rolesRoot: string, stateRoot: string): PersonaSyncService {
  let service!: PersonaSyncService;
  service = new PersonaSyncService(() => rolesRoot, stateRoot, {
    onEvent: () => { void service.manifest().catch(() => {}); }
  });
  return service;
}

async function createDirectCoordinator(
  t: { after(callback: () => void | Promise<void>): void },
  serviceA: PersonaSyncService,
  serviceB: PersonaSyncService,
  stateRoot: string,
  token: string,
  capabilities: string[] = ["persona-sync", PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY]
): Promise<PersonaSyncCoordinator> {
  const peerLan = new PersonaSyncLanServer({
    service: serviceB,
    coordinator: {} as PersonaSyncCoordinator,
    token: () => token,
    relay: () => ({ url: "", token, deviceId: "pc-b", deviceGuid: "guid-b" }),
    planStorageStartup: readyPlanStorageStartup
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  await peerLan.start();
  t.after(() => peerLan.stop());
  const peerUrl = peerLan.peerUrls()[0];
  const relayServer = http.createServer((request, response) => {
    if (request.headers["x-rabilink-token"] !== token) return void response.writeHead(401).end();
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/rabilink/peers") return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ peers: [{
      id: "pc-b",
      guid: "guid-b",
      name: "Peer B",
      online: true,
      capabilities,
      peerUrls: [peerUrl]
    }] }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));
  return new PersonaSyncCoordinator(serviceA, stateRoot, () => ({
    url: `http://127.0.0.1:${relayPort}`,
    token,
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
}

test("persona sync restarts one whole transaction after a typed stale manifest fence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-stale-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  fs.mkdirSync(path.join(rolesRoot, "Rabi"), { recursive: true });
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  await service.startManifestIndex();
  const coordinator = new PersonaSyncCoordinator(service, path.join(root, "state"), () => ({
    url: "http://relay.invalid",
    token: "test-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));
  const peer = {
    id: "pc-b",
    guid: "guid-b",
    name: "Peer B",
    online: true,
    capabilities: ["persona-sync"],
    peerUrls: ["http://peer.invalid"]
  };
  let discoveries = 0;
  let connections = 0;
  let reads = 0;
  coordinator.peers = async () => {
    discoveries += 1;
    return [peer];
  };
  const remoteContent = Buffer.from("fresh remote\n", "utf8");
  const remoteFile = {
    roleId: "Rabi",
    path: "remote.md",
    size: remoteContent.byteLength,
    sha256: sha256(remoteContent),
    mergeStrategy: "three-way-file" as const
  };
  const internals = coordinator as unknown as {
    connect(...args: unknown[]): Promise<unknown>;
    remoteFile(...args: unknown[]): Promise<Buffer>;
  };
  internals.connect = async () => {
    connections += 1;
    return {
      baseUrl: "http://peer.invalid",
      transport: "lan",
      peerId: peer.id,
      manifest: { schemaVersion: 1, generatedAt: new Date().toISOString(), roles: [{ roleId: "Rabi", files: [remoteFile] }] }
    };
  };
  internals.remoteFile = async () => {
    reads += 1;
    if (reads === 1) throw new PersonaSyncStaleManifestError("Rabi", "remote.md");
    return remoteContent;
  };

  const result = await coordinator.sync(peer.id, "Rabi");
  assert.equal(result.fileConflicts, 0);
  assert.equal(discoveries, 2);
  assert.equal(connections, 2);
  assert.equal(reads, 2);
  assert.equal(fs.readFileSync(path.join(rolesRoot, "Rabi", "remote.md"), "utf8"), "fresh remote\n");
});

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
  updateIdentityRelation(path.join(rolesA, "Rabi"), {
    kind: "participant", participantId: "participant-sync-conflict", participantKind: "person",
    displayName: "原始身份", status: "confirmed", aliases: [], evidenceRefs: []
  });
  fs.mkdirSync(path.dirname(identityRelationsPath(path.join(rolesB, "Rabi"))), { recursive: true });
  fs.copyFileSync(
    identityRelationsPath(path.join(rolesA, "Rabi")),
    identityRelationsPath(path.join(rolesB, "Rabi"))
  );
  updateIdentityRelation(path.join(rolesA, "Rabi"), {
    kind: "participant", participantId: "participant-sync-conflict", participantKind: "person",
    displayName: "本机身份", status: "confirmed", aliases: [], evidenceRefs: [{ messageId: "local" }]
  });
  updateIdentityRelation(path.join(rolesB, "Rabi"), {
    kind: "participant", participantId: "participant-sync-conflict", participantKind: "person",
    displayName: "远端身份", status: "confirmed", aliases: [], evidenceRefs: [{ messageId: "remote" }]
  });
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
  fs.mkdirSync(path.join(rolesB, "Rabi", "memory", "recent"), { recursive: true });
  writeCoordinatorActive(path.join(rolesA, "Rabi"), "plan-1");
  fs.writeFileSync(path.join(rolesB, "Rabi", "memory", "recent", "memory-1.json"), "{\"id\":\"memory-1\"}\n");
  fs.mkdirSync(path.join(rolesA, "Rabi", "state", "work-cycle-history"), { recursive: true });
  fs.mkdirSync(path.join(rolesB, "Rabi", "state", "work-cycle-history"), { recursive: true });
  fs.writeFileSync(path.join(rolesA, "Rabi", "state", "work-cycle-history", "snapshot.json"), "local runtime\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "state", "work-cycle-history", "snapshot.json"), "remote runtime\n");
  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "base decision\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "base decision\n");
  const serviceA = new PersonaSyncService(() => rolesA, path.join(root, "a", "state"));
  const serviceB = publishingService(rolesB, path.join(root, "b", "state"));
  t.after(() => {
    serviceA.stopManifestIndex();
    serviceB.stopManifestIndex();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([serviceA.startManifestIndex(), serviceB.startManifestIndex()]);
  const token = "shared-app-token";

  const peerLan = new PersonaSyncLanServer({
    service: serviceB,
    coordinator: {} as PersonaSyncCoordinator,
    token: () => token,
    relay: () => ({ url: "", token, deviceId: "pc-b", deviceGuid: "guid-b" }),
    planStorageStartup: readyPlanStorageStartup
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
        capabilities: ["persona-sync", PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY],
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
  const preview = await coordinator.preview("pc-b", "Rabi");
  assert.equal(preview.peer.name, "Peer B");
  assert.equal(preview.transport, "lan");
  assert.equal(preview.files.find(file => file.path === "local.md")?.operation, "push_create");
  assert.equal(preview.files.find(file => file.path === "remote.md")?.operation, "pull_create");
  assert.equal(preview.files.find(file => file.path === "conversation/current.jsonl")?.operation, "auto_merge");
  assert.equal(fs.existsSync(path.join(rolesA, "Rabi", "remote.md")), false);
  assert.equal(fs.existsSync(path.join(rolesB, "Rabi", "local.md")), false);
  const [result, duplicateResult] = await Promise.all([
    coordinator.sync("pc-b", "Rabi"),
    coordinator.sync("pc-b", "Rabi")
  ]);
  assert.equal(result.fileConflicts, 0);
  assert.equal(result.conflicts, 2);
  assert.equal(result.semanticConflicts.length, 2);
  const voiceConflict = result.semanticConflicts.find(item => item.kind === "persona_voice_identity");
  assert.equal(voiceConflict?.voiceprintId, "cluster-conflict");
  assert.ok(voiceConflict?.fields.includes("isUser"));
  const identityConflict = result.semanticConflicts.find(item => item.kind === "identity_relation");
  assert.equal(identityConflict?.recordKind, "participant");
  assert.equal(identityConflict?.recordId, "participant-sync-conflict");
  assert.deepEqual(duplicateResult, result);
  assert.equal(discoveryRequests, 2);
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
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(planStorageDirectory(path.join(rolesB, "Rabi"), "plan-1", "active"), "plan.json"), "utf8")).id,
    "plan-1"
  );
  assert.equal(fs.readFileSync(path.join(rolesA, "Rabi", "memory", "recent", "memory-1.json"), "utf8"), "{\"id\":\"memory-1\"}\n");
  assert.equal(fs.readFileSync(path.join(rolesA, "Rabi", "state", "work-cycle-history", "snapshot.json"), "utf8"), "local runtime\n");
  assert.equal(fs.readFileSync(path.join(rolesB, "Rabi", "state", "work-cycle-history", "snapshot.json"), "utf8"), "remote runtime\n");
  assert.equal(result.files.some(file => file.path.includes("work-cycle-history")), false);

  fs.rmSync(path.join(rolesB, "Rabi", "local.md"));
  await serviceB.manifest("Rabi");
  const pulledDeletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(pulledDeletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesA, "Rabi", "local.md")), false);

  fs.rmSync(path.join(rolesA, "Rabi", "remote.md"));
  await serviceA.manifest("Rabi");
  const pushedDeletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(pushedDeletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesB, "Rabi", "remote.md")), false);

  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "local decision\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "remote decision\n");
  await Promise.all([serviceA.manifest("Rabi"), serviceB.manifest("Rabi")]);
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
  await Promise.all([serviceA.manifest("Rabi"), serviceB.manifest("Rabi")]);
  const staleConflictSync = await coordinator.sync("pc-b", "Rabi");
  assert.equal(staleConflictSync.fileConflicts, 1);
  const staleConflict = serviceA.listConflicts("Rabi").find(item => item.path === "decision.md");
  assert.ok(staleConflict);
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "remote after evidence\n");
  await serviceB.manifest("Rabi");
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

test("persona sync coordinator preserves archive identity and fails closed against a stale active peer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesA = path.join(root, "a", "roles");
  const rolesB = path.join(root, "b", "roles");
  const roleA = path.join(rolesA, "Rabi");
  const roleB = path.join(rolesB, "Rabi");
  const planId = "terminal-sync-plan";
  const source = writeCoordinatorArchive(roleA, planId);
  fs.mkdirSync(roleB, { recursive: true });
  const serviceA = new PersonaSyncService(() => rolesA, path.join(root, "a", "state"), { watch: false });
  const serviceB = publishingService(rolesB, path.join(root, "b", "state"));
  t.after(() => serviceA.stopManifestIndex());
  t.after(() => serviceB.stopManifestIndex());
  await Promise.all([serviceA.startManifestIndex(), serviceB.startManifestIndex()]);
  const token = "plan-lifecycle-token";
  const peerLan = new PersonaSyncLanServer({
    service: serviceB,
    coordinator: {} as PersonaSyncCoordinator,
    token: () => token,
    relay: () => ({ url: "", token, deviceId: "pc-b", deviceGuid: "guid-b" }),
    planStorageStartup: readyPlanStorageStartup
  }, { host: "127.0.0.1", port: 0, addresses: () => ["127.0.0.1"] });
  await peerLan.start();
  t.after(() => peerLan.stop());
  const peerUrl = peerLan.peerUrls()[0];
  const relayServer = http.createServer((request, response) => {
    if (request.headers["x-rabilink-token"] !== token) return void response.writeHead(401).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ peers: [{
      id: "pc-b",
      guid: "guid-b",
      name: "Peer B",
      online: true,
      capabilities: ["persona-sync", PERSONA_SYNC_PLAN_PACKAGE_CAPABILITY],
      peerUrls: [peerUrl]
    }] }));
  });
  const relayPort = await listen(relayServer);
  t.after(() => close(relayServer));
  const coordinator = new PersonaSyncCoordinator(serviceA, path.join(root, "a", "state"), () => ({
    url: `http://127.0.0.1:${relayPort}`,
    token,
    deviceId: "pc-a",
    deviceGuid: "guid-a"
  }));

  const first = await coordinator.sync("pc-b", "Rabi");
  assert.equal(first.fileConflicts, 0);
  const peerArchive = planStorageDirectory(roleB, planId, "archive");
  assert.equal(fs.existsSync(path.join(peerArchive, "plan.json")), true);
  assert.equal(fs.existsSync(path.join(peerArchive, "history.jsonl")), true);

  fs.rmSync(peerArchive, { recursive: true, force: true });
  await serviceB.manifest("Rabi");
  const restored = await coordinator.sync("pc-b", "Rabi");
  assert.equal(restored.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(peerArchive, "plan.json")), true);
  assert.equal(fs.existsSync(source.archive), true);

  fs.rmSync(peerArchive, { recursive: true, force: true });
  const peerActive = writeCoordinatorActive(roleB, planId, { title: "Divergent stale active" }).active;
  await serviceB.manifest("Rabi");
  const preview = await coordinator.preview("pc-b", "Rabi");
  assert.equal(preview.files.some((file) => file.path.includes(planId) && file.operation.startsWith("push_")), true);
  const conflicted = await coordinator.sync("pc-b", "Rabi");
  assert.ok(conflicted.fileConflicts > 0);
  assert.equal(fs.existsSync(peerActive), true);
  assert.equal(fs.existsSync(peerArchive), false);
  assert.equal(fs.existsSync(source.archive), true);
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
  const serviceB = publishingService(rolesB, path.join(root, "b", "state"));
  t.after(() => serviceA.stopManifestIndex());
  t.after(() => serviceB.stopManifestIndex());
  await Promise.all([serviceA.startManifestIndex(), serviceB.startManifestIndex()]);

  const peerServer = http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (!handlePersonaSyncApi(request, url, response, {
      service: serviceB,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "",
      relay: () => ({ url: "", token: "", deviceId: "pc-b", deviceGuid: "guid-b" }),
      planStorageStartup: readyPlanStorageStartup
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
  await serviceB.manifest("Rabi");
  const deletion = await coordinator.sync("pc-b", "Rabi");
  assert.equal(deletion.transport, "relay");
  assert.equal(deletion.fileConflicts, 0);
  assert.equal(fs.existsSync(path.join(rolesA, "Rabi", "remote.md")), false);

  fs.writeFileSync(path.join(rolesA, "Rabi", "decision.md"), "relay local\n");
  fs.writeFileSync(path.join(rolesB, "Rabi", "decision.md"), "relay remote\n");
  await Promise.all([serviceA.manifest("Rabi"), serviceB.manifest("Rabi")]);
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
