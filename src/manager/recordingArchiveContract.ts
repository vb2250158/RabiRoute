import { createHash } from "node:crypto";
import { RESOURCE_HASH_PATTERN, RESOURCE_ID_PATTERN, RESOURCE_NAMESPACE_PATTERN, RESOURCE_ZERO_NAMESPACE, RESOURCE_OBJECT_MAX_BYTES } from "./resourceCacheProtocol.js";
import { RECORDING_ARCHIVE_MAX_BYTES, RECORDING_ARCHIVE_MAX_ITEMS, RECORDING_ARCHIVE_MAX_TIME,
  RECORDING_ARCHIVE_SOURCES, RECORDING_ARCHIVE_TIME_BASES, RECORDING_ARCHIVE_POLICIES,
  recordingManifestSchema, recordingFormatSchema, recordingSegmentSchema, recordingObjectSchema, recordingGapSchema, recordingReceiptSchema } from "./recordingArchiveSchemas.js";
export { RECORDING_ARCHIVE_MAX_BYTES, RECORDING_ARCHIVE_MAX_ITEMS } from "./recordingArchiveSchemas.js";
export interface RecordingManifest {
  schemaVersion: 1;
  recordId: string; captureId: string; eventId: string; deviceId: string;
  source: typeof RECORDING_ARCHIVE_SOURCES[number];
  startedAt: number; endedAt: number;
  timeBasis: typeof RECORDING_ARCHIVE_TIME_BASES[number];
  format: { codec: typeof recordingFormatSchema.properties.codec.const; sampleRate: typeof recordingFormatSchema.properties.sampleRate.const; channels: typeof recordingFormatSchema.properties.channels.const };
  segments: { sequence: number; bytes: number; sha256: string; startedAt: number }[];
  objects: { sha256: string; bytes: number; offset: number }[];
  gaps: { startedAt: number; endedAt: number; reason: string }[];
  processingPolicy: typeof RECORDING_ARCHIVE_POLICIES[number];
  totalBytes: number; sealed: true;
}
export interface ArchiveReceipt {
  schemaVersion: 1; workerId: string; storageNamespaceId: string; recordId: string;
  manifestHash: string; totalBytes: number; segmentCount: number; committedAt: number;
  durability: "archived"; retention: "indefinite";
}
export interface ArchiveReceiptExpectation {
  workerId: string; storageNamespaceId: string; manifest: RecordingManifest;
}
const identityPattern = new RegExp(RESOURCE_ID_PATTERN);
const hashPattern = new RegExp(RESOURCE_HASH_PATTERN);
const namespacePattern = new RegExp(RESOURCE_NAMESPACE_PATTERN);
function fail(name: string): never { throw new TypeError(`Invalid recording archive ${name}`); }
function record(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(name);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(name);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail(name);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return fail(name);
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) return fail(name);
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !identityPattern.test(value)) return fail("identity");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !hashPattern.test(value)) return fail("hash");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !namespacePattern.test(value) || value === RESOURCE_ZERO_NAMESPACE) return fail("namespace");
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("enum");
  return value as T;
}
function list(value: unknown, min: number, name: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > RECORDING_ARCHIVE_MAX_ITEMS) return fail(name);
  // Reject holes, symbols, accessors and extra properties rather than silently canonicalizing them away.
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail(name);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !("value" in d)) return fail(name);
  }
  return value;
}
function bytes(value: unknown, max = RECORDING_ARCHIVE_MAX_BYTES): number {
  const n = integer(value, 2, max, "bytes");
  if (n % 2) return fail("PCM alignment");
  return n;
}
const time = (value: unknown) => integer(value, 0, RECORDING_ARCHIVE_MAX_TIME, "time");
/** Pure validation: returns a detached normalized object. Sequence gaps require caller evidence. */
export function validateRecordingManifest(value: unknown): RecordingManifest {
  const v = record(value, recordingManifestSchema.required, "manifest");
  if (v.schemaVersion !== 1 || v.sealed !== true) return fail("version/seal");
  const startedAt = time(v.startedAt), endedAt = time(v.endedAt), totalBytes = bytes(v.totalBytes);
  if (endedAt <= startedAt || totalBytes / 32 > endedAt - startedAt + 1) return fail("time range");
  const f = record(v.format, recordingFormatSchema.required, "format");
  if (f.codec !== recordingFormatSchema.properties.codec.const || f.sampleRate !== recordingFormatSchema.properties.sampleRate.const || f.channels !== recordingFormatSchema.properties.channels.const) return fail("format");
  let sequence = -1, segmentBytes = 0, previousStart = startedAt;
  const segments = list(v.segments, 1, "segments").map(raw => {
    const s = record(raw, recordingSegmentSchema.required, "segment");
    const seq = integer(s.sequence, 0, Number.MAX_SAFE_INTEGER, "sequence"), size = bytes(s.bytes), start = time(s.startedAt);
    if (seq <= sequence || start < previousStart || start < startedAt || start >= endedAt || size / 32 > endedAt - start + 1) return fail("segment order/time");
    sequence = seq; previousStart = start; segmentBytes += size;
    if (segmentBytes > totalBytes) return fail("segment total");
    return { sequence: seq, bytes: size, sha256: hash(s.sha256), startedAt: start };
  });
  let objectBytes = 0;
  const objects = list(v.objects, 1, "objects").map(raw => {
    const o = record(raw, recordingObjectSchema.required, "object");
    const size = bytes(o.bytes, RESOURCE_OBJECT_MAX_BYTES), offset = integer(o.offset, 0, RECORDING_ARCHIVE_MAX_BYTES, "offset");
    if (offset !== objectBytes) return fail("object offset");
    objectBytes += size;
    if (objectBytes > totalBytes) return fail("object total");
    return { sha256: hash(o.sha256), bytes: size, offset };
  });
  if (segmentBytes !== totalBytes || objectBytes !== totalBytes) return fail("total bytes");
  let gapEnd = startedAt;
  const gaps = list(v.gaps, 0, "gaps").map(raw => {
    const g = record(raw, recordingGapSchema.required, "gap");
    const start = time(g.startedAt), end = time(g.endedAt);
    if (start < gapEnd || end <= start || end > endedAt) return fail("gap time");
    gapEnd = end;
    return { startedAt: start, endedAt: end, reason: id(g.reason) };
  });
  return { schemaVersion: 1, recordId: id(v.recordId), captureId: id(v.captureId), eventId: id(v.eventId), deviceId: id(v.deviceId),
    source: choice(v.source, RECORDING_ARCHIVE_SOURCES), startedAt, endedAt, timeBasis: choice(v.timeBasis, RECORDING_ARCHIVE_TIME_BASES),
    format: { codec: recordingFormatSchema.properties.codec.const, sampleRate: recordingFormatSchema.properties.sampleRate.const, channels: recordingFormatSchema.properties.channels.const }, segments, objects, gaps,
    processingPolicy: choice(v.processingPolicy, RECORDING_ARCHIVE_POLICIES), totalBytes, sealed: true };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function recordingManifestCanonicalJson(value: unknown): string { return canonical(validateRecordingManifest(value)); }
export function recordingManifestHash(value: unknown): string {
  return createHash("sha256").update(recordingManifestCanonicalJson(value), "utf8").digest("hex");
}
/** Weak durable acknowledgements are deliberately not compatible with archive receipts. */
export function validateArchiveReceipt(value: unknown, expected: ArchiveReceiptExpectation): ArchiveReceipt {
  const m = validateRecordingManifest(expected.manifest);
  const workerId = id(expected.workerId), namespace = uuid(expected.storageNamespaceId);
  const v = record(value, recordingReceiptSchema.required, "receipt");
  if (v.schemaVersion !== 1 || v.durability !== "archived" || v.retention !== "indefinite") return fail("receipt guarantees");
  const result: ArchiveReceipt = { schemaVersion: 1, workerId: id(v.workerId), storageNamespaceId: uuid(v.storageNamespaceId), recordId: id(v.recordId),
    manifestHash: hash(v.manifestHash), totalBytes: bytes(v.totalBytes), segmentCount: integer(v.segmentCount, 1, RECORDING_ARCHIVE_MAX_ITEMS, "segment count"),
    committedAt: time(v.committedAt), durability: "archived", retention: "indefinite" };
  if (result.workerId !== workerId || result.storageNamespaceId !== namespace || result.recordId !== m.recordId || result.manifestHash !== recordingManifestHash(m)
      || result.totalBytes !== m.totalBytes || result.segmentCount !== m.segments.length) return fail("receipt identity");
  return result;
}
