import { ApiContractError, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult, type ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";
import type { LanAgentRoutesContext } from "./lanAgentRoutes.js";
import { assertTrustedLanAgentPrincipal } from "@rabiroute/host-api/manager/lanAgentRequestAccess";
import { hasAuthenticatedConnectionRequest } from "@rabiroute/host-api/manager/connectionRequestAccess";
import { lanAgentManagementTransportFailure } from "@rabiroute/host-api/manager/lanAgentManagementContract";
import { TERMINAL_LIMITS, terminalIdSchema, terminalRequestSchema, terminalSnapshotSchema, terminalListSchema,
  terminalEventSchema, terminalReadSchema, computerRequestSchema, computerResponseSchema, isComputerReadOnlyAction, COMPUTER_ACTIONS, TERMINAL_ACTIONS, terminalActionDefinition } from "@rabiroute/host-api/shared/agentInteractiveProtocol";

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
  code: { const: -1 }, message: text, uncertain: { type: "boolean" }, mutationOutcome: {enum:["not_started","unknown"]}, errorCode: text, field: text, reason: text, repair: text, retryable: { const: false },
  help: { type: 'object', required: ['method', 'path'], properties: { method: { const: 'GET' }, path: text }, additionalProperties: false }
}, additionalProperties: false } };
const json = (data: ApiSchema) => ({ mediaType: "application/json", schema: { type: "object", required: ["code", "data"],
  properties: { code: { const: 0 }, data }, additionalProperties: false } });
export function interactiveApiContract(route: InteractiveRoute): ApiOperationContract {
  const names = [...route.pathTemplate.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map(match => match[1]!);
  const stream = route.key === "terminals.events";
  return { operationId: `manager.lan-agent.${route.key}`, contractVersion: "1.0.0", method: route.method, pathTemplate: route.pathTemplate,
    exposure: "public", transport: stream ? "sse" : "http", description: "Use the target host's local computer services or existing connector without a second Agent registration, persona binding or execution runtime.",
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
      "400": failure, "401": failure, "403": failure, "409": failure, "503": failure },
    effects: { mode: stream ? "bounded-subscription" : route.method === "POST" ? "remote-interactive-action" : "remote-read",
      ...(route.key === "computer.execute" || route.key === "terminals.execute" ? { request: { bodyPath: ["action"], modes: Object.fromEntries(Object.entries(route.key === "computer.execute" ? COMPUTER_ACTIONS : TERMINAL_ACTIONS).map(([action, value]) => [action, value.readOnly ? "read" as const : "write" as const])) } } : {}),
      description: "The original host service or connector owns sessions, ordered input, immutable upload identities, file versions and execution; the Registry retains bounded terminal output replay. Await actual command acceptance/cleanup." },
    recovery: { strategy: "query-original-session-and-sequence", description: "Retain instanceId, terminalId/input sequence or uploadId/offset/hash. After uncertain execution, read the same terminal or upload status before retrying. Reconnect terminal output using the same after cursor and handle gap/disconnected; never replay commands because a stream ended." },
    validators: [{ id: "lan-agent.interactive.original-admission", description: "Use the authenticated public connection or existing local management identity. Revalidate that original admission before remote dispatch and after awaited completion; revocation never falls back to local identity." },
      { id: "lan-agent.interactive.native-protocol", description: "The original executor validates advertised shells, absolute remote paths, UTF-8 input bytes, sequence receipts, canonical chunk bytes/digests, offsets, file versions, upload publication and native desktop conversions. Unknown body fields remain forwarded. Desktop fields preserve native conversion semantics." },
      { id: "lan-agent.interactive.replay-and-capacity", description: "Read after/waitMs use Number(first query value or zero); the replay owner validates safe ordered cursors, bounded waits, viewer counts and connection identity. All admitted callers share the same capacities. Only protocol keepalive uses a timer." }]
  };
}
export function interactiveOperation(route: InteractiveRoute, context: InteractiveContext,
  owner: (input: ApiOperationInput, assertAuthorized: () => void) => ApiOperationResult | Promise<ApiOperationResult>): ApiOperationDefinition {
  return { contract: interactiveApiContract(route),
    ...(route.key === "computer.execute" ? {discovery:{title:"电脑操作与屏幕标注",summary:"文件、窗口、截图、鼠标键盘控制会话与静态/动态屏幕标注。非空ownerDeviceId的完整远端主机经原Peer manager服务转接原路径/原body；先描述对应get/post/patch合同，沿deviceId/service/path及x-rabiroute-proxy-contract，不把远端instanceId投本机。",relatedOperations:["manager.rabilink.peer.http.get","manager.rabilink.peer.http.post","manager.rabilink.peer.http.patch"],category:{id:"devices",title:"设备与电脑"},keywords:["电脑控制","屏幕标注","动态跟踪","鼠标","键盘","computer control","annotation","tracking"],inputSources:[{field:"path.instanceId",operationId:"manager.lan-agent.instances.list",resultPath:"instances",valuePath:"instanceId"}]}} : {}), handler: async input => {
    const headers = { "cache-control": "no-store" };
    const action = (input.body as Record<string, unknown> | undefined)?.action;
    const readOnly = route.method === "GET" || route.key === "terminals.execute" && terminalActionDefinition(String(action))?.readOnly === true || route.key === "computer.execute" && isComputerReadOnlyAction(String(action));
    const result = (status: number, message: string): ApiOperationResult => ({ status, headers, body: { code: -1, message, ...(!readOnly ? { uncertain: true } : {}) } });
    const principal = assertTrustedLanAgentPrincipal(input.request);
    const allowed = () => hasAuthenticatedConnectionRequest(input.request) || context.isManagementRequestAuthorized(input.request, input.url);
    if (!allowed()) return result(401, "A verified connection identity is required.");
    const guard = () => { if (assertTrustedLanAgentPrincipal(input.request) !== principal || !allowed()) throw new Error("Connection identity changed; interactive request stopped."); };
    const featureGuard = () => { guard(); if (route.key.startsWith("terminals.") && route.key !== "terminals.list" && !(route.key === "terminals.execute" && terminalActionDefinition(String(action))?.recovery)) context.registry.assertComputerFeature(input.path.instanceId!, "terminal"); };
    let output: ApiOperationResult | undefined;
    try { featureGuard(); output = await owner(input, featureGuard); guard(); return output; }
    catch (error) { if (output?.stream) await output.stream.cancel(error);
      try { guard(); } catch { return result(403, "Connection identity changed; interactive request stopped."); }
      if ((error as { code?: unknown })?.code === 'TERMINAL_STREAM_NOT_FOUND' && route.key.startsWith('terminals.')) {
        const path = `/api/lan-agent/instances/${encodeURIComponent(input.path.instanceId!)}/terminals`;
        const example = JSON.stringify({ action: 'open', terminalId: input.path.terminalId, shell: '<selected data.shells value>' });
        return { status: 400, headers, body: { code: -1, errorCode: 'TERMINAL_STREAM_NOT_FOUND', field: 'path.terminalId', reason: 'terminal_stream_not_open',
          message: error instanceof Error ? error.message : 'Terminal stream is not open on this connection.', retryable: false,
          help: { method: 'GET', path },
          repair: `Read GET ${path} for data.shells and data.sessions; GET /api/lan-agent/instances identifies the same instance and its terminalShells. `
            + `Read GET /api/agent/help?operationId=manager.lan-agent.terminals.execute for the open contract. If opening this session is authorized, POST ${path} ${example}; keep the same terminalId and choose shell from data.shells. `
            + 'This error means the output stream is absent on this Manager connection, not that the remote process or file is missing. Discovery does not open a terminal, execute commands or replay prior input. Lookup failures and 401/403 must be resolved as connection/access failures.' } };
      }
      if ((error as { code?: string })?.code?.startsWith("COMPUTER_")) {
        const value = error as Error & { code: string; feature?: string; field?:string; uncertain?:boolean; deliveryFrameSent?:boolean; mutationOutcome?:string; nextAction?:string };
        const settingsDisabled = value.code === "COMPUTER_FEATURE_DISABLED" || value.code === "COMPUTER_DYNAMIC_DISABLED";
        const resultUnknown = value.uncertain === true || value.code === "COMPUTER_RESULT_UNCERTAIN";
        const uncertain = !readOnly && resultUnknown;
        const conflict = ["COMPUTER_REQUEST_CONFLICT","COMPUTER_LAYER_CHANGED","COMPUTER_CONTROL_BUSY","COMPUTER_CONTROL_NOT_ACTIVE","COMPUTER_SOURCE_MISMATCH","COMPUTER_LAYER_SOURCE_MISMATCH","COMPUTER_FRAME_EXPIRED"].includes(value.code);
        const unavailable = value.code.includes("UNAVAILABLE") || value.code.startsWith("COMPUTER_NATIVE_");
        // A format check describes this dispatch. The original ID may already have a remote receipt.
        const notStarted = value.code !== "COMPUTER_IMAGE_VIEW_UNSUPPORTED"
          && (value.deliveryFrameSent === false || value.mutationOutcome === "not_started");
        const status = settingsDisabled ? 403 : resultUnknown ? 503 : conflict ? 409 : unavailable ? 503 : 400;
        const repair = settingsDisabled ? "Open RabiLink → 电脑控制 and update this target's visible settings."
          : resultUnknown ? readOnly ? "The original status lookup is unavailable. Read the same original resource status; this failed lookup is not evidence of a write or an absent resource." : "Query the original input.status, control.status or annotation status with its original request/resource ID. Do not repeat the input or change its ID."
          : value.nextAction ?? `Read GET /api/agent/help?operationId=${encodeURIComponent(interactiveApiContract(route).operationId)} and the original resource status. Correct the reported field or target availability without replaying an accepted action.`;
        return {status,headers,body:{code:-1,errorCode:value.code,field:value.field ?? (settingsDisabled ? value.feature ? `features.${value.feature}` : "computerSettings" : value.code === "COMPUTER_REQUEST_CONFLICT" ? "requestId" : "operation"),message:value.message,repair,retryable:false,
          ...(!readOnly && notStarted ? {mutationOutcome:"not_started",uncertain:false} : uncertain ? {mutationOutcome:"unknown",uncertain:true} : !readOnly && Object.hasOwn(value,"uncertain") ? {uncertain:value.uncertain} : {})}};
      }
      if (error instanceof ApiContractError) throw error;
      const transport = lanAgentManagementTransportFailure(error, interactiveApiContract(route).operationId, readOnly);
      if (transport) return transport;
      return result(400, error instanceof Error ? error.message : String(error)); }
  } };
}
