import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "../manager/apiOperationContract.js";
import type { PeerTunnelRuntime } from "./runtime.js";
import { PEER_EVENT_LIMITS } from "./events.js";
import { TunnelDenied } from "./security.js";
import { hasAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";

const empty = { type: "object", additionalProperties: false } as const;
const selectionSchema = { type: "object", required: ["selectedDeviceId"], properties: { selectedDeviceId: { type: "string" } }, additionalProperties: false } as const;
const statusSchema = { type: "object", required: ["deviceId", "name", "online", "supported", "trusted", "state", "transport", "latencyMs", "measuredAt"], properties: {
  deviceId: { type: "string" }, name: { type: "string" }, online: { type: "boolean" }, supported: { type: "boolean" }, trusted: { type: "boolean" },
  state: { type: "string" }, transport: { type: ["string", "null"] }, latencyMs: { type: ["number", "null"] }, measuredAt: { type: ["number", "null"] },
  personaSupported: { type: "boolean" }, error: { type: "string" }
}, additionalProperties: true } as const;
const directorySchema = { type: "object", required: ["selectedDeviceId", "peers"], properties: { selectedDeviceId: { type: "string" }, peers: { type: "array", items: statusSchema } }, additionalProperties: false } as const;
const errorSchema = { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: false } as const;

export function createPeerControlOperations(owner: Pick<PeerTunnelRuntime, "assertControl" | "selected" | "select" | "directory" | "probe" | "identity" | "events">): ApiOperationDefinition[] {
  type Description = { id: string; description: string; method: "GET" | "POST" | "PUT"; path: string; schema?: ApiSchema; body?: ApiSchema; mutation?: boolean;
    run(input: ApiOperationInput, assertCurrent: () => void): ApiOperationResult | Promise<ApiOperationResult> };
  const json = (body: unknown): ApiOperationResult => ({ status: 200, body, headers: { "cache-control": "no-store" } });
  const descriptions: Description[] = [
    { id: "servers.read", description: "Read the original discovered Peer directory, selected device and current connection/RTT status.", method: "GET", path: "servers", schema: directorySchema, run: async () => json(await owner.directory()) },
    { id: "selection.read", description: "Read the persisted selected Peer device without choosing a replacement.", method: "GET", path: "selection", schema: selectionSchema, run: () => json({ selectedDeviceId: owner.selected() }) },
    { id: "identity.read", description: "Read this Peer device ID, generation and public key; never expose its private key.", method: "GET", path: "identity", schema: { type: "object", required: ["deviceId", "generation", "publicKey"], properties: {
      deviceId: { type: "string" }, generation: { type: "string" }, publicKey: { type: "string" }
    }, additionalProperties: false }, run: () => { const { privateKey: _privateKey, ...identity } = owner.identity; return json(identity); } },
    { id: "probe", description: "Probe up to ten devices through the original connection pool and return the directory, including failed statuses.", method: "POST", path: "probe", schema: directorySchema, mutation: true,
      body: { type: "object", required: ["deviceIds"], properties: { deviceIds: { type: "array", maxItems: PEER_EVENT_LIMITS.ids, items: { type: "string" } } }, additionalProperties: true },
      run: async (input, assertCurrent) => json(await owner.probe((input.body as { deviceIds: string[] }).deviceIds, assertCurrent)) },
    { id: "selection.update", description: "Persist the selected Peer device after original connection checks; an empty deviceId explicitly clears selection.", method: "PUT", path: "selection", schema: selectionSchema, mutation: true,
      body: { type: "object", required: ["deviceId"], properties: { deviceId: { type: "string" } }, additionalProperties: true },
      run: async (input, assertCurrent) => { const { deviceId } = input.body as { deviceId: string }; await owner.select(deviceId, assertCurrent); return json({ selectedDeviceId: deviceId }); } },
    { id: "events", description: "Subscribe to selected-device changes and status for JSON-encoded ids; the first ids query value is used, with no durable replay.", method: "GET", path: "events", run: (input, assertCurrent) => {
      const ids = JSON.parse(input.url.searchParams.get("ids") || "[]") as unknown;
      if (!Array.isArray(ids) || ids.length > PEER_EVENT_LIMITS.ids || ids.some(id => typeof id !== "string")) throw new Error("Invalid event subscription.");
      return { status: 200, headers: { "cache-control": "no-cache", "x-accel-buffering": "no" }, stream: owner.events(ids, assertCurrent) };
    } }
  ];
  return descriptions.map(item => ({ contract: { operationId: "manager.rabilink.peer." + item.id, contractVersion: "1.0.0", method: item.method,
    pathTemplate: "/api/rabilink/peer/" + item.path, description: item.description,
    exposure: "public", transport: item.id === "events" ? "sse" : "http",
    request: { path: empty, query: { type: "object", additionalProperties: true }, headers: { type: "object" },
      body: item.body ? { kind: "json", schema: item.body, maxBytes: 8192, allowAnyContentType: true } : { kind: "none" } },
    responses: { "200": item.id === "events" ? { mediaType: "text/event-stream", stream: {
      framing: "sse-json", maxFrameBytes: PEER_EVENT_LIMITS.frameBytes,
      frameSchema: { type: "object", additionalProperties: false, properties: { event: { enum: ["status", "selection"] }, data: true, comment: { type: "string" } },
        anyOf: [{ required: ["event", "data"], properties: { event: { const: "status" }, data: statusSchema } },
          { required: ["event", "data"], properties: { event: { const: "selection" }, data: selectionSchema } }, { required: ["comment"], properties: { comment: true } }] },
      completion: "EOF after owner stop; notifications carry no durable replay cursor.", cancellation: "Detach original listeners and timer, discard queued frames and join accepted latency callbacks before lease release." }
    } : { mediaType: "application/json", schema: item.schema },
      ...Object.fromEntries([403, 423, 426, 502].map(status => [status, { mediaType: "application/json", schema: errorSchema }])) },
    effects: { mode: item.mutation ? "connection-control" : item.id === "events" ? "connection-subscription" : "connection-observation",
      description: "Original native owners retain discovery cache, connection probes, trust bootstrap and selected-target persistence. Event heartbeats only measure live-channel RTT; identity excludes the private key. No persona or feature permission is introduced." },
    recovery: { strategy: "inspect-original-connection-before-retry", description: "Re-read original selection and connection status after an uncertain change. Reconnect events by refreshing current state; do not replay business writes or silently select local execution." },
    validators: [{ id: "peer.original-control-admission", description: "Original Manager/WebGUI admission and read-only behavior remain. Selection persistence and awaited results revalidate the original caller." },
      { id: "peer.events.bounds", description: "At most ten device IDs; original 15-second live-channel RTT heartbeat and 64 KiB queued-event budget. Slow consumers close instead of buffering without bound." }]
  }, handler: async input => {
    const assertCurrent = () => { input.signal?.throwIfAborted(); hasAuthenticatedConnectionRequest(input.request); owner.assertControl(input.request, input.url, item.mutation === true); };
    let result: ApiOperationResult | undefined;
    try { assertCurrent(); result = await item.run(input, assertCurrent); assertCurrent(); return result; }
    catch (error) {
      await result?.stream?.cancel(error);
      input.signal?.throwIfAborted();
      const status = error instanceof TunnelDenied ? error.message === "manager_read_only" ? 423 : 403 : error instanceof Error && error.message === "peer_upgrade_required" ? 426 : 502;
      return { status, body: { error: error instanceof TunnelDenied || status === 426 ? (error as Error).message : "Remote connection failed; check target version, connection and network." }, headers: { "cache-control": "no-store" } };
    }
  } }));
}
