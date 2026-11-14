import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";
import { createPluginCatalogOwner, type PluginCatalogAction } from "./pluginCatalogOwner.js";
import type { PluginCatalogApiContext } from "./pluginCatalogRoutes.js";

/** Bootstrap-owned management stays reachable when a business plugin is disabled. */
export function createPluginManagementOperations(context: PluginCatalogApiContext, readOnly = false): readonly ApiOperationDefinition[] {
  const owner = createPluginCatalogOwner(context, readOnly);
  const instanceOperations = [false, true].map<ApiOperationDefinition>(update => {
    const action = update ? "instances.update" : "instances.read";
    const empty = { type: "object", additionalProperties: false };
    const contract: ApiOperationContract = {
      operationId: `manager.plugins.${action}`, contractVersion: "1.0.0", method: update ? "PATCH" : "GET",
      pathTemplate: update ? "/api/plugins/instances/:id" : "/api/plugins/instances", exposure: "public", transport: "http",
      description: update ? "Save one plugin instance's enabled setting with revision CAS and start native asynchronous reconciliation; read actual lifecycle status separately."
        : "List configured plugin instances, including disabled and failed instances, without exposing raw configuration.",
      request: {
        path: update ? { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 } } } : empty,
        query: empty, headers: { type: "object" },
        body: update ? { kind: "json", maxBytes: 2048, schema: { type: "object", required: ["expectedRevision", "enabled"], additionalProperties: false,
          properties: { expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" }, enabled: { type: "boolean" } } } } : { kind: "none" }
      },
      responses: {
        "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "data"], properties: {
          code: { const: 0 }, data: { type: "object", required: ["applicationGenerationId", "managerInstanceId", "revision", "instances"], properties: {
            applicationGenerationId: { type: "string", minLength: 1 }, managerInstanceId: { type: "string", minLength: 1 },
            revision: { type: "string" }, instances: { type: "array", items: { type: "object", required: ["instanceId", "pluginId", "version", "enabled", "status"], properties: {
              instanceId: { type: "string" }, pluginId: { type: "string" }, version: { type: "string" }, runningVersion: { type: "string" }, enabled: { type: "boolean" }, status: { type: "string" }
            } } }
          } }
        } } },
        default: { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" },
          errorCode: { type: "string" }, field: { type: "string" }, repair: { type: "string" }, retryable: { const: false },
          help: { type: "object", required: ["method", "path"], properties: { method: { const: "GET" }, path: { type: "string" } }, additionalProperties: false } }, additionalProperties: true } }
      },
      effects: { mode: update ? "native-plugin-settings" : "read", description: update
        ? "Persist only this instance's override, preserving immutable package defaults and other instance settings; original Kernel ownership tracks initialization and retirement."
        : "Read original profile settings and actual native activation state. Do not start plugins or disclose credentials." },
      recovery: { strategy: update ? "native-settings-readback-no-replay" : "repeatable-read", description: update
        ? "After an uncertain result reread GET /api/plugins/instances; never replay an old revision or report an enabled setting as active execution."
        : "Read again against the current application identity." },
      validators: [{ id: "plugins.original-source-lease", description: "Bind the original authenticated source, owner and application identity before parsing; recheck at durable settings write and native publication." }]
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const bound = owner.prepare(input.request, action, input.signal);
      return (parsed: ApiOperationInput) => {
        const body = parsed.body as { expectedRevision?: string; enabled?: boolean } | undefined;
        return bound.execute({ id: parsed.path.id, expectedRevision: body?.expectedRevision, enabled: body?.enabled });
      };
    };
    return { contract, prepare, handler: input => prepare(input)(input) };
  });
  const revision = { type: "string", pattern: "^[a-f0-9]{64}$" };
  const symbol = { type: "string", minLength: 1 };
  const additions: { action: PluginCatalogAction; method: "GET" | "POST" | "DELETE"; path: string; description: string; body?: Record<string, unknown> }[] = [
    { action: "packages.list", method: "GET", path: "/api/plugins/packages", description: "List installed package versions available for plugin installation without executing them." },
    { action: "packages.import", method: "POST", path: "/api/plugins/packages", description: "Import a local SDK-built plugin directory into the persistent package store; existing version bytes remain immutable.",
      body: { type: "object", additionalProperties: false, required: ["sourceDirectory"], properties: { sourceDirectory: symbol } } },
    { action: "instances.install", method: "POST", path: "/api/plugins/instances", description: "Install or restore a plugin instance and initialize it asynchronously; user data retains its original instance identity.",
      body: { type: "object", additionalProperties: false, required: ["expectedRevision", "pluginId", "version"], properties: { expectedRevision: revision, pluginId: symbol, version: symbol, instanceId: symbol } } },
    { action: "instances.remove", method: "DELETE", path: "/api/plugins/instances/:id", description: "Uninstall an instance through the original lifecycle owner, preserving stored configuration and user data.",
      body: { type: "object", additionalProperties: false, required: ["expectedRevision"], properties: { expectedRevision: revision } } }
  ];
  const packageOperations: ApiOperationDefinition[] = additions.map(item => {
    const mutation = item.method !== "GET";
    const contract: ApiOperationContract = {
      operationId: `manager.plugins.${item.action}`, contractVersion: "1.0.0", method: item.method, pathTemplate: item.path,
      exposure: "public", transport: "http", description: item.description,
      request: {
        path: item.path.includes(":id") ? { type: "object", required: ["id"], additionalProperties: false, properties: { id: symbol } } : { type: "object", additionalProperties: false },
        query: { type: "object", additionalProperties: false }, headers: { type: "object" },
        body: item.body ? { kind: "json", maxBytes: 0, schema: item.body } : { kind: "none" }
      },
      responses: {
        "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data: { type: "object", ...(item.action.startsWith("packages.") ? { properties: {
          packages: { type: "array", items: { type: "object" } }, partial: { type: "boolean" }, diagnostics: { type: "array", items: { type: "object", required: ["root", "path", "code", "message"], properties: { root: symbol, path: symbol, code: symbol, message: symbol } } },
          ...(item.action === "packages.import" ? { importedPackage: { type: "object", required: ["id", "version", "revision"], properties: { id: symbol, version: symbol, revision } } } : {})
        } } : {}) } } } },
        default: { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" },
          errorCode: { type: "string" }, field: { type: "string" }, repair: { type: "string" }, retryable: { const: false },
          help: { type: "object", required: ["method", "path"], properties: { method: { const: "GET" }, path: { type: "string" } }, additionalProperties: false } }, additionalProperties: true } }
      },
      effects: { mode: mutation ? "native-plugin-settings" : "read", description: item.description },
      recovery: { strategy: mutation ? "native-settings-readback-no-replay" : "repeatable-read", description: "Read package availability and actual instance status after uncertain results; do not infer activation or stopped resources from a saved setting." },
      validators: []
    };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      const bound = owner.prepare(input.request, item.action, input.signal);
      return (parsed: ApiOperationInput) => bound.execute({ ...(parsed.body as Record<string, string> ?? {}), id: parsed.path.id });
    };
    return { contract, prepare, handler: input => prepare(input)(input) };
  });
  return [...instanceOperations, ...packageOperations];
}
