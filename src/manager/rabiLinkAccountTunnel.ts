import { createHash } from "node:crypto";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { PeerTunnelRuntime } from "../peerTunnel/runtime.js";
import { TunnelDenied } from "../peerTunnel/security.js";
import { validateInternalManagerHop } from "../shared/internalManagerHop.js";
import type { AccountProxyRelay } from "./rabiLinkHostAccountProxy.js";

export type AccountTunnelRelay = AccountProxyRelay & { deviceId: string };
export const ACCOUNT_TUNNEL_CAPABILITY = "host-account-tunnel-v1";
export const ACCOUNT_OFFER_PATH = "/api/rabilink/peer/account-receive";

type TunnelOptions = ConstructorParameters<typeof PeerTunnelRuntime>[0];

export class RabiLinkAccountTunnel {
  private current?: { relay: AccountTunnelRelay; runtime: PeerTunnelRuntime };
  private readonly retiring = new Set<Promise<void>>();
  private readonly revokedAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: {
    relay(): AccountTunnelRelay | undefined;
    generation: string;
    dataDir: string;
    readOnly?: boolean;
    discover: TunnelOptions["discover"];
    services: TunnelOptions["services"];
    onStatus: TunnelOptions["onStatus"];
  }) {}

  private same(relay: AccountTunnelRelay, current = this.options.relay()) {
    return !this.stopped && current?.token === relay.token && current.url === relay.url && current.accountId === relay.accountId && current.deviceId === relay.deviceId;
  }

  private retire() {
    const previous = this.current;
    this.current = undefined;
    if (!previous) return;
    const stopping = previous.runtime.stop();
    this.retiring.add(stopping);
    void stopping.then(() => this.retiring.delete(stopping), () => this.retiring.delete(stopping));
  }

  runtime() {
    const relay = this.options.relay();
    if (this.current && !this.same(this.current.relay, relay)) { this.retire(); this.revokedAt.clear(); }
    if (this.stopped || this.options.readOnly || !relay) return;
    if (!this.current) {
      const location = createHash("sha256").update(JSON.stringify([relay.url, relay.accountId, relay.deviceId])).digest("hex");
      const runtime = new PeerTunnelRuntime({
        generation: this.options.generation, deviceId: relay.deviceId,
        dataDir: path.join(this.options.dataDir, "accounts", location), lanScope: "account",
        allowApplicationConnection: () => this.same(relay), relay: () => relay,
        discover: async () => (await this.options.discover()).filter(peer => peer.capabilities.includes(ACCOUNT_TUNNEL_CAPABILITY)),
        signal: async (call, signal) => {
          if (!this.same(relay)) throw new TunnelDenied("peer_service_denied");
          const response = await fetch(`${relay.url}/api/rabilink/peer/account-signal`, {
            method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
            body: JSON.stringify({ targetDeviceId: call.targetDeviceId, offer: call.input })
          });
          if (!response.ok || !this.same(relay)) {
            await response.body?.cancel();
            if (response.status >= 500 && this.same(relay)) throw new Error("Account peer transport offer failed.");
            throw new TunnelDenied("peer_account_signal_denied");
          }
          const result = await response.json() as { deviceId?: string; data?: unknown };
          if (!this.same(relay) || result.deviceId !== call.targetDeviceId || result.data === undefined) throw new TunnelDenied("peer_identity_denied");
          return result.data;
        }, services: this.options.services, onStatus: this.options.onStatus
      });
      this.current = { relay, runtime };
    }
    return this.current.runtime;
  }

  async receive(request: IncomingMessage, body: unknown) {
    const relay = this.options.relay();
    const runtime = this.runtime();
    if (!relay || !runtime) throw new TunnelDenied("peer_service_denied");
    const scope = createHash("sha256").update(`${relay.url}\n${relay.token}`).digest("hex");
    const claims = validateInternalManagerHop(request, { generation: this.options.generation, scope });
    const offer = body as { source?: unknown } | null;
    if (claims?.kind !== "relay" || !offer || offer.source !== claims.deviceId
      || !claims.authenticatedAt || claims.authenticatedAt <= (this.revokedAt.get(claims.deviceId) ?? 0)) throw new TunnelDenied("peer_source_required");
    const data = await runtime.offer(offer);
    if (!this.same(relay)) throw new TunnelDenied("peer_service_denied");
    return { deviceId: relay.deviceId, data };
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url || "/", "http://peer.local");
    if (url.pathname !== "/api/rabilink/peer/tunnel/socket" || url.searchParams.get("scope") !== "account") return false;
    if (!this.runtime()?.upgrade(request, socket, head)) socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return true;
  }

  async stop() {
    this.stopped = true;
    this.retire();
    await Promise.allSettled([...this.retiring]);
  }

  invalidatePeer(deviceId: string, revokedAt: number) {
    this.revokedAt.set(deviceId, revokedAt);
    this.current?.runtime.revokeAccountPeer(deviceId);
  }
  invalidateAll() { this.retire(); }
}
