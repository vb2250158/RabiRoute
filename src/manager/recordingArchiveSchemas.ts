import { RESOURCE_OBJECT_MAX_BYTES, exactResourceObject, freezeResourceSchema, resourceHashSchema, resourceIdentitySchema, resourceNamespaceSchema } from "./resourceCacheProtocol.js";

export const RECORDING_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const RECORDING_ARCHIVE_MAX_ITEMS = 4096;
export const RECORDING_ARCHIVE_MAX_MANIFEST_BYTES = 1024 * 1024;
export const RECORDING_ARCHIVE_MAX_TIME = 8_640_000_000_000_000;
export const RECORDING_ARCHIVE_SOURCES = ["phone", "glasses", "video"] as const;
export const RECORDING_ARCHIVE_TIME_BASES = ["received", "media", "imported"] as const;
export const RECORDING_ARCHIVE_POLICIES = ["transcribe", "agent", "local_only"] as const;
export const RECORDING_ARCHIVE_PROCESSING_STATES = Object.freeze(["not_requested", "queued", "running", "completed", "failed", "blocked", "ambiguous", "unavailable"] as const);
export const RECORDING_ARCHIVE_CATALOG_LIMIT = 100;
export const RECORDING_ARCHIVE_CATALOG_DEFAULT_LIMIT = 50;
export const RECORDING_ARCHIVE_CURSOR_MAX_LENGTH = 4096;
export const archiveBindingIdentitySchema = { ...resourceIdentitySchema, not: { enum: ["__proto__", "prototype", "constructor"] } };
export const archiveAdminInputSchema = exactResourceObject({ owner: archiveBindingIdentitySchema, roleId: archiveBindingIdentitySchema,
  storageNamespaceId: resourceNamespaceSchema, provision: { type: "boolean" }, enabled: { type: "boolean" },
  expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } });
export const archiveCatalogQuerySchema = freezeResourceSchema({ type: "object", properties: {
  cursor: { type: "string", maxLength: RECORDING_ARCHIVE_CURSOR_MAX_LENGTH },
  limit: { type: "string", pattern: "^\\d+$", description: `Normalized integer in 1..${RECORDING_ARCHIVE_CATALOG_LIMIT}; default ${RECORDING_ARCHIVE_CATALOG_DEFAULT_LIMIT}.` }, from: { type: "string", pattern: "^\\d+$" }, to: { type: "string", pattern: "^\\d+$" },
  source: { type: "string", enum: RECORDING_ARCHIVE_SOURCES }
}, additionalProperties: false });
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const time = integer(0, RECORDING_ARCHIVE_MAX_TIME);
const pcmBytes = (maximum: number) => ({ ...integer(2, maximum), multipleOf: 2 });
const list = (items: unknown, minimum: number) => ({ type: "array", items, minItems: minimum, maxItems: RECORDING_ARCHIVE_MAX_ITEMS });
export const recordingFormatSchema = exactResourceObject({ codec: { const: "pcm_s16le" as const }, sampleRate: { const: 16000 as const }, channels: { const: 1 as const } });
export const recordingSegmentSchema = exactResourceObject({ sequence: integer(0, Number.MAX_SAFE_INTEGER), bytes: pcmBytes(RECORDING_ARCHIVE_MAX_BYTES), sha256: resourceHashSchema, startedAt: time });
export const recordingObjectSchema = exactResourceObject({ sha256: resourceHashSchema, bytes: pcmBytes(RESOURCE_OBJECT_MAX_BYTES), offset: integer(0, RECORDING_ARCHIVE_MAX_BYTES) });
export const recordingGapSchema = exactResourceObject({ startedAt: time, endedAt: time, reason: resourceIdentitySchema });
export const recordingManifestSchema = exactResourceObject({ schemaVersion: { const: 1 }, recordId: resourceIdentitySchema,
  captureId: resourceIdentitySchema, eventId: resourceIdentitySchema, deviceId: resourceIdentitySchema,
  source: { type: "string", enum: RECORDING_ARCHIVE_SOURCES }, startedAt: time, endedAt: time,
  timeBasis: { type: "string", enum: RECORDING_ARCHIVE_TIME_BASES }, format: recordingFormatSchema,
  segments: list(recordingSegmentSchema, 1), objects: list(recordingObjectSchema, 1), gaps: list(recordingGapSchema, 0),
  processingPolicy: { type: "string", enum: RECORDING_ARCHIVE_POLICIES }, totalBytes: pcmBytes(RECORDING_ARCHIVE_MAX_BYTES), sealed: { const: true }
});
export const recordingReceiptSchema = exactResourceObject({ schemaVersion: { const: 1 }, workerId: resourceIdentitySchema,
  storageNamespaceId: resourceNamespaceSchema, recordId: resourceIdentitySchema, manifestHash: resourceHashSchema,
  totalBytes: pcmBytes(RECORDING_ARCHIVE_MAX_BYTES), segmentCount: integer(1, RECORDING_ARCHIVE_MAX_ITEMS), committedAt: time,
  durability: { const: "archived" }, retention: { const: "indefinite" }
});
