import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";
import type { LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { TERMINAL_LIMITS, terminalIdSchema, terminalRequestSchema, terminalSnapshotSchema, terminalListSchema,
  terminalEventSchema, terminalReadSchema, computerRequestSchema, computerResponseSchema } from "../../apps/rabi-agent/lib/interactive-protocol.mjs";

export const LAN_AGENT_INTERACTIVE_ROUTES = Object.freeze([
  { key: "terminals.list", method: "GET", pathTemplate: "/api/lan-agent/instances/:instanceId/terminals" },
  { key: "terminals.execute", method: "POST", pathTemplate: "/api/lan-agent/instances/:instanceId/terminals" },
  { key: "terminals.read", method: "GET", pathTemplate: "/api/lan-agent/instances/:instanceId/terminals/:terminalId" },
  { key: "terminals.events", method: "GET", pathTemplate: "/api/lan-agent/instances/:instanceId/terminals/:terminalId/events" },
  { key: "computer.execute", method: "POST", pathTemplate: "/api/lan-agent/instances/:instanceId/computer" }
] as const);
for (const route of LAN_AGENT_INTERACTIVE_ROUTES) Object.freeze(route);
export type InteractiveRoute = typeof LAN_AGENT_INTERACTIVE_ROUTES[number];
export type InteractiveContext = Pick<LanAgentRoutesContext, "registry" | "isManagementRequestAuthorized">;
const text = { type: "string" };
const failure = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"], properties: {
  code: { const: -1 }, message: text, uncertain: { type: "boolean" }
}, additionalProperties: false } };
const json = (data: ApiSchema) => ({ mediaType: "application/json", schema: { type: "object", required: ["code", "data"],
  properties: { code: { const: 0 }, data }, additionalProperties: false } });
export function interactiveApiContract(route: InteractiveRoute): ApiOperationContract {
  const names = [...route.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
  const stream = route.key === "terminals.events";
  return { operationId: `manager.lan-agent.${route.key}`, contractVersion: "1.0.0", method: route.method, pathTemplate: route.pathTemplate,
    exposure: "public", transport: stream ? "sse" : "http", description: "Use the existing remote-computer or terminal owner without a second Agent registration, persona binding or execution runtime.",
    request: { path: { type: "object", required: names, properties: Object.fromEntries(names.map(name => [name, name === "terminalId" ? terminalIdSchema : text])), additionalProperties: false },
      query: { type: "object", additionalProperties: true }, headers: { type: "object", additionalProperties: true },
      body: route.method === "GET" ? { kind: "none" } : { kind: "json", allowAnyContentType: true, maxBytes: Number.MAX_SAFE_INTEGER,
        schema: route.key === "computer.execute" ? computerRequestSchema : terminalRequestSchema } },
    responses: { "200": stream ? { mediaType: "text/event-stream; charset=utf-8", stream: { framing: "sse-json", maxFrameBytes: TERMINAL_LIMITS.streamQueueBytes,
      frameSchema: { anyOf: [
        { type: "object", required: ["id", "data"], properties: { id: text, data: terminalEventSchema }, additionalProperties: false },
        { type: "object", required: ["comment"], properties: { comment: text }, additionalProperties: false }
      ] }, completion: "EOF after exit/disconnected and all accepted queued output; bounded replay emits gap before retained events.",
      cancellation: "Disconnect, revocation or registration retirement removes the viewer, stops keepalive, discards its queue and drains the iterator before releasing the lease. It never closes or re-executes the remote terminal." } }
      : json(route.key === "terminals.list" ? terminalListSchema : route.key === "terminals.read" ? terminalReadSchema
        : route.key === "computer.execute" ? computerResponseSchema : { anyOf: [terminalSnapshotSchema, terminalListSchema] }),
      "400": failure, "401": failure, "403": failure },
    effects: { mode: stream ? "bounded-subscription" : route.method === "POST" ? "remote-interactive-action" : "remote-read",
      description: "The original terminal replay/remote connector owns sessions, ordered input, immutable upload identities, file versions and execution. Await actual command acceptance/cleanup. Reads may ask the existing connector for current session state." },
    recovery: { strategy: "query-original-session-and-sequence", description: "Retain instanceId, terminalId/input sequence or uploadId/offset/hash. After uncertain execution, read the same terminal or upload status before retrying. Reconnect terminal output using the same after cursor and handle gap/disconnected; never replay commands because a stream ended." },
    validators: [{ id: "lan-agent.interactive.original-admission", description: "Use the authenticated public connection or existing local management identity. Revalidate that original admission before remote dispatch and after awaited completion; revocation never falls back to local identity." },
      { id: "lan-agent.interactive.native-protocol", description: "The original executor validates advertised shells, absolute remote paths, UTF-8 input bytes, sequence receipts, canonical chunk bytes/digests, offsets, file versions, upload publication and native desktop conversions. Unknown body fields remain forwarded. Desktop fields preserve native conversion semantics." },
      { id: "lan-agent.interactive.replay-and-capacity", description: "Read after/waitMs use Number(first query value or zero); the replay owner validates safe ordered cursors, bounded waits, viewer counts and connection identity. All admitted callers share the same capacities. Only protocol keepalive uses a timer." }]
  };
}
export function interactiveOperation(route: InteractiveRoute, context: InteractiveContext,
  owner: (input: ApiOperationInput, assertAuthorized: () => void) => ApiOperationResult | Promise<ApiOperationResult>): ApiOperationDefinition {
  return { contract: interactiveApiContract(route), handler: async input => {
    const headers = { "cache-control": "no-store" };
    const result = (status: number, message: string): ApiOperationResult => ({ status, headers, body: { code: -1, message, ...(route.method === "POST" ? { uncertain: true } : {}) } });
    const principal = assertTrustedLanAgentPrincipal(input.request);
    const allowed = () => hasAuthenticatedConnectionRequest(input.request) || context.isManagementRequestAuthorized(input.request, input.url);
    if (!allowed()) return result(401, "A verified connection identity is required.");
    const guard = () => { if (assertTrustedLanAgentPrincipal(input.request) !== principal || !allowed()) throw new Error("Connection identity changed; interactive request stopped."); };
    let output: ApiOperationResult | undefined;
    try { guard(); output = await owner(input, guard); guard(); return output; }
    catch (error) { if (output?.stream) await output.stream.cancel(error);
      try { guard(); } catch { return result(403, "Connection identity changed; interactive request stopped."); }
      return result(400, error instanceof Error ? error.message : String(error)); }
  } };
}
