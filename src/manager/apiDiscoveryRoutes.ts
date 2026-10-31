import { ApiContractError, apiDigest, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiSchema } from "./apiOperationContract.js";
import { apiCatalogOpenApi, type ApiCatalogSnapshot, type ApiPublishedOperation } from "./apiOperationCatalog.js";
import type { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiContractPrecision } from "./apiContractPrecision.js";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runPluginSynchronousWork } from "../plugin-kernel/synchronousExecution.js";
import { prepareApiJsonBody } from "./apiPreparedJson.js";

const empty = { type: "object", properties: {}, additionalProperties: false } as const;
const identityProperties = {
  applicationGenerationId: { type: "string" }, managerInstanceId: { type: "string" }, pluginGenerationId: { type: "string" },
  catalogRevision: { type: "integer", minimum: 1 }, catalogDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
} as const;
const dataSchema: ApiSchema = { type: "object", required: ["schemaVersion", ...Object.keys(identityProperties)],
  properties: { schemaVersion: { const: "2" }, ...identityProperties }, additionalProperties: true };
const successSchema: ApiSchema = { type: "object", required: ["code", "data"], additionalProperties: false,
  properties: { code: { const: 0 }, data: dataSchema } };

function identity(snapshot: ApiCatalogSnapshot) {
  return { schemaVersion: snapshot.schemaVersion, applicationGenerationId: snapshot.applicationGenerationId,
    managerInstanceId: snapshot.managerInstanceId, pluginGenerationId: snapshot.pluginGenerationId,
    catalogRevision: snapshot.catalogRevision, catalogDigest: snapshot.catalogDigest };
}

export function projectApiHelp({ contract, contractDigest, owner, binding, access }: ApiPublishedOperation) {
  const fields = typeof contract.request.query === "object" ? contract.request.query.properties as Record<string, { type?: string }> ?? {} : {};
  return {
    id: contract.operationId, method: contract.method, pathTemplate: contract.pathTemplate, description: contract.description,
    contractVersion: contract.contractVersion, contractDigest, owner, contract, ...(binding ? { binding } : {}), ...(access ? { access } : {}),
    queryParameters: Object.keys(fields), repeatableQueryParameters: Object.entries(fields).filter(([, schema]) => schema.type === "array").map(([name]) => name),
    limitations: contract.validators.map(rule => rule.description),
    help: { operationId: contract.operationId, method: contract.method, pathTemplate: contract.pathTemplate,
      description: contract.description, request: contract.request, response: contract.responses,
      effects: contract.effects, idempotency: contract.recovery, validators: contract.validators,
      contractLevel: "declared", auditLevel: "runtime-schema", coverage: apiContractPrecision(contract) }
  };
}

function queryValue(input: ApiOperationInput, name: string): string | undefined {
  const value = input.query[name];
  return typeof value === "string" ? value.trim() : undefined;
}

const projectedOperations = new WeakMap<ApiPublishedOperation, ReturnType<typeof projectApiHelp>>();

async function projectOperations(operations: readonly ApiPublishedOperation[], signal?: AbortSignal) {
  const projected: ReturnType<typeof projectApiHelp>[] = [];
  let index = 0;
  while (index < operations.length) {
    await yieldToEventLoop(undefined, { signal });
    runPluginSynchronousWork(() => {
      const started = performance.now();
      for (let count = 0; count < 256 && index < operations.length; count++) {
        signal?.throwIfAborted();
        const operation = operations[index++]!;
        const cached = projectedOperations.get(operation);
        const result = cached ?? projectApiHelp(operation);
        if (!cached && Object.isFrozen(operation) && Object.isFrozen(operation.contract)) projectedOperations.set(operation, result);
        projected.push(result);
        if (performance.now() - started >= 8) break;
      }
    }, "project API operation help batch");
  }
  return projected;
}

async function activeSnapshot(registry: ManagerPluginRouteRegistry, signal?: AbortSignal) {
  await yieldToEventLoop(undefined, { signal });
  return runPluginSynchronousWork(() => registry.catalogSnapshot(), "read API discovery snapshot");
}

function readPage(input: ApiOperationInput, snapshot: ApiCatalogSnapshot) {
  const filters = { operationId: queryValue(input, "operationId"), path: queryValue(input, "path"), method: queryValue(input, "method")?.toUpperCase() };
  const operations = snapshot.operations.filter(({ contract }) => (!filters.operationId || contract.operationId === filters.operationId || contract.aliases?.includes(filters.operationId))
    && (!filters.path || contract.pathTemplate === filters.path) && (!filters.method || contract.method === filters.method || contract.method === "*"));
  if (filters.operationId && !operations.length) throw new ApiContractError(404, "AGENT_HELP_NOT_FOUND", "operationId", "manager.api.help");
  const cursor = queryValue(input, "cursor");
  const filterDigest = apiDigest(Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)));
  let offset = 0;
  if (cursor) {
    let page: Record<string, unknown>;
    try { page = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
    catch { throw new ApiContractError(400, "API_CATALOG_CURSOR_INVALID", "cursor", "manager.api.help"); }
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new ApiContractError(400, "API_CATALOG_CURSOR_INVALID", "cursor", "manager.api.help");
    }
    if (page.manager !== snapshot.managerInstanceId || page.revision !== snapshot.catalogRevision || page.digest !== snapshot.catalogDigest || page.filters !== filterDigest) {
      throw new ApiContractError(409, "API_CATALOG_SNAPSHOT_CHANGED", "cursor", "manager.api.help");
    }
    if (!Number.isSafeInteger(page.offset) || Number(page.offset) < 0 || Number(page.offset) > operations.length) throw new ApiContractError(400, "API_CATALOG_CURSOR_INVALID", "cursor", "manager.api.help");
    offset = Number(page.offset);
  }
  const limit = queryValue(input, "limit");
  const end = limit ? Math.min(offset + Number(limit), operations.length) : operations.length;
  const nextCursor = end < operations.length ? Buffer.from(JSON.stringify({ manager: snapshot.managerInstanceId,
    revision: snapshot.catalogRevision, digest: snapshot.catalogDigest, filters: filterDigest, offset: end })).toString("base64url") : "";
  return { operations: operations.slice(offset, end), count: end - offset, total: operations.length, nextCursor };
}

function cacheHeaders(etag: string) {
  return { etag, "cache-control": "private, no-cache", vary: "authorization, x-rabiroute-agent-id" };
}

function response(input: ApiOperationInput, snapshot: ApiCatalogSnapshot, body: unknown) {
  const etag = `"${apiDigest({ snapshot: snapshot.etag, path: input.url.pathname, query: input.url.search }).slice(7)}"`;
  const condition = String(input.request.headers["if-none-match"] ?? "");
  if (condition.split(",").some(value => value.trim() === etag || value.trim() === "*")) return { status: 304, headers: cacheHeaders(etag) };
  return { status: 200, headers: cacheHeaders(etag), body };
}

const querySchema = { type: "object", additionalProperties: false, properties: {
  operationId: { type: "string", pattern: "\\S", maxLength: 4096 }, path: { type: "string", pattern: "\\S", maxLength: 4096 },
  method: { type: "string", maxLength: 64, pattern: "^\\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\\s*$" },
  cursor: { type: "string", minLength: 1, maxLength: 4096 }, limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$" }
} } as const;

export function createApiDiscoveryOperations(registry: ManagerPluginRouteRegistry): readonly ApiOperationDefinition[] {
  const define = (operationId: string, pathTemplate: string, description: string, query: ApiSchema, schema: ApiSchema,
    handler: ApiOperationDefinition["handler"]): ApiOperationDefinition => ({
    contract: { operationId, contractVersion: "1.0.0", method: "GET", pathTemplate, description, exposure: "public", transport: "http",
      ...(pathTemplate === "/api/agent/help" ? { aliases: [`agent:GET:${pathTemplate}`] } : {}),
      request: { path: empty, query, headers: { type: "object", properties: { "if-none-match": { type: "string" } }, additionalProperties: true }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema }, "304": { mediaType: "application/json", schema: false } },
      effects: { mode: "read", description: "Reads the active API contract snapshot without executing business operations." },
      recovery: { strategy: "repeatable-read", description: "Refresh the snapshot after generation changes or expired pagination cursors." }, validators: []
    } satisfies ApiOperationContract, handler
  });
  return [
    define("manager.api.help", "/api/agent/help", "Discover operations from the active route and contract snapshot.", querySchema, successSchema, async input => {
      const snapshot = await activeSnapshot(registry, input.signal);
      const page = runPluginSynchronousWork(() => readPage(input, snapshot), "select API help page");
      const conditional = response(input, snapshot, undefined);
      if (conditional.status === 304) return conditional;
      const operations = await projectOperations(page.operations, input.signal);
      const body = await prepareApiJsonBody({ code: 0, data: { ...identity(snapshot), ...page, operations, coverage: snapshot.coverage,
        listeners: snapshot.listeners,
        refreshRule: "Invalidate on api.catalog.changed and re-read on event reconnect or identity changes.",
        errorRule: "Preserve original write keys and inspect receipts before any retry." } }, operations, input.signal);
      return { ...conditional, body };
    }),
    define("manager.api.capabilities", "/api/lan-agent/capabilities", "Discover public operations without a second remote permission list.", empty,
      { type: "object", required: ["code", "schemaVersion", ...Object.keys(identityProperties), "operations", "coverage", "resources"],
        properties: { code: { const: 0 }, schemaVersion: { const: "2" }, ...identityProperties,
          operations: { type: "array", items: { type: "object" } }, coverage: { type: "object" }, resources: { type: "string" } }, additionalProperties: true }, async input => {
        const snapshot = await activeSnapshot(registry, input.signal);
        const conditional = response(input, snapshot, undefined);
        if (conditional.status === 304) return conditional;
        const operations = await projectOperations(snapshot.operations, input.signal);
        const body = await prepareApiJsonBody({ code: 0, ...identity(snapshot), operations, listeners: snapshot.listeners, coverage: snapshot.coverage,
          resources: "/api/lan-agent/resources", help: { refreshRule: "Refresh on api.catalog.changed, reconnect, or Manager identity changes." } }, operations, input.signal);
        return { ...conditional, body };
      }),
    define("manager.api.openapi", "/api/agent/openapi", "Export OpenAPI from the same executable contracts used for dispatch and validation.", empty,
      { type: "object", required: ["openapi", "info", "paths", "x-rabiroute-snapshot", "x-rabiroute-coverage"],
        properties: { openapi: { const: "3.1.0" }, info: { type: "object" }, paths: { type: "object" },
          "x-rabiroute-snapshot": { type: "object" }, "x-rabiroute-coverage": { type: "object" } }, additionalProperties: true }, async input => {
        const snapshot = await activeSnapshot(registry, input.signal);
        const conditional = response(input, snapshot, undefined);
        if (conditional.status === 304) return conditional;
        const document = await apiCatalogOpenApi(snapshot, input.signal);
        const external = document["x-rabiroute-external-listeners"] as readonly { paths: Readonly<Record<string, unknown>> }[];
        const body = await prepareApiJsonBody(document, document.paths as Readonly<Record<string, unknown>>, input.signal, external.map(listener => listener.paths));
        return { ...conditional, body };
      })
  ];
}
