import type { ApiOperationDefinition, ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { dshRpc, listDshSessions, readDshSession } from "../dshSessionBridge.js";
import { resolveDshBaseUrl } from "../dshDiscovery.js";

type NativeRpc = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export type DshNativeOperationDependencies = { baseUrl?: string; rpc?: NativeRpc };
class DshNativeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function nativeInteger(input: ApiOperationInput, field: string): number | undefined {
  const value = input.url.searchParams.get(field);
  if (value === null) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (field === "maxMessages" || field === "limit" ? 1 : 0)) throw new DshNativeError(400, "DSH_NATIVE_PARAMETER_INVALID", `query.${field} must be a supported native integer.`);
  return number;
}
function requestBody(input: ApiOperationInput): Record<string, unknown> { return input.body as Record<string, unknown>; }

/** Every RPC executes through the configured DSH authentication owner and retains its native result. */
export function createDshNativeOperations(dependencies: DshNativeOperationDependencies = {}): ApiOperationDefinition[] {
  const baseUrl = () => resolveDshBaseUrl(dependencies.baseUrl);
  const rpc: NativeRpc = dependencies.rpc ?? (async (method, args, signal) => {
    const result = await dshRpc<unknown>(baseUrl(), method, args, undefined, signal);
    if (!result.ok) throw new DshNativeError(400, result.error.code ?? "DSH_NATIVE_REJECTED", result.error.message ?? "The DSH owner rejected this operation.");
    return result.value;
  });
  const integer = { type: "string", pattern: "^[0-9]+$" }, text = { type: "string", minLength: 1 }, object = { type: "object", additionalProperties: true };
  const specs = [
    {
      id: "sessions.list",
      path: "/sessions",
      method: "GET",
      title: "List DSH sessions",
      query: { query: { type: "string" }, limit: integer, offset: integer },
      run: async (input: ApiOperationInput) => {
        const limit = nativeInteger(input, "limit") ?? 50, offset = nativeInteger(input, "offset") ?? 0;
        const rows = await listDshSessions({
          baseUrl: baseUrl(),
          limit: Math.min(limit + 1, Number.MAX_SAFE_INTEGER),
          offset,
          query: input.url.searchParams.get("query") ?? undefined,
          signal: input.signal
        });
        return { provider: "dsh", items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
      }
    },
    {
      id: "sessions.read",
      path: "/sessions/:sessionId",
      method: "GET",
      title: "Read DSH session metadata",
      query: {},
      run: (input: ApiOperationInput) => readDshSession(input.path.sessionId!, baseUrl(), undefined, input.signal)
    },
    {
      id: "sessions.history.read",
      path: "/sessions/:sessionId/history",
      method: "GET",
      title: "Read native DSH session events",
      query: {
        beforeSeq: integer,
        throughSeq: integer,
        maxMessages: integer,
        parentSessionId: text,
        mode: { type: "string", enum: ["one-shot", "continuable", "unknown"] }
      },
      run: async (input: ApiOperationInput) => {
        const sessionId = input.path.sessionId!, parent = input.url.searchParams.get("parentSessionId");
        const address = parent ? {
          kind: "subagent",
          parentSessionId: parent,
          childSessionId: sessionId,
          mode: input.url.searchParams.get("mode") ?? "unknown"
        } : { kind: "session", sessionId };
        const beforeSeq = nativeInteger(input, "beforeSeq"), throughSeq = nativeInteger(input, "throughSeq"), maxMessages = nativeInteger(input, "maxMessages");
        const request = {
          address,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(throughSeq === undefined ? {} : { throughSeq }),
          ...(maxMessages === undefined ? {} : { maxMessages })
        };
        const page = await rpc("session/events", { request }, input.signal);
        if (!page || typeof page !== "object" || !Array.isArray((page as { records?: unknown }).records) || typeof (page as { hasMore?: unknown }).hasMore !== "boolean" || !Number.isSafeInteger((page as { cursor?: unknown }).cursor)) throw new DshNativeError(503, "DSH_HISTORY_RESPONSE_INVALID", "The DSH native history page is incomplete.");
        return {
          ...page,
          provider: "dsh",
          sessionId,
          source: "dsh-session-events",
          coverage: {
            throughSeq: (page as { cursor: number }).cursor,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            direction: "backward",
            nativeCursorPreserved: true
          }
        };
      }
    },
    {
      id: "plugins.list",
      path: "/plugins",
      method: "GET",
      title: "List native DSH runtime plugins",
      query: {},
      rpc: "pluginManager/listPlugins",
      args: () => ({})
    },
    {
      id: "bundles.list",
      path: "/bundles",
      method: "GET",
      title: "List installed DSH plugin bundles",
      query: {},
      rpc: "pluginManager/listBundles",
      args: () => ({})
    },
    {
      id: "market.indexes.list",
      path: "/plugin-market",
      method: "GET",
      title: "List DSH plugin market indexes",
      query: {},
      rpc: "pluginMarket/listIndexes",
      args: () => ({})
    },
    {
      id: "market.search",
      path: "/plugin-market/search",
      method: "POST",
      title: "Search the DSH plugin market",
      query: {},
      rpc: "pluginMarket/search",
      schema: {
        type: "object",
        properties: { url: text, query: object },
        required: ["url", "query"],
        additionalProperties: false
      },
      args: (input: ApiOperationInput) => requestBody(input)
    },
    {
      id: "plugins.install",
      path: "/plugins/install",
      method: "POST",
      title: "Install a DSH plugin bundle",
      query: {},
      mutation: true,
      rpc: "pluginManager/installBundle",
      schema: {
        type: "object",
        properties: { spec: text, options: object },
        required: ["spec"],
        additionalProperties: false
      },
      args: (input: ApiOperationInput) => requestBody(input)
    },
    {
      id: "plugins.update",
      path: "/plugins/:name/update",
      method: "POST",
      title: "Update a DSH plugin bundle",
      query: {},
      mutation: true,
      rpc: "pluginManager/updateBundle",
      schema: {
        type: "object",
        properties: { version: text, options: object },
        required: ["version"],
        additionalProperties: false
      },
      args: (input: ApiOperationInput) => ({ name: input.path.name!, ...requestBody(input) })
    },
    {
      id: "plugins.remove",
      path: "/plugins/:name",
      method: "DELETE",
      title: "Remove a DSH plugin bundle",
      query: {},
      mutation: true,
      rpc: "pluginManager/removeBundle",
      args: (input: ApiOperationInput) => ({ name: input.path.name! })
    }
  ] as const;
  const sources: Record<string, Array<{ field: string; operationId: string; resultPath: string; valuePath: string }>> = {
    "sessions.read": [{
      field: "path.sessionId",
      operationId: "agent.providers.dsh.sessions.list",
      resultPath: "/data/items",
      valuePath: "/id"
    }],
    "sessions.history.read": [{
      field: "path.sessionId",
      operationId: "agent.providers.dsh.sessions.list",
      resultPath: "/data/items",
      valuePath: "/id"
    }],
    "plugins.update": [{
      field: "path.name",
      operationId: "agent.providers.dsh.bundles.list",
      resultPath: "/data",
      valuePath: "/name"
    }],
    "plugins.remove": [{
      field: "path.name",
      operationId: "agent.providers.dsh.bundles.list",
      resultPath: "/data",
      valuePath: "/name"
    }],
    "market.search": [{
      field: "body.url",
      operationId: "agent.providers.dsh.market.indexes.list",
      resultPath: "/data",
      valuePath: "/url"
    }]
  };
  return specs.map(spec => {
    const mutation = "mutation" in spec && spec.mutation === true;
    const schema = "schema" in spec ? spec.schema : undefined;
    const params = spec.path.includes(":sessionId") ? { sessionId: text } : spec.path.includes(":name") ? { name: text } : {};
    return {
      discovery: {
        title: spec.title,
        summary: spec.title,
        category: { id: "native.dsh", title: "DSH native capabilities", parentId: "agents" },
        provider: "dsh",
        inputSources: sources[spec.id] ?? [],
        tags: ["dsh", "native", spec.id.startsWith("sessions") ? "sessions" : "plugins", ...(spec.id === "sessions.history.read" ? ["history", "messages", "tool-events"] : [])]
      },
      contract: {
        operationId: `agent.providers.dsh.${spec.id}`,
        contractVersion: "1.0.0",
        method: spec.method,
        pathTemplate: `/api/agent/providers/dsh${spec.path}`,
        exposure: "public",
        transport: "http",
        description: `${spec.title}. This is DSH-owned native data or functionality. Native event IDs, sequence and cursors are preserved; Rabi delivery records and Rabi plugin packages have separate owners.`,
        request: {
          path: { type: "object", properties: params, required: Object.keys(params), additionalProperties: false },
          query: { type: "object", properties: spec.query, additionalProperties: false },
          headers: { type: "object" },
          body: schema ? { kind: "json", schema, maxBytes: 0 } : { kind: "none" }
        },
        responses: {
          ...Object.fromEntries([400, 404, 409, 503].map(status => [String(status), { mediaType: "application/json", schema: { type: "object", additionalProperties: true } }])),
          "200": {
            mediaType: "application/json",
            schema: {
              type: "object",
              required: ["code", "data"],
              properties: {
                code: { const: 0 },
                data: spec.id === "sessions.history.read" ? {
                  type: "object",
                  required: ["records", "cursor", "hasMore", "provider", "sessionId", "source", "coverage"],
                  properties: {
                    records: {
                      type: "array",
                      items: { description: "Original DSH Session event, retaining seq and native message/tool IDs." }
                    },
                    cursor: { type: "integer" },
                    hasMore: { type: "boolean" },
                    provider: { const: "dsh" },
                    sessionId: { type: "string" },
                    source: { const: "dsh-session-events" },
                    coverage: { type: "object", additionalProperties: true }
                  },
                  additionalProperties: true
                } : {
                  description: "Original DSH owner result. Session listings contain items and nextOffset; plugin and bundle listings retain the native rows, and mutations retain the original ChangeResult."
                }
              },
              additionalProperties: false
            }
          }
        },
        effects: {
          mode: mutation ? "native-mutation" : "read",
          description: mutation ? "DSH PluginManager executes its original install/update/remove operation and owns configuration, dependencies, activation and receipts." : "Reads native DSH data without creating sessions or dispatching prompts."
        },
        recovery: {
          strategy: "native-owner",
          description: mutation ? "Preserve native options/requestId and the original result. Inspect DSH plugin state before any manual retry; a lost response may follow partial installation." : "Continue with the returned native cursor and original session address."
        },
        validators: []
      },
      async handler(input: ApiOperationInput) {
        try {
          input.signal?.throwIfAborted();
          const data = "run" in spec ? await spec.run(input) : await rpc(spec.rpc, spec.args(input), input.signal);
          input.signal?.throwIfAborted();
          return { status: 200, body: { code: 0, data } };
        } catch (error) {
          if (input.signal?.aborted) throw error;
          return {
            status: error instanceof DshNativeError ? error.status : 503,
            ...(mutation ? { mutationOutcome: "unknown" as const } : {}),
            body: {
              code: -1,
              errorCode: error instanceof DshNativeError ? error.code : "DSH_NATIVE_UNAVAILABLE",
              message: error instanceof DshNativeError ? error.message : "The DSH native operation did not return a confirmed result.",
              ...(mutation ? { uncertain: true, mutationOutcome: "unknown" } : {}),
              repair: `Read the current contract for agent.providers.dsh.${spec.id}; preserve the original target and native request identifiers.`
            }
          };
        }
      }
    };
  });
}
