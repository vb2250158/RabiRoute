import type { ApiBodyContract, ApiOperationContract, ApiResponseContract, ApiSchema } from "./apiOperationContract.js";
import { RESOURCE_OBJECT_MAX_BYTES, RESOURCE_SETTINGS_MAX_BYTES, RESOURCE_DIRECTORY_MAX_LENGTH, MOBILE_RECORDING_MAX_CHUNKS, MOBILE_RECORDING_TEXT_MAX_CODE_UNITS,
  MOBILE_RECORDING_EVENT_ID_PATTERN, MOBILE_RECORDING_TRANSCRIPTION_STATES, resourceHashSchema, resourceIdentitySchema, resourceNamespaceSchema } from "./resourceCacheProtocol.js";
import { archiveAdminInputSchema, archiveBindingIdentitySchema, archiveCatalogQuerySchema, recordingManifestSchema, recordingReceiptSchema,
  RECORDING_ARCHIVE_MAX_MANIFEST_BYTES, RECORDING_ARCHIVE_SOURCES, RECORDING_ARCHIVE_POLICIES, RECORDING_ARCHIVE_PROCESSING_STATES, RECORDING_ARCHIVE_CATALOG_LIMIT } from "./recordingArchiveSchemas.js";

/** This table owns the published paths and the compatibility adapters' selection. */
export const RESOURCE_API_ROUTES = Object.freeze([
  { key: "settings.read", family: "cache", method: "GET", pathTemplate: "/api/resource-cache/settings" },
  { key: "settings.update", family: "cache", method: "PUT", pathTemplate: "/api/resource-cache/settings" },
  { key: "archive-settings.read", family: "admin", method: "GET", pathTemplate: "/api/resource-cache/archive-settings" },
  { key: "archive-settings.update", family: "admin", method: "PUT", pathTemplate: "/api/resource-cache/archive-settings" },
  { key: "object.read", family: "object", method: "GET", pathTemplate: "/api/resource-cache/data/objects/:objectHash" },
  { key: "object.write", family: "object", method: "PUT", pathTemplate: "/api/resource-cache/data/objects/:objectHash" },
  { key: "archive.capabilities", family: "archive", method: "GET", pathTemplate: "/api/resource-cache/data/archive-capabilities" },
  { key: "archive.recordings.list", family: "archive", method: "GET", pathTemplate: "/api/resource-cache/data/recordings" },
  { key: "archive.processing.read", family: "archive", method: "GET", pathTemplate: "/api/resource-cache/data/recordings/:recordId/processing" },
  { key: "archive.manifest.read", family: "archive", method: "GET", pathTemplate: "/api/resource-cache/data/recordings/:recordId/manifest" },
  { key: "archive.manifest.commit", family: "archive", method: "PUT", pathTemplate: "/api/resource-cache/data/recordings/:recordId/manifests/:manifestHash" },
  { key: "archive.receipt.read", family: "archive", method: "GET", pathTemplate: "/api/resource-cache/data/recordings/:recordId/receipts/:manifestHash" },
  { key: "recording-events.write", family: "cache", method: "PUT", pathTemplate: "/api/resource-cache/data/recording-events" }
] as const);
for (const route of RESOURCE_API_ROUTES) Object.freeze(route);
export type ResourceApiRoute = typeof RESOURCE_API_ROUTES[number];
export type ResourceApiKey = ResourceApiRoute["key"];
export type ResourceApiTarget = Readonly<{ route: ResourceApiRoute; path: Readonly<Record<string, string>> }>;
const patterns = RESOURCE_API_ROUTES.map(route => {
  const names: string[] = [];
  const pattern = route.pathTemplate.split("/").map(segment => {
    if (segment.startsWith(":")) { names.push(segment.slice(1)); return "([^/]+)"; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { route, names, pattern: new RegExp(`^${pattern}$`) };
});
export function selectResourceApiTarget(url: URL, method?: string): ResourceApiTarget | undefined {
  const matches: ResourceApiTarget[] = [];
  for (const entry of patterns) {
    const match = entry.pattern.exec(url.pathname); if (!match) continue;
    const path: Record<string, string> = Object.create(null); let valid = true;
    entry.names.forEach((name, index) => {
      const value = match[index + 1]!;
      const schema = name.endsWith("Hash") ? resourceHashSchema : resourceIdentitySchema;
      if (!new RegExp(schema.pattern).test(value)) valid = false;
      path[name] = value;
    });
    if (valid) matches.push({ route: entry.route, path });
  }
  return matches.find(target => target.route.method === method) ?? matches[0];
}
export const resourceRoute = (key: ResourceApiKey): ResourceApiRoute => RESOURCE_API_ROUTES.find(route => route.key === key)!;

const text = { type: "string" }, bool = { type: "boolean" }, integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const binding = { type: "object", required: ["roleId", "storageNamespaceId", "bindingRevision", "enabled"], properties: {
  roleId: archiveBindingIdentitySchema, storageNamespaceId: resourceNamespaceSchema, bindingRevision: { ...integer, minimum: 1 }, enabled: bool
}, additionalProperties: false };
const bindings = { type: "object", propertyNames: archiveBindingIdentitySchema, additionalProperties: binding };
const adminResult: ApiSchema = { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, duplicate: bool,
  data: { type: "object", required: ["workerId", "revision", "ownerRoleBindings"], properties: { workerId: text, revision: integer, ownerRoleBindings: bindings }, additionalProperties: false }
}, additionalProperties: false };
const processingProperties = { state: { type: "string", enum: RECORDING_ARCHIVE_PROCESSING_STATES }, text, jobKey: text, processingVersion: text };
const recordRow = { type: "object", required: ["recordId", "captureId", "eventId", "deviceId", "source", "startedAt", "endedAt", "totalBytes", "manifestHash", "manifestReference", "processingPolicy", "asrState"], properties: {
  recordId: resourceIdentitySchema, captureId: resourceIdentitySchema, eventId: resourceIdentitySchema, deviceId: resourceIdentitySchema,
  source: { type: "string", enum: RECORDING_ARCHIVE_SOURCES }, startedAt: integer, endedAt: integer, totalBytes: integer, manifestHash: resourceHashSchema,
  manifestReference: { type: "string", description: "Reference relative to the existing /api/resource-cache/data resources root." }, processingPolicy: { type: "string", enum: RECORDING_ARCHIVE_POLICIES }, asrState: { type: "string", enum: RECORDING_ARCHIVE_PROCESSING_STATES }, text, jobKey: text, processingVersion: text
}, additionalProperties: false };
export const mobileResourceEventSchema: ApiSchema = { type: "object", required: ["id", "startedAt", "endedAt", "text", "chunks"], properties: {
  id: { type: "string", pattern: MOBILE_RECORDING_EVENT_ID_PATTERN }, startedAt: { description: "Converted with Number; the recording owner validates finite, ordered timestamps." },
  endedAt: { description: "Converted with Number and bounded by the recording owner's current clock." },
  text: { type: "string", maxLength: MOBILE_RECORDING_TEXT_MAX_CODE_UNITS },
  chunks: { type: "array", minItems: 1, maxItems: MOBILE_RECORDING_MAX_CHUNKS, items: resourceHashSchema },
  transcriptionState: { type: "string", enum: MOBILE_RECORDING_TRANSCRIPTION_STATES }
}, additionalProperties: true };
const json = (schema: ApiSchema): ApiResponseContract => ({ mediaType: "application/json", schema });
const failure = json({ type: "object", anyOf: [{ required: ["code"], properties: { code: {} } }, { required: ["message"], properties: { message: {} } }], properties: {
  code: { anyOf: [text, { type: "integer" }] }, message: text, commitState: text, nextAction: text
}, additionalProperties: true });
function bodyFor(key: ResourceApiKey): ApiBodyContract {
  if (key === "object.write") return { kind: "binary", mediaType: "application/octet-stream", maxBytes: RESOURCE_OBJECT_MAX_BYTES, allowAnyContentType: true,
    rules: ["The existing object owner reads at most the declared byte limit, requires nonempty bytes and verifies the path SHA-256.", "Content-Type does not transform these raw bytes."] };
  if (key === "settings.update") return { kind: "json", maxBytes: RESOURCE_SETTINGS_MAX_BYTES, allowAnyContentType: true,
    schema: { type: "object", required: ["directory"], properties: { directory: { type: "string", maxLength: RESOURCE_DIRECTORY_MAX_LENGTH } }, additionalProperties: true } };
  if (key === "archive-settings.update") return { kind: "json", maxBytes: RESOURCE_SETTINGS_MAX_BYTES, schema: archiveAdminInputSchema };
  if (key === "archive.manifest.commit") return { kind: "json", maxBytes: RECORDING_ARCHIVE_MAX_MANIFEST_BYTES, allowAnyContentType: true, schema: recordingManifestSchema };
  if (key === "recording-events.write") return { kind: "json", maxBytes: RESOURCE_OBJECT_MAX_BYTES, allowAnyContentType: true, schema: mobileResourceEventSchema };
  return { kind: "none" };
}
function responseFor(key: ResourceApiKey): ApiResponseContract {
  if (key.startsWith("settings.")) return json({ type: "object", required: ["directory"], properties: { directory: text }, additionalProperties: true });
  if (key.startsWith("archive-settings.")) return { ...json(adminResult), headers: { type: "object", required: ["etag"], properties: { etag: { type: "string", pattern: '^"[^"\\r\\n]+"$' } }, additionalProperties: true } };
  if (key === "object.read") return { mediaType: "application/octet-stream", binary: { minBytes: 1, maxBytes: RESOURCE_OBJECT_MAX_BYTES } };
  if (key === "object.write") return json({ anyOf: [
    { type: "object", required: ["id", "bytes", "sha256", "durable"], properties: { id: resourceHashSchema, bytes: integer, sha256: resourceHashSchema, durable: { const: true, description: "Legacy persistence acknowledgement, not an archive receipt or phone-original eviction authority." } }, additionalProperties: false },
    { type: "object", required: ["sha256", "bytes", "storageNamespaceId"], properties: { sha256: resourceHashSchema, bytes: integer, storageNamespaceId: resourceNamespaceSchema }, additionalProperties: false }
  ] });
  if (key === "archive.capabilities") return json({ type: "object", required: ["protocol", "storageNamespaceId", "workerId", "maxObjectBytes", "maxManifestBytes", "bindingRevision", "uploadAllowed"], properties: {
    protocol: { const: "record-archive-v1" }, storageNamespaceId: resourceNamespaceSchema, workerId: resourceIdentitySchema,
    maxObjectBytes: { const: RESOURCE_OBJECT_MAX_BYTES }, maxManifestBytes: { const: RECORDING_ARCHIVE_MAX_MANIFEST_BYTES }, bindingRevision: { ...integer, minimum: 1 }, uploadAllowed: { const: true }
  }, additionalProperties: false });
  if (key === "archive.recordings.list") return json({ type: "object", required: ["items", "nextCursor", "snapshotRevision", "storageNamespaceId", "offline", "lastSyncedAt"], properties: {
    items: { type: "array", maxItems: RECORDING_ARCHIVE_CATALOG_LIMIT, items: recordRow }, nextCursor: { anyOf: [text, { type: "null" }] }, snapshotRevision: text, storageNamespaceId: resourceNamespaceSchema, offline: bool, lastSyncedAt: integer
  }, additionalProperties: false });
  if (key === "archive.processing.read") return json({ type: "object", required: ["recordId", "manifestHash", "state"], properties: { recordId: resourceIdentitySchema, manifestHash: resourceHashSchema, ...processingProperties }, additionalProperties: false });
  if (key === "archive.manifest.read") return json(recordingManifestSchema);
  if (key === "archive.manifest.commit" || key === "archive.receipt.read") return json(recordingReceiptSchema);
  return json({ type: "object", required: ["durable"], properties: { durable: { const: true, description: "Legacy mobile-event persistence acknowledgement, not NAS archival or eviction authority." } }, additionalProperties: false });
}
export function resourceApiContract(route: ResourceApiRoute): ApiOperationContract {
  const pathNames = [...route.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
  const owner = route.family === "object" || route.family === "archive" || route.key === "recording-events.write";
  const headers: ApiSchema = { type: "object", ...(owner ? { required: ["x-rabilink-resource-owner"] }
    : route.key === "archive-settings.update" ? { required: ["x-rabiroute-expected-application-generation-id", "x-rabiroute-expected-manager-instance-id", "idempotency-key", "if-match", "content-type"] } : {}), properties: {
    ...(owner ? { "x-rabilink-resource-owner": { ...resourceIdentitySchema, description: "Existing stored-data owner. Authenticated public management selects a target; this is not its connection identity or another credential." } } : {}),
    ...(route.key === "archive-settings.update" ? {
      "x-rabiroute-expected-application-generation-id": { ...text, description: "The generic connector fills this from verified /meta; direct HTTP callers supply the current application identity." },
      "x-rabiroute-expected-manager-instance-id": { ...text, description: "The generic connector fills this from verified /meta; direct HTTP callers supply the current Manager identity." },
      "idempotency-key": { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, "if-match": { type: "string", pattern: '^"[^"\\r\\n]+"$' }, "content-type": text
    } : {})
  }, additionalProperties: true };
  return { operationId: `manager.resources.${route.key}`, contractVersion: "1.0.0", method: route.method, pathTemplate: route.pathTemplate, exposure: "public", transport: "http",
    description: `Use the existing ${route.family} resource owner for ${route.key}. Object paths select the configured archive binding before unbound legacy storage.`,
    request: { path: { type: "object", required: pathNames, properties: Object.fromEntries(pathNames.map(name => [name, name.endsWith("Hash") ? resourceHashSchema : resourceIdentitySchema])), additionalProperties: false },
      query: route.key === "archive.recordings.list" ? archiveCatalogQuerySchema : route.key === "archive.processing.read" ? { type: "object", properties: {}, additionalProperties: false } : { type: "object", additionalProperties: true }, headers, body: bodyFor(route.key) },
    responses: { "200": responseFor(route.key), ...Object.fromEntries([400, 403, 404, 405, 409, 412, 413, 415, 423, 500, 503].map(status => [String(status), failure])) },
    effects: { mode: route.key === "recording-events.write" ? "compatibility-write" : route.method === "PUT" ? "durable-write" : "read-with-owner-cache", description: route.method === "PUT"
      ? "Uses the existing configuration, immutable object/manifest store or mobile recording owner. Archive commits may notify the existing catalog/ASR owner after durable publication."
      : "Reads existing bindings, namespaces, durable media or catalog state. Catalog reads may persist their local cursor key. No read provisions an archive or launches a worker." },
    recovery: { strategy: route.key === "archive-settings.update" ? "idempotency-and-strong-etag" : route.key === "archive.manifest.commit" ? "receipt-first" : "read-before-retry",
      description: "Retain the same owner, object/manifest hashes, generation and configuration preconditions. Read the original settings, object or exact receipt after an uncertain outcome; do not change storage target or fall back after an archive binding error.",
      ...(route.key === "archive-settings.update" ? { idempotencyHeader: "Idempotency-Key" } : {}) },
    validators: [
      { id: "resources.original-connection-and-owner", description: "Authenticated public Manager connections need no extra Agent/persona grant or resources key. Existing device resources transports retain their authenticated owner/key contract. Owner and namespace bindings select data; disabled bindings fail closed. Revalidate the original connection around awaited disclosure and mutation." },
      { id: "resources.original-storage-invariants", description: "The original owners validate absolute writable directories, namespace markers, owner/record/hash identity, PCM alignment and ordered cross-field manifest totals, storage bindings and exact durable receipts. Reads do not provision missing roots. Mobile times use the recording owner's Number conversion and current clock, and text retains its UTF-16 limit." },
      { id: "resources.archive-admin-preconditions", description: "Archive settings writes require exactly one current generation header, Manager header, strong If-Match, stable Idempotency-Key and application/json header. Retain the original durable operation stamp and read back before retrying an uncertain mutation." }
    ] };
}
