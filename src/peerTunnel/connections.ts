import { EventEmitter } from "node:events";
import type { PeerConnectionStatus, TunnelTransport } from "../shared/peerTunnelContract.js";
import { TunnelDenied } from "./security.js";
import type { TunnelSession } from "./session.js";
export type TunnelCandidate = { id: string; name: string; online: boolean; supported: boolean; trusted: boolean; peerUrls: string[] };
export class PeerConnections extends EventEmitter {
  private readonly entries = new Map<string, { session?: TunnelSession; status: PeerConnectionStatus; flight?: Promise<TunnelSession> }>();
  private readonly controller = new AbortController();
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private selected = "";
  private readonly upgrading = new Set<string>();
  private readonly retired = new Set<TunnelSession>();
  private readonly idleTimers = new Map<TunnelSession, ReturnType<typeof setTimeout>>();
  constructor(private readonly connect: (target: TunnelCandidate, transport: TunnelTransport, signal: AbortSignal) => Promise<TunnelSession>) {
    super();

  }
  select(id: string) {
    this.selected = id;
    for (const [peerId, entry] of this.entries) if (entry.session) this.armIdle(entry.session, peerId);
  }
  private armIdle(session: TunnelSession, id: string) {
    clearTimeout(this.idleTimers.get(session)); this.idleTimers.delete(session);
    if (session.closed || id === this.selected) return;
    const timer = setTimeout(() => { this.idleTimers.delete(session); if (!session.streams.size) session.close(); }, 60_000);
    timer.unref(); this.idleTimers.set(session, timer);
  }
  private own(session: TunnelSession, id: string) {
    const activity = () => this.armIdle(session, id);
    session.on("activity", activity); this.armIdle(session, id);
    session.once("close", () => { session.removeListener("activity", activity); clearTimeout(this.idleTimers.get(session)); this.idleTimers.delete(session); });
  }
  private entry(peer: TunnelCandidate) {
    let entry = this.entries.get(peer.id);
    if (!entry) {
      entry = { status: { deviceId: peer.id, name: peer.name, online: peer.online, supported: peer.supported, trusted: peer.trusted,
        state: peer.online ? "idle" : "offline", transport: null, latencyMs: null, measuredAt: null } };
      this.entries.set(peer.id, entry);
    }
    Object.assign(entry.status, { name: peer.name, online: peer.online, supported: peer.supported, trusted: peer.trusted });
    return entry;
  }
  private publish(status: PeerConnectionStatus) { this.emit("status", { ...status }); }
  snapshot(peer: TunnelCandidate): PeerConnectionStatus {
    const entry = this.entry(peer);
    // A verified live direct channel is stronger evidence than stale Relay presence.
    if (!peer.online && !entry.session) entry.status.state = "offline";
    if (entry.session && !entry.session.closed) entry.status.online = true;
    const value = { ...entry.status };
    if (!value.measuredAt || Date.now() - value.measuredAt > 30_000) value.latencyMs = null;
    return value;
  }
  async get(peer: TunnelCandidate, probe = false): Promise<TunnelSession> {
    const entry = this.entry(peer);
    if (!peer.supported || !peer.trusted) throw new TunnelDenied("peer_upgrade_or_trust_required");
    if (entry.flight) return entry.flight;
    if (entry.session && !entry.session.closed) {
      if (probe && (!entry.status.measuredAt || Date.now() - entry.status.measuredAt > 5_000)) {
        try { await this.measure(entry.session, entry.status); } catch { /* Only the connectivity probe is retried below. */ }
      }
      if (entry.session && !entry.session.closed) return entry.session;
    }
    const flight = this.establish(peer, entry);
    entry.flight = flight;
    try { return await flight; } finally { if (entry.flight === flight) entry.flight = undefined; }
  }
  private async measure(session: TunnelSession, status: PeerConnectionStatus) {
    status.latencyMs = Math.round(await session.ping() * 10) / 10;
    status.measuredAt = Date.now(); this.publish(status);
  }
  private async establish(peer: TunnelCandidate, entry: { session?: TunnelSession; status: PeerConnectionStatus }) {
    if (this.active >= 2) await new Promise<void>(resolve => peer.id === this.selected ? this.queue.unshift(resolve) : this.queue.push(resolve));
    if (this.controller.signal.aborted) throw new Error("Tunnel manager stopped.");
    this.active++;
    Object.assign(entry.status, { state: "connecting", latencyMs: null, measuredAt: null, transport: null, error: undefined }); this.publish(entry.status);
    try {
      for (const transport of ["lan", "p2p", "relay"] as const) {
        if (transport === "lan" && !peer.peerUrls.length) continue;
        const timeout = transport === "lan" ? 2_000 : transport === "p2p" ? 10_000 : 5_000;
        const attempt = new AbortController();
        const timer = setTimeout(() => attempt.abort(), timeout);
        const signal = AbortSignal.any([attempt.signal, this.controller.signal]);
        try {
          const session = await this.connect(peer, transport, signal);
          if (signal.aborted) { session.close(); throw new Error("Tunnel attempt expired."); }
          try { await this.measure(session, entry.status); } catch (error) { session.close(); throw error; }
          if (signal.aborted) { session.close(); throw new Error("Tunnel attempt expired."); }
          entry.session = session; this.own(session, peer.id);
          Object.assign(entry.status, { state: "connected", online: true, transport, error: undefined }); this.publish(entry.status);
          session.once("close", () => {
            if (entry.session !== session) return;
            entry.session = undefined;
            Object.assign(entry.status, { state: "idle", transport: null, latencyMs: null, measuredAt: null }); this.publish(entry.status);
          });
          return session;
        } catch (error) { if (error instanceof TunnelDenied) throw error; }
        finally { clearTimeout(timer); }
      }
      throw new Error("peer_connection_failed");
    } catch (error) {
      Object.assign(entry.status, { state: "failed", transport: null, latencyMs: null, measuredAt: null, error: error instanceof TunnelDenied ? error.message : "peer_connection_failed" }); this.publish(entry.status); throw error;
    } finally { this.active--; this.queue.shift()?.(); }
  }
  async reconsider(peer: TunnelCandidate) {
    const entry = this.entry(peer), previous = entry.session;
    if (!previous || previous.closed || entry.status.transport === "lan" || this.upgrading.has(peer.id) || this.active >= 2) return;
    this.upgrading.add(peer.id); this.active++;
    try {
      const transports = entry.status.transport === "p2p" ? ["lan"] as const : ["lan", "p2p"] as const;
      for (const transport of transports) {
        if (transport === "lan" && !peer.peerUrls.length) continue;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), transport === "lan" ? 2_000 : 10_000);
        try {
          const session = await this.connect(peer, transport, AbortSignal.any([controller.signal, this.controller.signal]));
          if (controller.signal.aborted || this.controller.signal.aborted || entry.session !== previous) { session.close(); return; }
          let latency: number;
          try { latency = await session.ping(); } catch (error) { session.close(); throw error; }
          if (controller.signal.aborted || this.controller.signal.aborted || entry.session !== previous) { session.close(); return; }
          entry.session = session; this.own(session, peer.id); entry.status.transport = transport; entry.status.latencyMs = Math.round(latency * 10) / 10; entry.status.measuredAt = Date.now();
          this.publish(entry.status);
          session.once("close", () => { if (entry.session === session) { entry.session = undefined; Object.assign(entry.status, { state: "idle", transport: null, latencyMs: null, measuredAt: null }); this.publish(entry.status); } });
          this.retired.add(previous);
          const finish = () => { if (!previous.streams.size) { this.retired.delete(previous); previous.close(); } };
          previous.once("close", () => this.retired.delete(previous));
          for (const stream of previous.streams.values()) stream.once("close", finish); finish(); return;
        } catch (error) { if (error instanceof TunnelDenied) return; }
        finally { clearTimeout(timer); }
      }
    } finally { this.active--; this.upgrading.delete(peer.id); this.queue.shift()?.(); }
  }
  async refreshLatency(ids: string[]) {
    await Promise.all(ids.map(async id => { const entry = this.entries.get(id); if (entry?.session && !entry.session.closed) {
      try { await this.measure(entry.session, entry.status); } catch { /* Close event clears stale transport/RTT. */ }
    } }));
  }
  stop() { for (const timer of this.idleTimers.values()) clearTimeout(timer); this.idleTimers.clear(); this.controller.abort(); for (const session of this.retired) session.close(); this.retired.clear(); for (const entry of this.entries.values()) entry.session?.close(); while (this.queue.length) this.queue.shift()?.(); }
}
