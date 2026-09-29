import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateRecordingManifest, recordingManifestHash, recordingManifestCanonicalJson, validateArchiveReceipt } from "./recordingArchiveContract.js";
const fixture = () => ({ schemaVersion: 1, recordId: "record-1", captureId: "capture-1", eventId: "event-1", deviceId: "device-1", source: "phone", startedAt: 1000, endedAt: 3000, timeBasis: "received", format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, segments: [{ sequence: 2, bytes: 32000, sha256: "a".repeat(64), startedAt: 1000 }, { sequence: 4, bytes: 32000, sha256: "b".repeat(64), startedAt: 2000 }], objects: [{ sha256: "a".repeat(64), bytes: 32000, offset: 0 }, { sha256: "b".repeat(64), bytes: 32000, offset: 32000 }], gaps: [], processingPolicy: "transcribe", totalBytes: 64000, sealed: true });
const namespace = "12345678-1234-4234-8234-123456789abc";
function receipt() { const manifest = validateRecordingManifest(fixture()); return { manifest, expected: { workerId: "worker-1", storageNamespaceId: namespace, manifest }, value: { schemaVersion: 1, workerId: "worker-1", storageNamespaceId: namespace, recordId: manifest.recordId, manifestHash: recordingManifestHash(manifest), totalBytes: manifest.totalBytes, segmentCount: 2, committedAt: 4000, durability: "archived", retention: "indefinite" } }; }

test("manifest validation is detached, canonical sorting deterministic and hash UTF8", () => {
  const input = fixture(), valid = validateRecordingManifest(input);
  assert.notEqual(valid.segments, input.segments);
  // Shared golden with Android RecordingArchiveContractTest.normalizedDetachedCanonicalFixture.
  assert.equal(recordingManifestHash(input), "c272627f1bec72e289cdd190fdf3534229e8b8a1062d11c28631b7339abc7a7b");
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reverse(v)])) : value;
  assert.equal(recordingManifestHash(input), recordingManifestHash(reverse(input)));
  assert.equal(recordingManifestHash(input), createHash("sha256").update(recordingManifestCanonicalJson(input), "utf8").digest("hex"));
  input.recordId = "other"; assert.equal(valid.recordId, "record-1");
});
test("array order is retained, offsets and sequence cannot be reordered", () => {
  const a = fixture(); a.objects.reverse(); assert.throws(() => validateRecordingManifest(a));
  const b = fixture(); b.segments.reverse(); assert.throws(() => validateRecordingManifest(b));
  const c = fixture(); c.objects[0].sha256 = "c".repeat(64); assert.notEqual(recordingManifestHash(c), recordingManifestHash(fixture()));
});
test("malformed root, unknown fields and identity injection rejected", () => {
  for (const value of [null, undefined, [], 1, { ...fixture(), owner: "other" }, { ...fixture(), roleId: "other" }, { ...fixture(), recordId: "../record" }, { ...fixture(), captureId: "a/b" }, { ...fixture(), deviceId: "\u4e2d" }, { ...fixture(), recordId: "a".repeat(129) }, { ...fixture(), sealed: false }, { ...fixture(), schemaVersion: 2 }]) assert.throws(() => validateRecordingManifest(value));
  const accessor = fixture(); Object.defineProperty(accessor, "recordId", { get: () => "record", enumerable: true }); assert.throws(() => validateRecordingManifest(accessor));
  const symbol = fixture(); Object.defineProperty(symbol, Symbol("hidden"), { value: true }); assert.throws(() => validateRecordingManifest(symbol));
});
test("unsafe numbers, invalid format, totals, negative/overlapping offsets rejected", () => {
  for (const number of [-1, -0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assert.throws(() => validateRecordingManifest({ ...fixture(), startedAt: number }));
    const f = fixture(); f.objects[0].offset = number; assert.throws(() => validateRecordingManifest(f));
  }
  for (const totalBytes of [0, 3, 64002, 128 * 1024 * 1024 + 2]) assert.throws(() => validateRecordingManifest({ ...fixture(), totalBytes }));
  for (const format of [{ codec: "wav", sampleRate: 16000, channels: 1 }, { codec: "pcm_s16le", sampleRate: 48000, channels: 1 }, { codec: "pcm_s16le", sampleRate: 16000, channels: 2 }, { ...fixture().format, owner: "injected" }]) assert.throws(() => validateRecordingManifest({ ...fixture(), format }));
  const f = fixture(); f.objects[1].offset = 0; assert.throws(() => validateRecordingManifest(f));
});
test("object bounds, sparse arrays, invalid hash and time ranges rejected", () => {
  const f = fixture(); f.objects[0].bytes = 1024 * 1024 + 2; assert.throws(() => validateRecordingManifest(f));
  assert.throws(() => validateRecordingManifest({ ...fixture(), objects: new Array(2) }));
  assert.throws(() => validateRecordingManifest({ ...fixture(), objects: Array(4097).fill(fixture().objects[0]) }));
  assert.throws(() => validateRecordingManifest({ ...fixture(), segments: [] }));
  const h = fixture(); h.segments[0].sha256 = "A".repeat(64); assert.throws(() => validateRecordingManifest(h));
  assert.throws(() => validateRecordingManifest({ ...fixture(), endedAt: 1001 }));
  assert.throws(() => validateRecordingManifest({ ...fixture(), gaps: [{ startedAt: 2000, endedAt: 1000, reason: "lost" }] }));
});
test("strong receipt requires exact expected identity and archived indefinite guarantees", () => {
  const r = receipt(); assert.equal(validateArchiveReceipt(r.value, r.expected).recordId, "record-1");
  for (const patch of [{ workerId: "worker-2" }, { storageNamespaceId: "12345678-1234-4234-8234-123456789abd" }, { storageNamespaceId: "../namespace" }, { recordId: "record-2" }, { manifestHash: "c".repeat(64) }, { totalBytes: 32000 }, { segmentCount: 1 }, { durability: "durable" }, { retention: "24h" }, { committedAt: Infinity }, { owner: "injected" }]) assert.throws(() => validateArchiveReceipt({ ...r.value, ...patch }, r.expected));
  assert.throws(() => validateArchiveReceipt({ durable: true }, r.expected));
  assert.throws(() => validateArchiveReceipt({ ...r.value, durable: true }, r.expected));
});
