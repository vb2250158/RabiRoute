import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult } from "./apiOperationContract.js";
import { DesktopPetOwner, DESKTOP_PET_LIMITS, type DesktopPetOwnerScope } from "./desktopPetRoutes.js";
import { executeDesktopPetMotion, DESKTOP_PET_MOTION_SCHEMA } from "./desktopPetMotion.js";
import { DEFAULT_DESKTOP_PET_BINDING } from "../shared/desktopSettingsContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

const ignored = { type: "object" } as const;
const envelope = { type: "object", required: ["code", "data"], additionalProperties: false, properties: { code: { const: 0 }, data: { type: ["object", "null"] } } } as const;
const failure = { type: "object", required: ["code", "message"], additionalProperties: true, properties: { code: { const: -1 }, message: { type: "string" } } } as const;
const json = (maxBytes: number, schema: Readonly<Record<string, unknown>> = { description: "Native owner validates fields and identity. Preserve original JSON scalar/object behavior and normalization." }) => ({ kind: "json" as const, maxBytes, allowAnyContentType: true, ...("required" in schema ? {} : { emptyValue: {} }), schema });
const bindingInput = { anyOf: [{ type: "object", additionalProperties: true, properties: Object.fromEntries(["personaId", ...Object.keys(DEFAULT_DESKTOP_PET_BINDING)].map(key => [key, { description: key === "personaId" ? "If supplied as a string, must equal the path persona." : "Merged with the current binding and normalized by the shared desktop settings owner." }])) }, { not: { type: "object" } }] };
const transcriptInput = { type: "object", required: ["personaId", "voice", "kind", "id", "text", "time"], additionalProperties: true, properties: {
  personaId: { type: "string" }, voice: { type: "string" }, kind: { const: "tts" }, id: { type: "string", minLength: 1, maxLength: 200 }, text: { type: "string", minLength: 1, maxLength: 100000 }, time: { type: "number", exclusiveMinimum: 0 }
} };
const runtimeInput = { type: "object", additionalProperties: true, properties: { requestId: { description: "Absent/falsy requests the next accepted motion; otherwise selects its original receipt." }, token: { description: "Must exactly match the original renderer claim token when acknowledging a receipt." }, status: { description: "Native String(value) selects running, succeeded, failed or cancelled." }, position: { description: "Required acknowledgment point with integer x/y logical pixels within +/-100000." }, destination: { description: "A succeeded result must be within eight logical pixels of this destination." }, reason: { description: "Optional failure reason; native owner keeps at most 300 characters." }, travelKind: { description: "Optional native move, run or teleport classification." } } };
const first = (input: ApiOperationInput, key: string) => { const value = input.query[key]; return Array.isArray(value) ? value[0] : value; };
type Operation = { id: string; method: "GET" | "POST" | "PATCH" | "PUT"; tail: string; action: "bindingRead" | "bindingWrite" | "dialogue" | "transcript" | "catalog" | "cache" | "import" | "asset" | "motion" | "receipt" | "runtime"; description: string };
const operations: readonly Operation[] = [
  { id: "binding.read", method: "GET", tail: "", action: "bindingRead", description: "Read the normalized persona pet binding from original host settings." },
  { id: "binding.patch", method: "PATCH", tail: "", action: "bindingWrite", description: "Merge a persona pet binding through the original pack validation and shared settings owner." },
  { id: "binding.put", method: "PUT", tail: "", action: "bindingWrite", description: "Preserve native PUT merge behavior for the persona pet binding." },
  { id: "dialogue.read", method: "GET", tail: "/dialogue", action: "dialogue", description: "Read persona-scoped native pet dialogue; preserve missing/malformed dialogue defaults." },
  { id: "transcripts.append", method: "POST", tail: "/transcripts", action: "transcript", description: "Append original host-playback TTS transcript with matching persona, voice and kind." },
  { id: "packs.list", method: "GET", tail: "/packs", action: "catalog", description: "Read the native pack catalog. scope=runtime excludes shared source; all other values retain native source selection." },
  { id: "packs.import", method: "POST", tail: "/packs/import", action: "import", description: "Import original GIF/PNG/ZIP bytes, validate the native pack and promote it into the runtime cache." },
  { id: "packs.cache", method: "POST", tail: "/packs/{packId}/cache", action: "cache", description: "Validate a shared-source pack and copy it into the immutable native runtime cache." },
  { id: "assets.read", method: "GET", tail: "/packs/{packId}/assets/{assetPath}", action: "asset", description: "Read finite native PNG/GIF bytes, retaining cache fallback, realpath containment, size and transient-error rules." },
  { id: "motion.submit", method: "POST", tail: "/motion", action: "motion", description: "Submit native frame-driven pet movement with Idempotency-Key=requestId. Accepted is not arrival." },
  { id: "motion.receipt", method: "GET", tail: "/motion/{requestId}", action: "receipt", description: "Read the original generation-scoped motion receipt without disclosing renderer claim tokens." },
  { id: "motion.runtime", method: "POST", tail: "/motion/runtime", action: "runtime", description: "Claim or acknowledge the original renderer motion ledger. Completion requires the existing matching claim token and verified arrival." }
];

async function importBytes(input: ApiOperationInput): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of input.request.iterator({ destroyOnReturn: false })) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > DESKTOP_PET_LIMITS.importBytes) throw new Error("Desktop pet import is too large.");
    chunks.push(value);
  }
  if (!bytes) throw new Error("Desktop pet import is empty.");
  return Buffer.concat(chunks);
}

export function createDesktopPetOperations(owner: DesktopPetOwner): readonly ApiOperationDefinition[] {
  return operations.map(operation => {
    const pathTemplate = "/api/desktop-pet/roles/:roleId" + operation.tail.replace(/\{(\w+)\}/g, ":$1");
    const motion = ["motion", "receipt", "runtime"].includes(operation.action);
    const capture = (input: Pick<ApiOperationInput, "path">): DesktopPetOwnerScope => {
      if ((operation.action === "bindingRead" || operation.action === "bindingWrite") && !owner.context.settings) throw Object.assign(new Error("Desktop pet settings are unavailable."), { status: 503 });
      if (motion) {
        if (!owner.context.settings) throw Object.assign(new Error("Desktop settings unavailable."), { status: 503 });
        if (!sanitizeRoleId(input.path.roleId)) throw new Error("Invalid persona.");
        return { roleId: input.path.roleId!, roleDir: "" };
      }
      if (operation.action === "bindingRead" || operation.action === "bindingWrite") {
        const roleId = sanitizeRoleId(input.path.roleId); if (!roleId) throw Object.assign(new Error("Desktop pet settings are unavailable."), { status: 503 });
        if (operation.action === "bindingRead") return { roleId, roleDir: "" };
      }
      return owner.capture(input.path.roleId!);
    };
    const run = async (input: ApiOperationInput, scope: DesktopPetOwnerScope): Promise<ApiOperationResult> => {
      try {
        input.signal?.throwIfAborted();
        switch (operation.action) {
          case "bindingRead": return owner.bindingRead(scope.roleId);
          case "bindingWrite": return await owner.bindingWrite(scope, input.body);
          case "dialogue": return await owner.dialogue(scope);
          case "transcript": return owner.transcript(scope, input.body);
          case "catalog": return await owner.catalog(scope, first(input, "scope") !== "runtime");
          case "asset": return await owner.asset(scope, input.path.packId!, input.path.assetPath!);
          case "cache": return await owner.cache(scope, input.path.packId!);
          case "import": return await owner.import(scope, await importBytes(input), first(input, "fileName") || String(input.request.headers["x-rabi-file-name"] || "upload"), String(input.request.headers["content-type"] || "application/octet-stream"), { packId: first(input, "packId") || undefined, state: first(input, "state") || undefined, name: first(input, "name") || undefined });
          case "receipt": if (input.path.requestId === "runtime") return { status: 405, body: { code: -1, message: "Method not allowed." }, headers: { "cache-control": "no-store" } };
            return executeDesktopPetMotion("receipt", scope.roleId, undefined, input.path.requestId, undefined, owner.context.settings, owner.context.publishEvent);
          case "motion": return executeDesktopPetMotion("submit", scope.roleId, input.body, undefined, input.request.headers["idempotency-key"], owner.context.settings, owner.context.publishEvent);
          case "runtime": return executeDesktopPetMotion("runtime", scope.roleId, input.body, undefined, undefined, owner.context.settings, owner.context.publishEvent);
        }
      } catch (error) { return owner.failure(error, operation.action === "asset" ? 404 : operation.action === "catalog" ? 503 : 400, operation.action === "asset"); }
    };
    const params = ["roleId", ...(operation.tail.includes("{packId}") ? ["packId"] : []), ...(operation.tail.includes("{assetPath}") ? ["assetPath"] : []), ...(operation.tail.includes("{requestId}") ? ["requestId"] : [])];
    const queryFields = operation.action === "catalog" ? ["scope"] : operation.action === "import" ? ["fileName", "packId", "state", "name"] : [];
    const response200 = operation.action === "asset" ? { mediaType: "image/gif", binary: { maxBytes: DESKTOP_PET_LIMITS.assetBytes }, alternatives: [{ mediaType: "image/png", binary: { maxBytes: DESKTOP_PET_LIMITS.assetBytes } }] } : { mediaType: "application/json", schema: envelope };
    return { contract: {
      operationId: "manager.desktop-pet." + operation.id, ...(["motion", "receipt"].includes(operation.action) ? { aliases: ["desktop-pet:" + operation.method + ":" + pathTemplate] } : {}), contractVersion: "1.0.0", method: operation.method, pathTemplate, exposure: "public", transport: "http", description: operation.description,
      request: { path: { type: "object", required: params, additionalProperties: false, properties: Object.fromEntries(params.map(key => [key, { type: "string" }])) }, ...(operation.action === "asset" ? { pathTails: ["assetPath"] } : {}),
        query: { type: "object", additionalProperties: true, properties: Object.fromEntries(queryFields.map(key => [key, { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }])) }, headers: ignored,
        body: operation.action === "import" ? { kind: "binary", mediaType: "application/octet-stream", allowAnyContentType: true, maxBytes: DESKTOP_PET_LIMITS.importBytes, rules: ["Original GIF, PNG or ZIP bytes; native expanded-size, archive-entry, traversal, immutable-id and persona-manifest checks remain authoritative. No multipart or base64 conversion."] }
          : ["bindingWrite", "transcript", "motion", "runtime"].includes(operation.action) ? json(motion ? DESKTOP_PET_LIMITS.motionBytes : DESKTOP_PET_LIMITS.jsonBytes, operation.action === "motion" ? DESKTOP_PET_MOTION_SCHEMA : operation.action === "runtime" ? runtimeInput : operation.action === "transcript" ? transcriptInput : bindingInput) : { kind: "none", allowIgnoredBody: true } },
      responses: { "200": response200, ...(["import", "cache"].includes(operation.action) ? { "201": { mediaType: "application/json", schema: envelope } } : {}), ...(operation.action === "motion" ? { "202": { mediaType: "application/json", schema: envelope } } : {}), "400": { mediaType: "application/json", schema: failure }, "404": { mediaType: "application/json", schema: failure }, "405": { mediaType: "application/json", schema: failure }, "409": { mediaType: "application/json", schema: failure }, "503": { mediaType: "application/json", schema: failure } },
      effects: { mode: operation.method === "GET" ? "native-read" : "native-desktop-pet-write", description: motion ? "The original settings-scoped in-memory ledger owns motion identity, renderer claims, position checks, events, capacity and expiry. Submission does not execute desktop movement in this Manager process." : "Original persona files, catalog worker, pack importer/cache and shared settings own state and mutation audits. Events notify the existing renderer; HTTP does not start a replacement runtime." },
      recovery: { strategy: motion ? "original-motion-receipt" : operation.method === "GET" ? "repeatable-native-read" : "inspect-original-state-no-replay", ...(motion ? { receiptPath: "/api/desktop-pet/roles/{roleId}/motion/{requestId}", idempotencyHeader: "Idempotency-Key" } : {}), description: motion ? "Submit with Idempotency-Key equal to requestId; the original normalized fingerprint detects reuse. Inspect its generation-scoped receipt before retrying; accepted/running are not success. Renderer claims and verified arrival remain required, and receipts expire under native rules." : "Inspect original persona files, settings and immutable pack IDs after uncertain writes. Registration retirement joins accepted operations; the owner separately joins actual catalog worker release after a response timeout. Finite assets remain raw bytes; no SSE subscription is created." },
      validators: [{ id: "native-desktop-pet-owner", description: "Keep existing persona/voice matching, shared settings normalization, pack ownership, realpath confinement, archive validation, resource limits and renderer token provenance. Query fields use their first value. Authenticated remote connections need no additional function or local-origin grant." }]
    }, prepare: input => {
      try { const scope = capture(input); return parsed => run(parsed, scope); }
      catch (error) { const failed = owner.failure(error, Number((error as { status?: unknown }).status) || (operation.action === "asset" || operation.action === "catalog" ? 404 : 400)); return motion ? { ...failed, headers: { ...failed.headers, "cache-control": "no-store" } } : failed; }
    }, handler: input => { try { return run(input, capture(input)); } catch (error) { return owner.failure(error); } } } satisfies ApiOperationDefinition;
  });
}
