import { createHash } from "node:crypto";

export const RECORDING_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const RECORDING_ARCHIVE_MAX_ITEMS = 4096;
export interface RecordingManifest {
  schemaVersion: 1;
  recordId: string; captureId: string; eventId: string; deviceId: string;
  source: "phone" | "glasses" | "video";
  startedAt: number; endedAt: number;
  timeBasis: "received" | "media" | "imported";
  format: { codec: "pcm_s16le"; sampleRate: 16000; channels: 1 };
  segments: { sequence: number; bytes: number; sha256: string; startedAt: number }[];
  objects: { sha256: string; bytes: number; offset: number }[];
  gaps: { startedAt: number; endedAt: number; reason: string }[];
  processingPolicy: "transcribe" | "agent" | "local_only";
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
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return fail("identity");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return fail("hash");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return fail("namespace");
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
const time = (value: unknown) => integer(value, 0, 8_640_000_000_000_000, "time");
/** Pure validation: returns a detached normalized object. Sequence gaps require caller evidence. */
export function validateRecordingManifest(value: unknown): RecordingManifest {
  const v = record(value, ["schemaVersion", "recordId", "captureId", "eventId", "deviceId", "source", "startedAt", "endedAt", "timeBasis", "format", "segments", "objects", "gaps", "processingPolicy", "totalBytes", "sealed"], "manifest");
  if (v.schemaVersion !== 1 || v.sealed !== true) return fail("version/seal");
  const startedAt = time(v.startedAt), endedAt = time(v.endedAt), totalBytes = bytes(v.totalBytes);
  if (endedAt <= startedAt || totalBytes / 32 > endedAt - startedAt + 1) return fail("time range");
  const f = record(v.format, ["codec", "sampleRate", "channels"], "format");
  if (f.codec !== "pcm_s16le" || f.sampleRate !== 16000 || f.channels !== 1) return fail("format");
  let sequence = -1, segmentBytes = 0, previousStart = startedAt;
  const segments = list(v.segments, 1, "segments").map(raw => {
    const s = record(raw, ["sequence", "bytes", "sha256", "startedAt"], "segment");
    const seq = integer(s.sequence, 0, Number.MAX_SAFE_INTEGER, "sequence"), size = bytes(s.bytes), start = time(s.startedAt);
    if (seq <= sequence || start < previousStart || start < startedAt || start >= endedAt || size / 32 > endedAt - start + 1) return fail("segment order/time");
    sequence = seq; previousStart = start; segmentBytes += size;
    if (segmentBytes > totalBytes) return fail("segment total");
    return { sequence: seq, bytes: size, sha256: hash(s.sha256), startedAt: start };
  });
  let objectBytes = 0;
  const objects = list(v.objects, 1, "objects").map(raw => {
    const o = record(raw, ["sha256", "bytes", "offset"], "object");
    const size = bytes(o.bytes, 1024 * 1024), offset = integer(o.offset, 0, RECORDING_ARCHIVE_MAX_BYTES, "offset");
    if (offset !== objectBytes) return fail("object offset");
    objectBytes += size;
    if (objectBytes > totalBytes) return fail("object total");
    return { sha256: hash(o.sha256), bytes: size, offset };
  });
  if (segmentBytes !== totalBytes || objectBytes !== totalBytes) return fail("total bytes");
  let gapEnd = startedAt;
  const gaps = list(v.gaps, 0, "gaps").map(raw => {
    const g = record(raw, ["startedAt", "endedAt", "reason"], "gap");
    const start = time(g.startedAt), end = time(g.endedAt);
    if (start < gapEnd || end <= start || end > endedAt) return fail("gap time");
    gapEnd = end;
    return { startedAt: start, endedAt: end, reason: id(g.reason) };
  });
  return { schemaVersion: 1, recordId: id(v.recordId), captureId: id(v.captureId), eventId: id(v.eventId), deviceId: id(v.deviceId),
    source: choice(v.source, ["phone", "glasses", "video"]), startedAt, endedAt, timeBasis: choice(v.timeBasis, ["received", "media", "imported"]),
    format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, segments, objects, gaps,
    processingPolicy: choice(v.processingPolicy, ["transcribe", "agent", "local_only"]), totalBytes, sealed: true };
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
  const v = record(value, ["schemaVersion", "workerId", "storageNamespaceId", "recordId", "manifestHash", "totalBytes", "segmentCount", "committedAt", "durability", "retention"], "receipt");
  if (v.schemaVersion !== 1 || v.durability !== "archived" || v.retention !== "indefinite") return fail("receipt guarantees");
  const result: ArchiveReceipt = { schemaVersion: 1, workerId: id(v.workerId), storageNamespaceId: uuid(v.storageNamespaceId), recordId: id(v.recordId),
    manifestHash: hash(v.manifestHash), totalBytes: bytes(v.totalBytes), segmentCount: integer(v.segmentCount, 1, RECORDING_ARCHIVE_MAX_ITEMS, "segment count"),
    committedAt: time(v.committedAt), durability: "archived", retention: "indefinite" };
  if (result.workerId !== workerId || result.storageNamespaceId !== namespace || result.recordId !== m.recordId || result.manifestHash !== recordingManifestHash(m)
      || result.totalBytes !== m.totalBytes || result.segmentCount !== m.segments.length) return fail("receipt identity");
  return result;
}
