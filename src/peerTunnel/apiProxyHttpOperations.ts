import type { ApiHttpProxyDefinition } from "../manager/apiOperationContract.js";
import type { PeerTunnelRuntime } from "./runtime.js";
import { TUNNEL_STREAM_LIMITS } from "./session.js";
import { PEER_PROXY_CONTRACT_HEADER, PEER_PROXY_TARGET_HEADERS } from "./http.js";
import { TunnelDenied } from "./security.js";

export function createPeerProxyHttpOperations(owner: Pick<PeerTunnelRuntime, "openProxyHttp">): ApiHttpProxyDefinition[] {
  return (["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "*"] as const).map(method => ({
    contract: { operationId: `manager.rabilink.peer.http.${method === "*" ? "fallback" : method.toLowerCase()}`, contractVersion: "1.0.0", method,
      pathTemplate: "/api/rabilink/peer/http/:deviceId/:service/:path", exposure: "public", transport: "http",
      description: "Forward an opaque HTTP exchange through the existing authenticated peer/service owner, preserving target headers, raw bytes and streaming." + (method === "*" ? " Supply the real HTTP method explicitly; exact method operations take precedence. The original tunnel still validates methods and rejects CONNECT and TRACE." : ""),
      request: { path: { type: "object", required: ["deviceId", "service", "path"], properties: {
        deviceId: { type: "string" }, service: { type: "string" }, path: { type: "string" }
      }, additionalProperties: false }, pathRemainder: "path", contractHeader: PEER_PROXY_CONTRACT_HEADER,
        query: { type: "object", additionalProperties: true }, headers: { type: "object", properties: {
          [PEER_PROXY_TARGET_HEADERS]: { type: "string", description: "Optional JSON object of original target headers; existing credential and hop-header filters apply." }
        }, additionalProperties: true }, body: { kind: "passthrough" } },
      httpProxy: { wire: TUNNEL_STREAM_LIMITS,
        completion: "The native upload/download stream, accepted writes and reset callbacks finish before its activation lease is released. Native target response-header and search timing policies remain effective.",
        cancellation: "Disconnect, retirement or original authority revocation stops owned streams. Shared peer sessions keep their existing owner. Bodies and SSE are streamed with native backpressure; there is no invented whole-body limit." },
      responses: { default: { mediaType: "*/*", passthrough: true } },
      effects: { mode: "transparent-peer-http", description: "The selected target operation owns effects and receipts, including side effects on reads. Existing persona alias restrictions remain; manager service retains all public APIs." },
      recovery: { strategy: "reconcile-original-target-before-retry", description: "Never replay a request after target dispatch. Check the target's original resource, idempotency key and receipt when the outcome is uncertain." },
      validators: [{ id: "peer.native-application-connection", description: "Original Manager admission, application scope, fixed peer key and device/service checks remain authoritative." },
        { id: "peer.native-http-stream", description: "The native owner validates target requests, preserves public headers and response metadata, and guards every dispatched frame, write and completion." }] },
    handler: async input => {
      try { await owner.openProxyHttp(input); }
      catch (error) {
        if (input.response.headersSent) { input.response.destroy(); throw error; }
        input.assertCurrent();
        const status = error instanceof TunnelDenied ? error.message === "manager_read_only" ? 423 : 403 : error instanceof Error && error.message === "peer_upgrade_required" ? 426 : 502;
        input.prepareResponse(status, { "content-type": "application/json", "cache-control": "no-store" });
        input.response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        input.response.end(JSON.stringify({ error: error instanceof TunnelDenied ? error.message : "Remote connection failed; check target version, connection and network." }));
      }
    }
  }));
}
