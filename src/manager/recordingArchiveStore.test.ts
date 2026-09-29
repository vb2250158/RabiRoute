import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { RecordingArchiveStore } from "./recordingArchiveStore.js";
import { recordingManifestHash, type RecordingManifest } from "./recordingArchiveContract.js";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = { root, storageNamespaceId: randomUUID() };
  const options = { resolveOwner: async (_owner: string) => target, workerId: () => "pc-a" };
  const store = new RecordingArchiveStore(options);
  await store.provision(target);
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const manifest: RecordingManifest = { schemaVersion: 1, recordId: "record-a", captureId: "capture-a", eventId: "event-a", deviceId: "phone-a",
    source: "phone", startedAt: 1000, endedAt: 1001, timeBasis: "received", format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
    segments: [{ sequence: 1, bytes: 4, sha256: sha(bytes.subarray(0, 4)), startedAt: 1000 }, { sequence: 2, bytes: 4, sha256: sha(bytes.subarray(4)), startedAt: 1000 }],
    objects: [{ sha256: sha(bytes.subarray(0, 6)), bytes: 6, offset: 0 }, { sha256: sha(bytes.subarray(6)), bytes: 2, offset: 6 }],
    gaps: [], processingPolicy: "transcribe", totalBytes: 8, sealed: true };
  const upload = async () => { for (const object of manifest.objects) await store.putObject("phone-a", object.sha256, bytes.subarray(object.offset, object.offset + object.bytes)); };
  const commit = () => store.commitManifest("phone-a", manifest.recordId, recordingManifestHash(manifest), manifest);
  return { root, target, options, store, bytes, manifest, upload, commit };
}
test("archive objects and segment hashes cross object boundaries; restart recovers same receipt", async t => {
  const f = await fixture(t); await f.upload(); const receipt = await f.commit();
  assert.equal(receipt.durability, "archived"); assert.equal(receipt.retention, "indefinite");
  const restarted = new RecordingArchiveStore(f.options);
  assert.deepEqual(await restarted.readReceipt("phone-a", f.manifest.recordId, recordingManifestHash(f.manifest)), receipt);
  assert.deepEqual(await f.commit(), receipt);
  assert.deepEqual(await restarted.getManifest("phone-a", f.manifest.recordId), f.manifest);
});
test("namespace never auto-provisions or recreates missing roots", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.provision({ ...f.target, storageNamespaceId: randomUUID() }), /namespace mismatch/);
  await fs.rm(path.join(f.root, "namespace.json"));
  await assert.rejects(f.store.putObject("phone-a", sha(f.bytes), f.bytes));
  await assert.rejects(f.store.capabilities("phone-a"));
  const missingRoot = path.join(f.root, "absent");
  const missingStore = new RecordingArchiveStore({ ...f.options, resolveOwner: async () => ({ ...f.target, root: missingRoot }) });
  await assert.rejects(missingStore.provision({ ...f.target, root: missingRoot }));
  await assert.rejects(missingStore.putObject("phone-a", sha(f.bytes), f.bytes));
  await assert.rejects(fs.stat(missingRoot));
});
test("bad checksums and cross-owner reads fail closed; legacy local objects are not evidence", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.putObject("phone-a", sha(f.bytes), Buffer.from([0, 0])));
  await assert.rejects(f.store.putObject("../phone", sha(f.bytes), f.bytes));
  await assert.rejects(f.store.putObject("phone-a", "../object", f.bytes));
  await fs.mkdir(path.join(f.root, "legacy-cache"));
  await fs.writeFile(path.join(f.root, "legacy-cache", sha(f.bytes)), f.bytes);
  await assert.rejects(f.commit());
  await f.upload(); await f.commit();
  await assert.rejects(f.store.readObject("phone-b", f.manifest.objects[0].sha256));
  await assert.rejects(f.store.getManifest("phone-b", f.manifest.recordId));
  await assert.rejects(f.store.commitManifest("phone-b", f.manifest.recordId, recordingManifestHash(f.manifest), f.manifest));
});
test("missing or corrupted media cannot publish a partial manifest or return an archive receipt", async t => {
  const f = await fixture(t);
  await f.store.putObject("phone-a", f.manifest.objects[0].sha256, f.bytes.subarray(0, 6));
  await assert.rejects(f.commit());
  await assert.rejects(f.store.getManifest("phone-a", f.manifest.recordId));
  await f.upload();
  const wrong = structuredClone(f.manifest); wrong.segments[0].sha256 = sha(Buffer.from([0, 0, 0, 0]));
  await assert.rejects(f.store.commitManifest("phone-a", wrong.recordId, recordingManifestHash(wrong), wrong), /segment integrity/);
  await f.commit();
  const object = f.manifest.objects[0];
  await fs.writeFile(path.join(f.root, "objects", sha("phone-a"), object.sha256.slice(0, 2), object.sha256), Buffer.alloc(6));
  await assert.rejects(f.store.readReceipt("phone-a", f.manifest.recordId, recordingManifestHash(f.manifest)), /integrity/);
  await assert.rejects(f.store.putObject("phone-a", object.sha256, f.bytes.subarray(0, 6)), /integrity/);
});
test("independent instances cannot overwrite a record; equal concurrent commits return one receipt", async t => {
  const f = await fixture(t); await f.upload(); const other = new RecordingArchiveStore(f.options);
  const [a, b] = await Promise.all([f.commit(), other.commitManifest("phone-a", f.manifest.recordId, recordingManifestHash(f.manifest), f.manifest)]);
  assert.deepEqual(a, b);
  const changed = structuredClone(f.manifest); changed.processingPolicy = "agent";
  await assert.rejects(other.commitManifest("phone-a", changed.recordId, recordingManifestHash(changed), changed), /conflict/);
  assert.deepEqual(await f.store.getManifest("phone-a", f.manifest.recordId), f.manifest);
  const partial = path.join(f.root, "manifests", sha("phone-a"), sha("never-published") + ".json.partial");
  await fs.writeFile(partial, "incomplete");
  await assert.rejects(other.getManifest("phone-a", "never-published"));
});
test("catalog reads verify device ownership without scanning media; eviction receipts still verify media", async t => {
  const f = await fixture(t); await f.upload(); const receipt = await f.commit();
  const object = f.manifest.objects[0];
  await fs.rm(path.join(f.root, "objects", sha("phone-a"), object.sha256.slice(0, 2), object.sha256));
  assert.deepEqual(await f.store.getRecord("phone-a", f.manifest.recordId), { manifest: f.manifest, receipt });
  await assert.rejects(f.store.readReceipt("phone-a", f.manifest.recordId, receipt.manifestHash));
  const file = path.join(f.root, "manifests", sha("phone-a"), sha(f.manifest.recordId) + ".json");
  const envelope = JSON.parse(await fs.readFile(file, "utf8"));
  envelope.manifest.deviceId = "phone-b";
  envelope.receipt.manifestHash = recordingManifestHash(envelope.manifest);
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(f.store.getRecord("phone-a", f.manifest.recordId), /device owner mismatch/);
  await assert.rejects(f.store.getManifest("phone-a", f.manifest.recordId), /device owner mismatch/);
  await assert.rejects(f.store.readReceipt("phone-a", f.manifest.recordId, envelope.receipt.manifestHash), /device owner mismatch/);
});
test("notification failures do not revoke committed truth; wrong namespace rejects old receipts", async t => {
  const f = await fixture(t); await f.upload();
  const notifier = new RecordingArchiveStore({ ...f.options, committed: () => { throw new Error("subscriber unavailable"); } });
  const receipt = await notifier.commitManifest("phone-a", f.manifest.recordId, recordingManifestHash(f.manifest), f.manifest);
  assert.deepEqual(await f.store.readReceipt("phone-a", f.manifest.recordId, receipt.manifestHash), receipt);
  const wrong = new RecordingArchiveStore({ ...f.options, resolveOwner: async () => ({ ...f.target, storageNamespaceId: randomUUID() }) });
  await assert.rejects(wrong.getManifest("phone-a", f.manifest.recordId), /namespace mismatch/);
});
