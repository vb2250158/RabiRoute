import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiResponseContract } from "./apiOperationContract.js";
import { createPluginCatalogOwner, type PluginCatalogAction } from "./pluginCatalogOwner.js";
import type { PluginCatalogApiContext } from "./pluginCatalogRoutes.js";

const text = { type: "string" }, integer = { type: "integer" }, strings = { type: "array", items: text };
const ignored = { type: "object" }, empty = { type: "object", additionalProperties: false };
const path = { type: "object", required: ["id", "rev", "relativePath"], additionalProperties: false, properties: {
  id: { ...text, minLength: 1 }, rev: { ...text, description: "Native owner accepts 64 lowercase hex digits; other revisions retain HTTP 404." }, relativePath: { ...text, minLength: 1 }
} };
const readiness = { type: "object", required: ["state", "missingCapabilities"], properties: {
  state: { enum: ["ready", "degraded"] }, missingCapabilities: strings
} };
const status = { type: "object", required: ["schemaVersion", "state", "readiness", "active", "waiting", "failed", "diagnostics"], properties: {
  schemaVersion: { const: 1 }, state: { enum: ["idle", "degraded"] }, readiness, active: strings, waiting: strings, failed: strings, diagnostics: { type: "array" }
} };
const catalog = { type: "object", required: ["schemaVersion", "generation", "host", "revision", "plugins", "contributions"], properties: {
  schemaVersion: { const: 2 }, generation: text, host: { enum: ["all", "web", "desktop"] },
  revision: { type: "object", required: ["plugins", "contributions"], properties: { plugins: integer, contributions: integer } },
  plugins: { type: "array", items: { type: "object", required: ["instanceId", "pluginId", "manifest", "host", "scope", "status", "missingCapabilities"], properties: {
    instanceId: text, pluginId: text, manifest: { type: "object", required: ["id", "version", "kind", "hosts", "capabilities"], properties: {
      id: text, version: text, kind: { const: "package" }, hosts: strings, capabilities: strings
    } }, host: text, scope: { const: "global" }, status: text, missingCapabilities: strings, error: {}
  } } }, contributions: { type: "array", items: { type: "object" } }
} };
const module = { type: "object", required: ["id", "pluginId", "version", "rev", "entryPath", "instances"], properties: {
  id: text, pluginId: text, version: text, rev: { ...text, pattern: "^[a-f0-9]{64}$" }, entryPath: text,
  instances: { type: "array", items: { type: "object", required: ["instanceId"], properties: { instanceId: text } } }
} };
const json = (data: unknown): ApiResponseContract => ({ mediaType: "application/json; charset=utf-8", schema: {
  type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data }
} });
const failure: ApiResponseContract = { mediaType: "application/json; charset=utf-8", schema: {
  type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: text }, additionalProperties: true
} };

/** Five native operations; no boolean dispatcher or second state implementation. */
export function createPluginCatalogOperations(context: PluginCatalogApiContext, readOnly = false): readonly ApiOperationDefinition[] {
  const owner = createPluginCatalogOwner(context, readOnly);
  const define = (action: PluginCatalogAction, method: "GET" | "POST", route: string, data: unknown, bytes = false): ApiOperationDefinition => {
    const contract: ApiOperationContract = {
      operationId: "manager.plugins." + action, contractVersion: "1.0.0", method, pathTemplate: route, exposure: "public", transport: "http",
      description: bytes ? "Read original revision-qualified Web plugin module bytes." : action === "reconciliation.run"
        ? "Reconcile the native plugin profile and await its actual publication or failure." : "Read the native plugin catalog, readiness, diagnostics or active Web module list.",
      request: { path: bytes ? path : empty, ...(bytes ? { pathTails: ["relativePath"] } : {}),
        query: action === "catalog.read" ? { type: "object", properties: { host: { anyOf: [text, strings], description: "First value selects web or desktop; empty means all." } }, additionalProperties: true }
          : action === "modules.list" ? { type: "object", properties: { webRelease: { anyOf: [text, strings], description: "First value selects an existing compatible Web release; absence keeps current modules." } }, additionalProperties: true } : ignored,
        headers: ignored, body: { kind: "none", allowIgnoredBody: true } },
      responses: { "200": bytes ? { mediaType: "*/*", binary: { maxBytes: Number.MAX_SAFE_INTEGER }, headers: {
        type: "object", required: ["content-type", "cache-control", "x-content-type-options"], properties: {
          "content-type": { enum: ["text/css; charset=utf-8", "text/javascript; charset=utf-8", "application/octet-stream"] },
          "cache-control": { const: "public, max-age=31536000, immutable" }, "x-content-type-options": { const: "nosniff" }
        }, additionalProperties: true
      } } : json(data), default: failure },
      effects: { mode: method === "POST" ? "native-plugin-reconciliation" : "read", description: method === "POST"
        ? "Reread the original profile through its serialized native owner. Respect disabled instances, readiness, original publication/CAS and resource policies; no download, profile rewrite or separate permission store."
        : "Read the original GenerationRuntime/presentation or revision-qualified module owner. Preserve native module URL, MIME, immutable cache and nosniff; Range remains ignored, and no CSP is added by this owner." },
      recovery: { strategy: method === "POST" ? "native-generation-readback-no-replay" : "repeatable-read", description: method === "POST"
        ? "HTTP 200 means native reconciliation joined and returned the current generation. Inspect readiness and failed/waiting lists; an unchanged generation is not a new publication. No idempotency key or replay guarantee is invented. After disconnect, revoke or publication failure inspect GET /api/plugins/reconciliation before any retry."
        : "Repeat against current application identity. Retained module revisions and Web-release compatibility remain owned by native registries." },
      validators: [{ id: "plugins.original-source-lease", description: "Capture original principal, source root, owner references and application identity before body handling; recheck after await and before disclosure. Native queued reconciliation must use the supplied assertion at dequeue, file loading, kernel queued switch and final publication. Post-dispatch failure retains trusted mutationOutcome=unknown without business data." },
        { id: "plugins.native-compatibility", description: "Authenticated unbound remote connections may invoke every public operation. Read-only mode blocks reconciliation. Optional providers, ignored bodies/queries, host selection and module ENOENT/error semantics retain native behavior." }]
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const bound = owner.prepare(input.request, action, input.signal);
      return (parsed: ApiOperationInput) => bound.execute({ host: parsed.url.searchParams.get("host"), webRelease: parsed.url.searchParams.get("webRelease"),
        id: parsed.path.id, rev: parsed.path.rev, relativePath: parsed.path.relativePath });
    };
    return { contract, prepare, handler: input => prepare(input)(input) };
  };
  return [
    define("catalog.read", "GET", "/api/plugins/catalog", catalog),
    define("reconciliation.read", "GET", "/api/plugins/reconciliation", status),
    define("reconciliation.run", "POST", "/api/plugins/reconciliation", status),
    define("modules.list", "GET", "/api/plugins/modules", { type: "object", required: ["schemaVersion", "modules"], properties: {
      schemaVersion: { const: 1 }, modules: { type: "array", items: module }
    } }),
    define("modules.read", "GET", "/api/plugins/modules/:id/:rev/:relativePath", undefined, true)
  ];
}
