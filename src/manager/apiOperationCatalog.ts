import { parseApiPathTemplate } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { apiDigest, freezeApiData, type ApiOperationContract, type ApiSchema } from "./apiOperationContract.js";
import type { ApiExternalListenerBinding } from "./apiExternalListenerBinding.js";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { runPluginSynchronousWork } from "../plugin-kernel/synchronousExecution.js";

export type ApiCatalogIdentity = Readonly<{
  applicationGenerationId: string;
  managerInstanceId: string;
  pluginGenerationId: string;
}>;
export type ApiPublishedOperation = Readonly<{
  contract: ApiOperationContract;
  contractDigest: string;
  owner: Readonly<{ instanceId: string; activationId?: string; revision?: string }>;
  binding?: ApiExternalListenerBinding;
  access?: Readonly<{ kind: "manager-native-http"; pathPrefix: string; contractHeader: string; contractDigest: string }>;
}>;
export type ApiPublishedListener = Readonly<{ binding: ApiExternalListenerBinding; owner: ApiPublishedOperation["owner"] }>;
export type ApiCoverageGap = Readonly<{
  instanceId: string;
  routeId: string;
  kind: string;
  methods: readonly string[];
  path?: string;
  pathPrefix?: string;
  reason: string;
}>;
export type ApiCatalogSnapshot = ApiCatalogIdentity & Readonly<{
  schemaVersion: "2";
  catalogRevision: number;
  catalogDigest: string;
  etag: string;
  operations: readonly ApiPublishedOperation[];
  /** Includes native transport-control listeners with no public business operation. */
  listeners: readonly ApiPublishedListener[];
  coverage: Readonly<{ scope: "registered-routes"; globalCoverage: "not-proven"; complete: boolean; operationCount: number; gaps: readonly ApiCoverageGap[] }>;
}>;

export function createApiCatalogSnapshot(identity: ApiCatalogIdentity, revision: number,
  operations: readonly ApiPublishedOperation[], gaps: readonly ApiCoverageGap[], listeners?: readonly ApiPublishedListener[]): ApiCatalogSnapshot {
  const ordered = [...operations].sort((a, b) => a.contract.operationId.localeCompare(b.contract.operationId));
  const activeListeners = [...(listeners ?? new Map(operations.flatMap(value => value.binding ? [[value.binding.leaseId, { binding: value.binding, owner: value.owner }] as const] : [])).values())]
    .sort((a, b) => a.binding.listenerId.localeCompare(b.binding.listenerId));
  const catalogDigest = apiDigest({ operations: ordered.map(value => ({ contract: value.contract, contractDigest: value.contractDigest,
    ...(value.binding ? { binding: value.binding } : {}), ...(value.access ? { access: value.access } : {}) })), listeners: activeListeners, gaps });
  const etag = `"${apiDigest({ ...identity, catalogDigest, catalogRevision: revision }).slice(7)}"`;
  return freezeApiData({ ...identity, schemaVersion: "2", catalogRevision: revision, catalogDigest, etag,
    operations: ordered, listeners: activeListeners, coverage: { scope: "registered-routes", globalCoverage: "not-proven",
      complete: gaps.length === 0, operationCount: ordered.length, gaps: [...gaps] } });
}

function parameters(schema: ApiSchema, location: "path" | "query" | "header") {
  if (typeof schema === "boolean") return [];
  const properties = schema.properties as Record<string, ApiSchema> | undefined;
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  return Object.entries(properties ?? {}).map(([name, value]) => ({ name, in: location,
    required: location === "path" || required.includes(name), schema: value }));
}

function* projectOpenApi(snapshot: ApiCatalogSnapshot): Generator<void, Readonly<Record<string, unknown>>> {
  const paths: Record<string, Record<string, unknown>> = Object.create(null);
  const externalPaths = new Map<string, Record<string, Record<string, unknown>>>();
  for (const { contract, contractDigest, owner, binding, access } of snapshot.operations) {
    const template = parseApiPathTemplate(contract.pathTemplate, contract.request.pathTails, contract.request.pathRemainder, contract.request.pathCaseInsensitiveLiterals);
    const path = template.openApiTemplate;
    const body = contract.request.body;
    const requestBody = body.kind === "none" ? undefined : body.kind === "passthrough" ? {
      required: false, content: { "*/*": { schema: { type: "string", format: "binary" } } }, "x-rabiroute-body": body
    } : {
      required: !(body.kind === "json" && Object.hasOwn(body, "emptyValue"))
        && !(body.kind !== "json" && body.kind !== "text" && body.optional === true),
      content: { [body.kind !== "text" && body.allowAnyContentType ? "*/*" : body.kind === "json" ? "application/json" : body.mediaType]: {
        schema: body.kind === "json" || body.kind === "text" ? body.schema : { type: "string", format: "binary" }
      } },
      "x-rabiroute-body": body
    };
    const responses = Object.fromEntries(Object.entries(contract.responses).map(([status, response]) => {
      const variants = [response, ...(response.alternatives ?? [])];
      const content: Record<string, { schema?: ApiSchema }> = Object.create(null);
      for (const variant of variants) {
        const previous = content[variant.mediaType];
        content[variant.mediaType] = previous
          ? { schema: previous.schema === undefined || variant.schema === undefined ? true : { anyOf: [previous.schema, variant.schema] } }
          : { ...(variant.schema !== undefined ? { schema: variant.schema }
            : variant.binary ? { schema: { type: "string", format: "binary" } } : {}) };
      }
      return [status, { description: `${contract.operationId} response ${status}`, ...(status === "101" ? {} : { content }),
        "x-rabiroute-response-variants": variants,
        ...(response.headers ? { "x-rabiroute-header-schema": response.headers } : {}),
        ...(response.binary ? { "x-rabiroute-binary": response.binary } : {}),
        ...(response.stream ? { "x-rabiroute-stream": response.stream } : {}) }];
    }));
    // Independent listeners have independent URL spaces, including identical method/path pairs.
    let pathSpace = paths;
    if (binding) {
      if (!externalPaths.has(binding.leaseId)) externalPaths.set(binding.leaseId, Object.create(null));
      pathSpace = externalPaths.get(binding.leaseId)!;
    }
    const item = pathSpace[path] ??= Object.create(null) as Record<string, unknown>;
    // OpenAPI has no wildcard HTTP verb. Preserve it as an explicit native-proxy extension.
    const method = contract.method === "*" ? "x-rabiroute-any-method" : contract.method.toLowerCase();
    const projected = { operationId: contract.operationId, description: contract.description,
      parameters: [...parameters(contract.request.path, "path"), ...parameters(contract.request.query, "query"), ...parameters(contract.request.headers, "header")],
      ...(requestBody ? { requestBody } : {}), responses,
      ...(body.kind === "none" && body.allowIgnoredBody ? { "x-rabiroute-ignored-request-body": true } : {}),
      "x-rabiroute-contract-version": contract.contractVersion, "x-rabiroute-contract-digest": contractDigest,
      ...(contract.aliases?.length ? { "x-rabiroute-operation-aliases": contract.aliases } : {}),
      "x-rabiroute-transport": contract.transport, "x-rabiroute-effects": contract.effects,
      ...(contract.websocket ? { "x-rabiroute-websocket": contract.websocket } : {}),
      ...(contract.httpProxy ? { "x-rabiroute-http-proxy": contract.httpProxy } : {}),
      ...(template.tails.length ? { "x-rabiroute-path-tails": template.tails } : {}),
      ...(template.remainder ? { "x-rabiroute-path-remainder": template.remainder } : {}),
      ...(contract.request.pathCaseInsensitiveLiterals?.length ? { "x-rabiroute-case-insensitive-path-literals": contract.request.pathCaseInsensitiveLiterals } : {}),
      ...(contract.request.deadlineMs === undefined ? {} : { "x-rabiroute-deadline-ms": contract.request.deadlineMs }),
      "x-rabiroute-recovery": contract.recovery, "x-rabiroute-validators": contract.validators,
      "x-rabiroute-owner": owner,
      ...(binding ? { "x-rabiroute-binding": binding } : {}),
      ...(access ? { "x-rabiroute-access": access } : {}),
      // The complete request schemas preserve cross-field constraints beyond OpenAPI parameters.
      "x-rabiroute-request": contract.request };
    const existing = item[method] as Record<string, unknown> | undefined;
    if (!existing) item[method] = projected;
    else {
      const currentUpgrade = contract.transport === "websocket", existingUpgrade = existing["x-rabiroute-transport"] === "websocket";
      if (currentUpgrade === existingUpgrade || existing["x-rabiroute-upgrades"]) throw new Error(`Duplicate OpenAPI operation: ${contract.method} ${path}`);
      if (currentUpgrade) existing["x-rabiroute-upgrades"] = [projected];
      else item[method] = { ...projected, "x-rabiroute-upgrades": [existing] };
    }
    yield;
  }
  return { openapi: "3.1.0", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: "RabiRoute public APIs", version: snapshot.catalogDigest }, paths,
    "x-rabiroute-external-listeners": snapshot.listeners.map(listener => ({ ...listener, paths: externalPaths.get(listener.binding.leaseId) ?? {} })),
    "x-rabiroute-snapshot": { applicationGenerationId: snapshot.applicationGenerationId,
      managerInstanceId: snapshot.managerInstanceId, pluginGenerationId: snapshot.pluginGenerationId,
      catalogRevision: snapshot.catalogRevision, catalogDigest: snapshot.catalogDigest }, "x-rabiroute-coverage": snapshot.coverage };
}

/** Preserve the same shared projection and independent native path spaces while yielding. */
export async function apiCatalogOpenApi(snapshot: ApiCatalogSnapshot, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
  const projection = projectOpenApi(snapshot);
  for (;;) {
    await yieldToEventLoop(undefined, { signal });
    const step = runPluginSynchronousWork(() => {
      const started = performance.now();
      let next: IteratorResult<void, Readonly<Record<string, unknown>>>;
      for (let count = 0;; count++) {
        signal?.throwIfAborted();
        next = projection.next();
        if (next.done || count >= 255 || performance.now() - started >= 8) return next;
      }
    }, "project OpenAPI operation batch");
    if (step.done) return step.value;
  }
}
