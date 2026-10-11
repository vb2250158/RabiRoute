import type { IncomingMessage, ServerResponse } from "node:http";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { RabiPeerClient, type PeerCall, type RabiPeer } from "../rabiPeerClient.js";
import { RabiPeerDirect } from "../rabiPeerDirect.js";
import { peerDiscoveryPage } from "../rabiPeerDiscovery.js";
import { RabiPeerDispatcher, PEER_RPC_PATH, type PeerIdentity } from "../rabiPeerProtocol.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";

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
  const handler = (request: IncomingMessage, url: URL, response: ServerResponse): boolean => {
    if (!url.pathname.startsWith("/api/rabilink/peer/")) return false;
    const receive = url.pathname === PEER_RPC_PATH && request.method === "POST";
    const list = url.pathname === "/api/rabilink/peer/list" && request.method === "GET";
    if (!receive && !list) {
      if (url.pathname !== "/api/rabilink/peer/call") return false; // Future public APIs belong to their own Manager handler.
      options.json(response, 404, { error: "Peer business RPC is retired; use the Manager tunnel." }); return true;
    }
    if (!active) { options.json(response, 503, { error: "Peer runtime is stopping." }); return true; }
    let connectionAuthorized = false;
    const authorized = () => {
      try {
        const current = hasAuthenticatedConnectionRequest(request);
        if (connectionAuthorized && !current) return false; // Revoked remote requests never fall back to local-origin access.
        if (current) { connectionAuthorized = true; return true; }
        if (request.headers["x-rabiroute-agent-id"] !== undefined) return false;
        return localModelSettingsRequestAllowed(request);
      } catch { return false; }
    };
    if (!receive) {
      if (!authorized()) { options.json(response, 403, { error: "Peer control access denied." }); return true; }
    }
    const authorize = () => {
      if (!authorized()) throw Object.assign(new Error("Peer control access denied."), { status: 403 });
    };
    const run = (async () => {
      try {
        if (list) {
          // Validate filters before performing Relay discovery.
          try { peerDiscoveryPage([], url.searchParams); }
          catch { options.json(response, 400, { error: "Use deviceKind and online=true|false filters." }); return; }
          const peers = await options.peers();
          authorize();
          options.json(response, 200, peerDiscoveryPage(peers, url.searchParams)); return;
        }
        const body = await options.readJson(request, 1_500_000);
        if (receive) { options.json(response, 200, await dispatcher.receive(body)); return; }
      } catch (error) {
        const denied = (error as { status?: number })?.status === 403;
        options.json(response, receive ? 400 : denied ? 403 : 502,
          { error: receive ? "Peer request rejected." : denied ? "Peer control access denied." : "Peer call failed; check target, access and connectivity." });
      }
    })();
    pending.add(run);
    void run.then(() => pending.delete(run), () => pending.delete(run));
    return true;
  };
  return { handler, signal: (call: PeerCall, signal?: AbortSignal) => client.signal(call, signal), async stop() { active = false; await direct.stop(); await Promise.allSettled([...pending]); } };
}
