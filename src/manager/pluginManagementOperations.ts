import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput } from "./apiOperationContract.js";
import { createPluginCatalogOwner } from "./pluginCatalogOwner.js";
import type { PluginCatalogApiContext } from "./pluginCatalogRoutes.js";

/** Bootstrap-owned management stays reachable when a business plugin is disabled. */
export function createPluginManagementOperations(context: PluginCatalogApiContext, readOnly = false): readonly ApiOperationDefinition[] {
  const owner = createPluginCatalogOwner(context, readOnly);
  return [false, true].map(update => {
    const action = update ? "instances.update" : "instances.read";
    const empty = { type: "object", additionalProperties: false };
    const contract: ApiOperationContract = {
      operationId: `manager.plugins.${action}`, contractVersion: "1.0.0", method: update ? "PATCH" : "GET",
      pathTemplate: update ? "/api/plugins/instances/:id" : "/api/plugins/instances", exposure: "public", transport: "http",
      description: update ? "Save one plugin instance's enabled setting with revision CAS and join its native reconciliation."
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
        default: { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["code", "message"], properties: { code: { const: -1 }, message: { type: "string" } }, additionalProperties: true } }
      },
      effects: { mode: update ? "native-plugin-settings" : "read", description: update
        ? "Persist only this instance's override, preserving immutable package defaults and other instance settings; reconcile through the original serialized kernel owner."
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
}
