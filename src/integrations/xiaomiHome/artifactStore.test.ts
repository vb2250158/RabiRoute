import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { XiaomiHomeArtifactStore, XiaomiHomeArtifactEvidenceError } from "./artifactStore.js";
import http from "node:http";
import { createXiaomiHomeManagerOperations } from "./managerOperations.js";
import type { XiaomiHomeRuntimeController } from "./settingsRuntime.js";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../manager/connectionRequestAccess.js";

test("artifact ledger is idempotent, hides local paths, and rebuilds its index", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifacts-"));
  const mediaDir = path.join(root, "artifacts", "media", "2026", "08", "29");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaPath = path.join(mediaDir, "event.mp4");
  const bytes = Buffer.from("test-video");
  fs.writeFileSync(mediaPath, bytes);
  const input = {
    sourceEventId: "event-1",
    resourceId: "home:ha:camera.entry",
    eventKind: "camera_motion_detected",
    occurredAt: "2026-08-29T17:00:00+08:00",
    mediaKind: "video/mp4" as const,
    localPath: mediaPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    durationMs: 5000
  };
  const firstStore = new XiaomiHomeArtifactStore(root);
  assert.match(firstStore.allocateMediaPath("event-1", input.occurredAt, ".mp4"), /artifacts[\\/]media[\\/]2026[\\/]08[\\/]29/);
  const first = firstStore.register(input);
  const repeated = firstStore.register(input);
  assert.equal(repeated.artifactId, first.artifactId);
  assert.equal("localPath" in first, false);
  const rebuilt = new XiaomiHomeArtifactStore(root);
  assert.equal(rebuilt.get(first.artifactId)?.sourceEventId, "event-1");
  assert.equal(rebuilt.getBySourceEventId("event-1")?.artifactId, first.artifactId);
  assert.equal(rebuilt.getBySourceEventId("event-1", "OtherRole"), undefined);
  const scoped = firstStore.register({ ...input, ownerRoleId: "OtherRole" });
  assert.notEqual(scoped.artifactId, first.artifactId);
  assert.equal(new XiaomiHomeArtifactStore(root).getBySourceEventId("event-1", "OtherRole")?.artifactId, scoped.artifactId);
  assert.equal(rebuilt.list({ resourceId: input.resourceId }).length, 1);
  assert.match(String(rebuilt.lifecycleContract().action), /no archive or deletion/);
});

test("artifact registration rejects media outside its controlled directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifacts-"));
  const outside = path.join(root, "outside.mp4");
  fs.writeFileSync(outside, "outside");
  const store = new XiaomiHomeArtifactStore(root);
  assert.throws(() => store.register({
    sourceEventId: "event-2",
    resourceId: "home:ha:camera.entry",
    eventKind: "camera_motion_detected",
    occurredAt: "2026-08-29T17:00:00+08:00",
    mediaKind: "video/mp4",
    localPath: outside,
    sha256: createHash("sha256").update("outside").digest("hex"),
    byteLength: 7
  }), /inside the Xiaomi Home artifact media directory/);
});

function ledgerFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaomi-artifact-isolation-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new XiaomiHomeArtifactStore(root);
  const localPath = store.allocateMediaPath("fixture", "2026-08-29T12:00:00Z", ".mp4");
  fs.writeFileSync(localPath, "fixture bytes");
  const input = { sourceEventId: "first", resourceId: "camera.fixture", eventKind: "motion", occurredAt: "2026-08-29T12:00:00Z",
    mediaKind: "video/mp4" as const, localPath, sha256: createHash("sha256").update("fixture bytes").digest("hex"), byteLength: 13 };
  const first = store.register(input), last = store.register({ ...input, sourceEventId: "last" });
  const ledger = path.join(root, "artifacts/ledger/2026-08-29.jsonl");
  const rows = fs.readFileSync(ledger, "utf8").trimEnd().split("\n").map(row => JSON.parse(row));
  return { root, store, input, first, last, ledger, rows };
}

test("known damaged artifact rows reserve only their original identities and preserve valid neighbors", t => {
  const f = ledgerFixture(t);
  const damaged = { ...f.rows[0], artifactId: "damaged-artifact", sourceEventId: "damaged-event", occurredAt: null };
  const original = [f.rows[0], f.rows[1], damaged].map(row => JSON.stringify(row)).join("\n");
  fs.writeFileSync(f.ledger, original);
  const restored = new XiaomiHomeArtifactStore(f.root); restored.activate();
  assert.equal(fs.readFileSync(f.ledger, "utf8"), original);
  assert.deepEqual(restored.list().map(row => row.artifactId).sort(), [f.first.artifactId, f.last.artifactId].sort());
  assert.throws(() => restored.get("damaged-artifact"), XiaomiHomeArtifactEvidenceError);
  assert.throws(() => restored.contentDescriptor("damaged-artifact"), XiaomiHomeArtifactEvidenceError);
  assert.throws(() => restored.register({ ...f.input, sourceEventId: "damaged-event" }), XiaomiHomeArtifactEvidenceError);
  assert.equal(restored.register(f.input).artifactId, f.first.artifactId);
  assert.equal(restored.register({ ...f.input, sourceEventId: "new-event" }).sourceEventId, "new-event");
  assert.equal(restored.coverage().invalidRecords, 1); assert.equal(restored.coverage().identityComplete, true);
  assert.equal(new XiaomiHomeArtifactStore(f.root).getBySourceEventId("new-event")?.sourceEventId, "new-event");
});

test("unknown ledger identities retain valid reads and replay but never invent absence or a new registration", t => {
  const f = ledgerFixture(t), original = JSON.stringify(f.rows[0]) + "\n{broken\n" + JSON.stringify(f.rows[1]) + "\n";
  fs.writeFileSync(f.ledger, original);
  const store = new XiaomiHomeArtifactStore(f.root); store.activate();
  assert.equal(store.list().length, 2); assert.equal(store.get(f.first.artifactId)?.sourceEventId, "first");
  assert.equal(store.register(f.input).artifactId, f.first.artifactId);
  assert.throws(() => store.register({ ...f.input, sourceEventId: "unproven-new" }), XiaomiHomeArtifactEvidenceError);
  assert.throws(() => store.getBySourceEventId("unproven-new"), XiaomiHomeArtifactEvidenceError);
  assert.throws(() => store.get("unproven-id"), XiaomiHomeArtifactEvidenceError);
  assert.equal(store.coverage().state, "partial"); assert.equal(store.coverage().identityComplete, false);
  assert.deepEqual(store.coverage().samples, [{ shard: "2026-08-29.jsonl", line: 2, reason: "invalid_json" }]);
  assert.equal(fs.readFileSync(f.ledger, "utf8"), original);
  fs.writeFileSync(f.ledger, f.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  store.activate(); assert.equal(store.coverage().state, "complete");
  assert.equal(store.register({ ...f.input, sourceEventId: "unproven-new" }).sourceEventId, "unproven-new");
});

for (const reverse of [false, true]) for (const sameSource of [false, true]) test(`conflicting ledger identities quarantine both claims regardless of row order (${reverse}, source=${sameSource})`, t => {
  const f = ledgerFixture(t), conflict = { ...f.rows[0], ...(sameSource ? { artifactId: "second-artifact" } : { sourceEventId: "second-claim" }) };
  const pair = reverse ? [conflict, f.rows[0]] : [f.rows[0], conflict];
  const original = [...pair, f.rows[1]].map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(f.ledger, original);
  const store = new XiaomiHomeArtifactStore(f.root); store.activate();
  assert.deepEqual(store.list().map(row => row.artifactId), [f.last.artifactId]);
  for (const sourceEventId of sameSource ? ["first"] : ["first", "second-claim"]) assert.throws(() => store.register({ ...f.input, sourceEventId }), XiaomiHomeArtifactEvidenceError);
  assert.equal(store.coverage().blockedSourceEventIds, sameSource ? 1 : 2);
  assert.equal(store.coverage().blockedArtifactIds, sameSource ? 2 : 1);
  assert.equal(fs.readFileSync(f.ledger, "utf8"), original);
});

test("identical complete rows with reordered JSON keys remain a single durable artifact", t => {
  const f = ledgerFixture(t);
  fs.appendFileSync(f.ledger, JSON.stringify(Object.fromEntries(Object.entries(f.rows[0]).reverse())) + "\n");
  const store = new XiaomiHomeArtifactStore(f.root);
  assert.equal(store.list().length, 2); assert.equal(store.coverage().state, "complete");
  assert.equal(store.register(f.input).artifactId, f.first.artifactId);
});

test("known source with missing artifact ID does not block another source; diagnostics are bounded and cloned", t => {
  const f = ledgerFixture(t), damaged = { ...f.rows[0], artifactId: null, sourceEventId: "known-damaged" };
  fs.appendFileSync(f.ledger, Array.from({ length: 20 }, () => JSON.stringify(damaged)).join("\n") + "\n");
  const store = new XiaomiHomeArtifactStore(f.root);
  assert.equal(store.coverage().invalidRecords, 20); assert.equal(store.coverage().samples.length, 8);
  store.coverage().samples.length = 0; assert.equal(store.coverage().samples.length, 8);
  assert.equal(store.register({ ...f.input, sourceEventId: "__proto__" }).sourceEventId, "__proto__");
  assert.throws(() => store.getBySourceEventId("known-damaged"), XiaomiHomeArtifactEvidenceError);
  assert.equal(new XiaomiHomeArtifactStore(f.root).getBySourceEventId("__proto__")?.sourceEventId, "__proto__");
});

test("published artifact HTTP operations disclose partial coverage and exact conflicts while unrelated capabilities stay usable", async t => {
  const f = ledgerFixture(t); fs.appendFileSync(f.ledger, "{invalid\n");
  const artifacts = new XiaomiHomeArtifactStore(f.root); artifacts.activate();
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createXiaomiHomeManagerOperations({ runtime: { artifacts, client: { getCapabilities: () => ({ available: true }) } } as unknown as XiaomiHomeRuntimeController,
    lifecycleFence: { applicationGenerationId: "test-generation", managerInstanceId: "test-manager" }, deliverEvent: async () => undefined });
  const registration = registry.registerOperations("artifact-isolation", definitions.operations);
  const server = http.createServer((request, response) => { markAuthenticatedConnectionRequest(request); if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const get = (suffix: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port, path: "/api/agent/xiaomi-home/" + suffix }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on("error", reject); request.setTimeout(5000, () => request.destroy(new Error("Artifact fixture request timed out.")));
  });
  const list = await get("artifacts"); assert.equal(list.status, 200); assert.equal(list.body.data.length, 2); assert.equal(list.body.coverage.state, "partial");
  assert.equal((await get("artifacts/" + f.first.artifactId)).status, 200);
  const unknown = await get("artifacts/unknown"); assert.equal(unknown.status, 409); assert.equal(unknown.body.error.code, "xiaomi_home_artifact_evidence_unavailable");
  assert.equal((await get("capabilities")).body.data.available, true);
  assert.equal((await get("artifacts/lifecycle")).body.data.coverage.invalidRecords, 1);
});


test("scoped camera identities isolate damaged roles without colliding with legacy source strings", t => {
  const f = ledgerFixture(t);
  const one = f.store.register({ ...f.input, sourceEventId: "shared", ownerRoleId: "RoleA" });
  const two = f.store.register({ ...f.input, sourceEventId: "shared", ownerRoleId: "RoleB" });
  const legacySource = JSON.stringify(["RoleA", "shared"]);
  const legacy = f.store.register({ ...f.input, sourceEventId: legacySource });
  const rows = fs.readFileSync(f.ledger, "utf8").trimEnd().split("\n").map(row => JSON.parse(row));
  rows.push({ ...rows.find(row => row.artifactId === one.artifactId), byteLength: -1 });
  const original = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(f.ledger, original);
  const restored = new XiaomiHomeArtifactStore(f.root); restored.activate();
  assert.throws(() => restored.getBySourceEventId("shared", "RoleA"), XiaomiHomeArtifactEvidenceError);
  assert.throws(() => restored.register({ ...f.input, sourceEventId: "shared", ownerRoleId: "RoleA" }), XiaomiHomeArtifactEvidenceError);
  assert.equal(restored.getBySourceEventId("shared", "RoleB")?.artifactId, two.artifactId);
  assert.equal(restored.register({ ...f.input, sourceEventId: "shared", ownerRoleId: "RoleB" }).artifactId, two.artifactId);
  assert.equal(restored.getBySourceEventId(legacySource)?.artifactId, legacy.artifactId);
  assert.equal(restored.coverage().sourceIdentityComplete, true);
  assert.equal(fs.readFileSync(f.ledger, "utf8"), original);
});

test("invalid persisted camera role cannot prove a new source absent or hide a valid neighbor", t => {
  const f = ledgerFixture(t);
  fs.appendFileSync(f.ledger, JSON.stringify({ ...f.rows[0], artifactId: "bad-role", ownerRoleId: 42 }) + "\n");
  const restored = new XiaomiHomeArtifactStore(f.root);
  assert.equal(restored.register(f.input).artifactId, f.first.artifactId);
  assert.equal(restored.get(f.last.artifactId)?.artifactId, f.last.artifactId);
  assert.throws(() => restored.register({ ...f.input, ownerRoleId: "RoleA" }), XiaomiHomeArtifactEvidenceError);
  assert.equal(restored.coverage().sourceIdentityComplete, false);
});
