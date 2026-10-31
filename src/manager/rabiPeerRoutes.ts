import type { IncomingMessage, ServerResponse } from "node:http";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { RabiPeerClient, type PeerCall, type RabiPeer } from "../rabiPeerClient.js";
import { RabiPeerDirect } from "../rabiPeerDirect.js";
import { peerDiscoveryPage } from "../rabiPeerDiscovery.js";
import { RabiPeerDispatcher, PEER_RPC_PATH, type PeerIdentity } from "../rabiPeerProtocol.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

export function createRabiPeerRuntime(options: {
  identity(): PeerIdentity; token(): string; enabled(): boolean;
  tunnelOffer?(input: unknown): Promise<unknown>;
  peers(): Promise<RabiPeer[]>;
  relay(): { url: string; token: string };
  readJson(request: IncomingMessage, maxBytes: number): Promise<unknown>;
  json(response: ServerResponse, status: number, body: unknown): void;
  onResult?(event: { requestId: string; capability: string; operation: string; ok: boolean }): void;
}) {
  let active = true;
  const dispatcher: RabiPeerDispatcher = new RabiPeerDispatcher({ ...options,
    allowed: () => options.enabled() ? ["transport.offer", ...(options.tunnelOffer ? ["transport.tunnel"] : [])] : [],
    operations: [{ capability: "transport", operation: "offer", execute: input => direct.offer(input) },
      ...(options.tunnelOffer ? [{ capability: "transport", operation: "tunnel", execute: options.tunnelOffer }] : [])]
  });
  const direct: RabiPeerDirect = new RabiPeerDirect(packet => dispatcher.receive(packet));
  const client = new RabiPeerClient({ relay: options.relay });
  const pending = new Set<Promise<void>>();
  const receiveOperation: ApiOperationDefinition = {
    contract: {
      operationId: "manager.rabilink.peer.receive", contractVersion: "1.0.0", method: "POST", pathTemplate: PEER_RPC_PATH,
      description: "Receive an encrypted private Peer transport packet; this is not a public business RPC API.", exposure: "internal", transport: "http",
      request: { path: { type: "object", additionalProperties: false }, query: { type: "object" }, headers: { type: "object" },
        body: { kind: "json", schema: true, maxBytes: 1_500_000, allowAnyContentType: true, emptyValue: {} } },
      responses: {
        "200": { mediaType: "application/json", schema: { type: "object", required: ["version", "iv", "data", "tag"], properties: {
          version: { const: 1 }, iv: { type: "string" }, data: { type: "string" }, tag: { type: "string" }
        }, additionalProperties: false } },
        ...Object.fromEntries([400, 503].map(status => [status, { mediaType: "application/json", schema: {
          type: "object", required: ["error"], additionalProperties: false, properties: { error: { type: "string" } }
        } }]))
      },
      effects: { mode: "transport-control", description: "The original encrypted dispatcher owns authentication, target/generation checks and allowed transport offers; retired business operations remain rejected." },
      recovery: { strategy: "original-transport-request", description: "Retain the private request identity and expiry; never convert transport signaling into a business RPC or replay a business write." },
      validators: [{ id: "native-encrypted-peer-packet", description: "The existing dispatcher decrypts and authenticates the packet, validates expiry and target, and rechecks the original application token and Manager identity after execution." }]
    }, handler: async input => {
      if (!active) return { status: 503, body: { error: "Peer runtime is stopping." } };
      try { return { status: 200, body: await dispatcher.receive(input.body) }; }
      catch { return { status: 400, body: { error: "Peer request rejected." } }; }
    }
  };
  const discoveryOperation: ApiOperationDefinition = {
    contract: {
      operationId: "manager.rabilink.peer.list", contractVersion: "1.0.0", method: "GET",
      pathTemplate: "/api/rabilink/peer/list", exposure: "public", transport: "http",
      description: "Discover Relay registrations, filter by deviceKind and online using the first query value, and count the selected registrations.",
      request: { path: { type: "object", additionalProperties: false },
        query: { type: "object", properties: Object.fromEntries(["deviceKind", "online"].map(key => [key,
          { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }])), additionalProperties: true },
        headers: { type: "object" }, body: { kind: "none" } },
      responses: {
        "200": { mediaType: "application/json", schema: { type: "object", required: ["peers", "summary"], additionalProperties: false, properties: {
          peers: { type: "array", items: { type: "object", required: ["id", "online", "deviceKind", "capabilities", "peerUrls"], additionalProperties: true, properties: {
            id: { type: "string" }, online: { type: "boolean" }, deviceKind: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, peerUrls: { type: "array", items: { type: "string" } }
          } } }, summary: { type: "object", required: ["total", "online", "byDeviceKind"], additionalProperties: false, properties: {
            total: { type: "integer", minimum: 0 }, online: { type: "integer", minimum: 0 }, byDeviceKind: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }
          } }
        } } },
        ...Object.fromEntries([400, 403, 502, 503].map(status => [status, { mediaType: "application/json", schema: {
          type: "object", required: ["error"], additionalProperties: false, properties: { error: { type: "string" } }
        } }]))
      },
      effects: { mode: "connection-observation", description: "Queries the existing Relay discovery owner; counts registrations, not physical computers, and does not select a target." },
      recovery: { strategy: "repeatable-read", description: "Repeat discovery after connection recovery; never bootstrap or select another device implicitly." },
      validators: [
        { id: "peer-discovery-filters", description: "The shared peerDiscoveryPage owner validates the first deviceKind and online query values before discovery and normalizes provider device kinds." },
        { id: "original-peer-discovery-caller", description: "Original authenticated admission is rechecked after discovery; a revoked remote caller cannot fall back to loopback access." }
      ]
    },
    handler: async input => {
      const reply = (status: number, body: unknown): ApiOperationResult => ({ status, body, headers: { "cache-control": "no-store" } });
      if (!active) return reply(503, { error: "Peer runtime is stopping." });
      let connectionAuthorized = false;
      const authorized = () => {
        try {
          const current = hasAuthenticatedConnectionRequest(input.request);
          if (connectionAuthorized && !current) return false;
          if (current) { connectionAuthorized = true; return true; }
          if (input.request.headers["x-rabiroute-agent-id"] !== undefined) return false;
          return localModelSettingsRequestAllowed(input.request);
        } catch { return false; }
      };
      input.signal?.throwIfAborted();
      if (!authorized()) return reply(403, { error: "Peer control access denied." });
      try { peerDiscoveryPage([], input.url.searchParams); }
      catch { return reply(400, { error: "Use deviceKind and online=true|false filters." }); }
      try {
        const peers = await options.peers();
        input.signal?.throwIfAborted();
        if (!active) return reply(503, { error: "Peer runtime is stopping." });
        if (!authorized()) return reply(403, { error: "Peer control access denied." });
        return reply(200, peerDiscoveryPage(peers, input.url.searchParams));
      } catch {
        input.signal?.throwIfAborted();
        return reply(502, { error: "Peer call failed; check target, access and connectivity." });
      }
    }
  };
  const handler = (request: IncomingMessage, url: URL, response: ServerResponse): boolean => {
    const receive = url.pathname === PEER_RPC_PATH && request.method === "POST";
    if (!receive) return false;
    const run = (async () => {
      try {
        if (!active) { options.json(response, 503, { error: "Peer runtime is stopping." }); return; }
        const body = await options.readJson(request, 1_500_000);
        const result = await receiveOperation.handler({ request, response, url, body, path: {}, query: {} });
        options.json(response, result.status, result.body);
      } catch {
        options.json(response, 400, { error: "Peer request rejected." });
      }
    })();
    pending.add(run);
    void run.then(() => pending.delete(run), () => pending.delete(run));
    return true;
  };
  return { handler, discoveryOperation, receiveOperation, signal: (call: PeerCall, signal?: AbortSignal) => client.signal(call, signal), async stop() { active = false; await direct.stop(); await Promise.allSettled([...pending]); } };
}
