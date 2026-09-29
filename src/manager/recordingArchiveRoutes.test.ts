import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { RecordingArchiveStore } from "./recordingArchiveStore.js";
import { recordingManifestHash, type RecordingManifest } from "./recordingArchiveContract.js";
import { recordingArchiveHandler, recordingArchiveObjectHandler, RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES } from "./recordingArchiveRoutes.js";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const ns = "12345678-1234-4234-8234-123456789abc";
async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let readonly = false;
  const store = new RecordingArchiveStore({ resolveOwner: async () => ({ root, storageNamespaceId: ns }), workerId: () => "pc" });
  await store.provision({ root, storageNamespaceId: ns });
  const options = { store, authorize: (req: http.IncomingMessage) => req.headers["x-test-key"] === "secret" ? String(req.headers["x-test-owner"] ?? "") : null, readOnly: () => readonly };
  const handle = recordingArchiveHandler(options), objects = recordingArchiveObjectHandler(options);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://test");
    if (!handle(req, url, res) && !objects(req, url, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/resource-cache/data`;
  const headers = { "x-test-key": "secret", "x-test-owner": "phone" };
  const bytes = Buffer.alloc(3200, 2), digest = sha(bytes);
  const manifest: RecordingManifest = { schemaVersion: 1, recordId: "record", captureId: "capture", eventId: "event", deviceId: "phone", source: "phone", startedAt: 1000, endedAt: 1100, timeBasis: "received", format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, segments: [{ sequence: 1, bytes: bytes.length, sha256: digest, startedAt: 1000 }], objects: [{ sha256: digest, bytes: bytes.length, offset: 0 }], gaps: [], processingPolicy: "transcribe", totalBytes: bytes.length, sealed: true };
  return { root, base, headers, bytes, digest, manifest, setReadonly: (v: boolean) => { readonly = v; } };
}
test("archive HTTP authenticates, preserves objects URL, and returns strong idempotent receipts", async t => {
  const f = await fixture(t), hash = recordingManifestHash(f.manifest);
  assert.equal((await fetch(f.base + "/archive-capabilities")).status, 403);
  assert.equal((await fetch(f.base + "/objects/" + f.digest, { headers: { "x-test-owner": "phone" } })).status, 403);
  const cap = await (await fetch(f.base + "/archive-capabilities", { headers: f.headers })).json() as { maxManifestBytes: number };
  assert.equal(cap.maxManifestBytes, RECORDING_ARCHIVE_HTTP_MAX_MANIFEST_BYTES);
  assert.equal((await fetch(f.base + "/objects/" + f.digest, { method: "PUT", headers: f.headers, body: f.bytes })).status, 200);
  const commit = () => fetch(`${f.base}/recordings/record/manifests/${hash}`, { method: "PUT", headers: f.headers, body: JSON.stringify(f.manifest) });
  const first = await commit(); assert.equal(first.status, 200);
  const receipt = await first.json() as Record<string, unknown>;
  assert.equal(receipt.durability, "archived"); assert.equal(receipt.retention, "indefinite"); assert.equal(receipt.manifestHash, hash); assert.equal(receipt.durable, undefined);
  assert.deepEqual(await (await commit()).json(), receipt);
  assert.deepEqual(await (await fetch(`${f.base}/recordings/record/receipts/${hash}`, { headers: f.headers })).json(), receipt);
  assert.deepEqual(await (await fetch(`${f.base}/recordings/record/manifest`, { headers: f.headers })).json(), f.manifest);
  assert.equal((await fetch(`${f.base}/recordings/record/manifest`, { headers: { ...f.headers, "x-test-owner": "other" } })).status, 404);
  assert.equal((await fetch(f.base + "/objects/" + f.digest, { headers: { ...f.headers, "x-test-owner": "other" } })).status, 404);
  const changed = { ...f.manifest, eventId: "changed" };
  assert.equal((await fetch(`${f.base}/recordings/record/manifests/${recordingManifestHash(changed)}`, { method: "PUT", headers: f.headers, body: JSON.stringify(changed) })).status, 409);
  assert.equal((await fetch(`${f.base}/recordings/record/receipts/${"0".repeat(64)}`, { headers: f.headers })).status, 409);
});
test("archive HTTP bounds bodies, rejects injected ownership and wrong hashes, respects read-only", async t => {
  const f = await fixture(t), url = `${f.base}/recordings/record/manifests/${recordingManifestHash(f.manifest)}`;
  assert.equal((await fetch(url, { method: "POST", headers: f.headers })).status, 405);
  assert.equal((await fetch(url, { method: "PUT", headers: f.headers, body: "{" })).status, 400);
  assert.equal((await fetch(url, { method: "PUT", headers: f.headers, body: JSON.stringify({ ...f.manifest, owner: "other" }) })).status, 400);
  assert.equal((await fetch(`${f.base}/recordings/record/manifests/${"0".repeat(64)}`, { method: "PUT", headers: f.headers, body: JSON.stringify(f.manifest) })).status, 400);
  assert.equal((await fetch(f.base + "/objects/" + f.digest, { method: "PUT", headers: f.headers, body: Buffer.from("bad") })).status, 400);
  assert.equal((await fetch(url, { method: "PUT", headers: f.headers, body: " ".repeat(1024 * 1024 + 1) })).status, 413);
  const streamedStatus = await new Promise<number>((resolve, reject) => {
    const request = http.request(url, { method: "PUT", headers: f.headers }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!));
    });
    request.on("error", reject);
    for (let i = 0; i < 17; i++) request.write(Buffer.alloc(65536, 32));
    request.end();
  });
  assert.equal(streamedStatus, 413);
  f.setReadonly(true);
  assert.equal((await fetch(f.base + "/objects/" + f.digest, { method: "PUT", headers: f.headers, body: f.bytes })).status, 403);
  assert.equal((await fetch(f.base + "/archive-capabilities", { headers: f.headers })).status, 200);
  assert.equal((await fetch(f.base + "/recordings", { headers: f.headers })).status, 404);
  await fs.rename(path.join(f.root, "namespace.json"), path.join(f.root, "offline-marker.json"));
  const offline = await fetch(f.base + "/archive-capabilities", { headers: f.headers });
  assert.equal(offline.status, 503); assert.deepEqual(await offline.json(), { code: "archive_unavailable" });
});
