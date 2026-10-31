import type { ApiUpgradeDefinition } from "../manager/apiOperationContract.js";
import type { PeerTunnelRuntime } from "./runtime.js";
import { TUNNEL_STREAM_LIMITS } from "./session.js";
import { PEER_PROXY_UPGRADE_HANDSHAKE_MS, PEER_PROXY_CONTRACT_HEADER, PEER_PROXY_TARGET_HEADERS } from "./http.js";

export function createPeerProxyUpgradeOperation(owner: Pick<PeerTunnelRuntime, "openProxyUpgrade">,
  admit: (request: import("node:http").IncomingMessage, url: URL) => boolean): ApiUpgradeDefinition {
  return { contract: { operationId: "manager.rabilink.peer.websocket.proxy", contractVersion: "1.0.0", method: "GET",
    pathTemplate: "/api/rabilink/peer/http/:deviceId/:service/:path", exposure: "public", transport: "websocket",
    description: "Upgrade the existing authenticated peer HTTP proxy to a transparent WebSocket without decoding or rewriting application frames.",
    request: { path: { type: "object", required: ["deviceId", "service", "path"], properties: {
      deviceId: { type: "string" }, service: { type: "string" }, path: { type: "string" }
    }, additionalProperties: false }, pathRemainder: "path", contractHeader: PEER_PROXY_CONTRACT_HEADER, query: { type: "object", additionalProperties: true },
      headers: { type: "object", properties: { [PEER_PROXY_TARGET_HEADERS]: { type: "string", description: "Optional JSON object of original target headers. Existing header filters apply; credentials and source proofs are never caller-controlled." } }, additionalProperties: true }, body: { kind: "none" } },
    websocket: { protocol: "rabiroute.peer.websocket-proxy-v1", framing: "passthrough", wire: TUNNEL_STREAM_LIMITS,
      handshakeMs: PEER_PROXY_UPGRADE_HANDSHAKE_MS,
      authentication: "Reuse original Manager admission, source claims and application/device peer authority. Revalidate the original connection while acquiring the target and before every forwarded byte/flush. handshakeMs starts after native target-session acquisition; existing connection budgets remain separate. No persona or per-feature grant is added.",
      completion: "The original socket, tunnel stream and both authorization guards must close before the activation lease completes. Existing shared peer sessions keep their original owner.",
      cancellation: "Retirement stops new upgrades and destroys only owned proxy sockets/streams. It never reconnects or repeats business frames. Data-frame/window/stream limits describe the native multiplexed tunnel, not an aggregate WebSocket message size." },
    responses: { "101": { mediaType: "application/octet-stream", schema: false, headers: {
      type: "object", required: ["upgrade", "connection", "sec-websocket-accept"], properties: {
        upgrade: { const: "websocket" }, connection: { const: "Upgrade" }, "sec-websocket-accept": { type: "string", pattern: "^[A-Za-z0-9+/]{27}=$" }
      }, additionalProperties: true } } },
    effects: { mode: "transparent-peer-connection", description: "The existing target peer/service and application protocol own all operations, state and receipts. The persona alias retains its existing upgrade restriction; ordinary HTTP at the same URL remains a separate dispatch." },
    recovery: { strategy: "reconcile-original-target-before-reconnect", description: "A disconnect may leave an original operation uncertain. Inspect that target's original state/receipt; do not replace identity, switch to local execution or replay frames." },
    validators: [{ id: "peer.native-application-connection", description: "Original fixed-key/scope/generation/device authority, service selection and native admission continue to execute in the peer owner." },
      { id: "peer.native-windowed-byte-stream", description: "Opaque text/binary application frames remain unchanged. Native TunnelStream owns shared data-frame bytes, stream windows, stream-count limits, backpressure and cancellation; no decoded message Schema or whole-message server ceiling is fabricated." }] },
    handler: async input => {
      try { if (!admit(input.request, input.url)) { input.socket.destroy(); return; } await owner.openProxyUpgrade(input); }
      catch { input.socket.destroy(); }
    } };
}
