import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { connectWebsocket, websocketChannel, type TunnelChannel } from "./channel.js";
import { loadTunnelIdentity, TunnelDenied, type TunnelGrant } from "./security.js";
import { establishTunnel, type TunnelSession } from "./session.js";
import { PeerConnections, type TunnelCandidate } from "./connections.js";
import { TunnelRtc } from "./rtc.js";
import { proxyTunnel, proxyTunnelUpgrade, serveTunnel, tunnelFetch, type TunnelService } from "./http.js";
import type { DiscoveredRabiPeer } from "../rabiPeerDiscovery.js";
import type { PeerCall } from "../rabiPeerClient.js";

type Config = { selectedDeviceId: string; trustedDevices: TunnelGrant[]; services: Record<string, TunnelService> };
export class PeerTunnelRuntime {
  private readonly file: string;
  private readonly rtc = new TunnelRtc();
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 40_000, perMessageDeflate: false });
  private readonly incoming = new Set<TunnelSession>();
  private readonly controller = new AbortController();
  private accepting = 0;
  private bonjour?: Bonjour;
  private lanBrowser?: Browser;
  private lanPublication?: Service;
  private readonly lanPeers = new Map<string, DiscoveredRabiPeer>();
  readonly connections: PeerConnections;
  private peers: DiscoveredRabiPeer[] = [];
  private directoryFlight?: Promise<DiscoveredRabiPeer[]>;
  private directoryAt = 0;
  readonly identity;
  constructor(private readonly options: {
    dataDir: string; deviceId: string; generation: string; readOnly?: boolean;
    discover(): Promise<DiscoveredRabiPeer[]>;
    signal(call: PeerCall, signal?: AbortSignal): Promise<unknown>;
    relay(): { url: string; token: string };
    services(): Record<string, TunnelService>;
    onStatus(value: unknown): void;
    allowControl?(request: http.IncomingMessage, url: URL): boolean;
  }) {
    this.file = path.join(options.dataDir, "tunnel.json");
    this.identity = loadTunnelIdentity(path.join(options.dataDir, "tunnel-identity.json"), options.deviceId, options.generation);
    this.connections = new PeerConnections((peer, transport, signal) => this.connect(peer, transport, signal));
    this.connections.select(this.config().selectedDeviceId);
    this.connections.on("status", value => options.onStatus(value));
  }
  private config(): Config {
    try {
      const bytes = readFileSync(this.file); if (bytes.length > 65_536) throw new Error("Tunnel config too large.");
      const value = JSON.parse(bytes.toString()) as Config;
      if (typeof value.selectedDeviceId !== "string" || !Array.isArray(value.trustedDevices) || value.trustedDevices.some(grant => typeof grant.deviceId !== "string" || typeof grant.publicKey !== "string" || !Array.isArray(grant.services) || grant.services.some(service => typeof service !== "string"))) throw new Error("Invalid tunnel grants.");
      return { ...value, services: value.services || {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { selectedDeviceId: "", trustedDevices: [], services: {} };
      throw error; // Corrupt authorization must fail closed, not reset selection to local.
    }
  }
  selected() { return this.config().selectedDeviceId; }
  private controlAllowed(request: http.IncomingMessage, url: URL): boolean {
    return this.options.allowControl ? this.options.allowControl(request, url) : ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress || "");
  }
  private grant(id: string): TunnelGrant {
    const grant = this.config().trustedDevices.find(item => item.deviceId === id);
    if (!grant) throw new TunnelDenied("peer_device_not_trusted"); return grant;
  }
  async select(id: string) {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    if (id) { this.grant(id); const peer = await this.target(id); if (!peer.supported) throw new Error("peer_upgrade_required"); }
    const config = this.config(); config.selectedDeviceId = id;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temp, this.file);
    this.connections.select(id); this.connections.emit("selection", { selectedDeviceId: id }); this.options.onStatus({ selectedDeviceId: id });
  }
  startLanDiscovery(port: number) {
    if (this.bonjour || !Number.isInteger(port) || port < 1) return;
    this.bonjour = new Bonjour({}, () => { /* LAN discovery may be unavailable; other transports remain usable. */ });
    this.lanPublication = this.bonjour.publish({ name: "RabiTunnel-" + this.options.generation.slice(0, 12), type: "rabitunnel", protocol: "tcp", port,
      txt: { protocol: "1", deviceId: this.identity.deviceId, generation: this.identity.generation } });
    this.lanBrowser = this.bonjour.find({ type: "rabitunnel", protocol: "tcp" });
    this.lanBrowser.on("up", service => {
      const id = String(service.txt?.deviceId || "");
      if (!id || id === this.identity.deviceId || String(service.txt?.protocol) !== "1" || this.lanPeers.size >= 32) return;
      try { this.grant(id); } catch { return; }
      const addresses = (service.addresses || []).filter(value => /^\d+\.\d+\.\d+\.\d+$/.test(value)).slice(0, 4);
      const known = this.peers.find(peer => peer.id === id);
      const peer: DiscoveredRabiPeer = { id, name: known?.name || id, online: true, deviceKind: "pc", capabilities: ["peer-tunnel-v1"], peerUrls: addresses.map(address => "http://" + address + ":" + service.port) };
      this.lanPeers.set(id, peer);
      void this.connections.reconsider(this.candidate(peer));
      this.options.onStatus(this.connections.snapshot(this.candidate(peer)));
    });
    this.lanBrowser.on("down", service => { this.lanPeers.delete(String(service.txt?.deviceId || "")); });
  }
  private mergedPeers() {
    const map = new Map(this.peers.map(peer => [peer.id, peer]));
    for (const [id, peer] of this.lanPeers) {
      const old = map.get(id); map.set(id, { ...peer, name: old?.name || peer.name, peerUrls: [...new Set([...peer.peerUrls, ...(old?.peerUrls || [])])].slice(0, 4) });
    }
    return [...map.values()];
  }
  async directory(force = false) {
    if (!this.directoryFlight && (force || Date.now() - this.directoryAt > 5_000)) {
      const flight = this.options.discover().then(peers => { this.peers = peers; this.directoryAt = Date.now(); return peers; }).catch(error => {
        if (!this.lanPeers.size && !this.peers.length) throw error;
        this.directoryAt = Date.now(); this.peers = this.peers.map(peer => ({ ...peer, online: false })); return this.peers;
      });
      this.directoryFlight = flight;
      void flight.finally(() => { if (this.directoryFlight === flight) this.directoryFlight = undefined; }).catch(() => {});
    }
    if (this.directoryFlight) await this.directoryFlight;
    return { selectedDeviceId: this.selected(), peers: this.mergedPeers().filter(peer => peer.id !== this.identity.deviceId).map(peer => this.connections.snapshot(this.candidate(peer))) };
  }
  private candidate(peer: DiscoveredRabiPeer): TunnelCandidate {
    return { ...peer, supported: peer.capabilities.includes("peer-tunnel-v1"), trusted: this.config().trustedDevices.some(grant => grant.deviceId === peer.id) };
  }
  private async target(id: string) {
    await this.directory(); const peer = this.mergedPeers().find(item => item.id === id);
    if (!peer) throw new Error("peer_not_discovered"); return this.candidate(peer);
  }
  async session(id: string, probe = false) {
    const grant = this.grant(id);
    const session = await this.connections.get(await this.target(id), probe);
    if (session.remote.publicKey !== grant.publicKey) { session.close(); throw new TunnelDenied("peer_identity_changed"); }
    return session;
  }
  async probe(ids: string[]) {
    if (ids.length > 10) throw new Error("At most ten visible peers may be probed.");
    await Promise.all(ids.map(async id => { try { await this.session(id, true); } catch { /* Status remains visible in the directory. */ } }));
    return this.directory();
  }
  async proxySelected(request: http.IncomingMessage, url: URL, response: http.ServerResponse) {
    const selected = this.selected();
    if (!selected) throw new Error("No remote server selected.");
    await proxyTunnel(await this.session(selected), "manager", url.pathname + url.search, request, response);
  }
  fetch(id: string, service: string, pathname: string, init: RequestInit = {}) {
    return this.session(id).then(session => tunnelFetch(session, service, pathname, init));
  }
  private relayUrl(room: string) {
    const relay = this.options.relay(); const url = new URL(relay.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Relay address.");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/api/rabilink/tunnel/socket"; url.search = new URLSearchParams({ room }).toString();
    return { url: url.toString(), headers: { "x-rabilink-token": relay.token } };
  }
  private accept(channel: TunnelChannel, source: string) {
    if (this.accepting + this.incoming.size >= 8 || this.controller.signal.aborted) { channel.close(); return; }
    let grant: TunnelGrant; try { grant = this.grant(source); } catch { channel.close(); return; }
    this.accepting++;
    void establishTunnel(channel, this.identity, grant, false, AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]))
      .then(session => {
        this.incoming.add(session); session.once("close", () => this.incoming.delete(session));
        serveTunnel(session, () => ({ ...this.options.services(), ...this.config().services }), service => {
          const current = this.grant(source); return current.publicKey === session.remote.publicKey && current.services.includes(service);
        });
      }).catch(() => channel.close()).finally(() => this.accepting--);
  }
  async offer(input: unknown): Promise<unknown> {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    const value = input as { source?: string; kind?: string; sdp?: string; room?: string };
    if (!value || typeof value.source !== "string") throw new TunnelDenied("peer_source_required");
    this.grant(value.source);
    if (this.accepting + this.incoming.size >= 8) throw new Error("Tunnel connection limit reached.");
    if (value.kind === "p2p") return this.rtc.offer(value.sdp, channel => this.accept(channel, value.source!));
    if (value.kind === "relay" && typeof value.room === "string" && /^[a-f0-9-]{36}$/.test(value.room)) {
      const endpoint = this.relayUrl(value.room);
      const channel = await connectWebsocket(endpoint.url, endpoint.headers, AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]));
      this.accept(channel, value.source); return { ready: true };
    }
    throw new Error("Invalid tunnel offer.");
  }
  proxyUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url || "/", "http://peer.local");
    const match = url.pathname.match(/^\/api\/rabilink\/peer\/http\/([^/]+)\/([^/]+)(\/.*)$/);
    if (!match) return false;
    if (this.options.readOnly) { socket.destroy(); return true; }
    if (!this.controlAllowed(request, url)) { socket.destroy(); return true; }
    void this.session(decodeURIComponent(match[1])).then(session => proxyTunnelUpgrade(session, decodeURIComponent(match[2]), match[3] + url.search, request, socket, head)).catch(() => socket.destroy());
    return true;
  }
  upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url || "/", "http://peer.local");
    if (url.pathname !== "/api/rabilink/peer/tunnel/socket") return false;
    const source = url.searchParams.get("source") || "";
    try { if (this.options.readOnly) throw new TunnelDenied("manager_read_only"); this.grant(source); if (this.accepting + this.incoming.size >= 8) throw new Error("busy"); }
    catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return true; }
    this.websocket.handleUpgrade(request, socket, head, ws => this.accept(websocketChannel(ws), source)); return true;
  }
  private async connect(peer: TunnelCandidate, transport: "lan" | "p2p" | "relay", signal: AbortSignal): Promise<TunnelSession> {
    const grant = this.grant(peer.id);
    const establish = async (channel: TunnelChannel) => {
      const session = await establishTunnel(channel, this.identity, grant, true, signal);
      if (signal.aborted) { session.close(); throw new Error("Tunnel attempt cancelled."); } return session;
    };
    if (transport === "lan") {
      const controllers = peer.peerUrls.slice(0, 4).map(() => new AbortController());
      try {
        const winner = await Promise.any(peer.peerUrls.slice(0, 4).map(async (raw, index) => {
          const url = new URL(raw); const parts = url.hostname.split(".").map(Number); const [a,b] = parts;
          if (url.protocol !== "http:" || url.username || url.password || parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
            || !(a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) throw new Error("Invalid LAN candidate.");
          url.protocol = "ws:"; url.pathname = "/api/rabilink/peer/tunnel/socket"; url.search = new URLSearchParams({ source: this.identity.deviceId }).toString();
          const attempt = AbortSignal.any([signal, controllers[index].signal]);
          const channel = await connectWebsocket(url.toString(), {}, attempt);
          const session = await establishTunnel(channel, this.identity, grant, true, attempt);
          if (attempt.aborted) { session.close(); throw new Error("Candidate cancelled."); }
          return { session, index };
        }));
        controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); }); return winner.session;
      } catch (error) { controllers.forEach(controller => controller.abort()); throw error; }
    }
    const signalRemote = (input: unknown) => this.options.signal({ targetDeviceId: peer.id, capability: "transport", operation: "tunnel", input }, signal);
    if (transport === "p2p") {
      const channel = await this.rtc.connect(async offer => await signalRemote({ ...offer, source: this.identity.deviceId, kind: "p2p" }) as { sdp: string }, signal);
      return establish(channel);
    }
    const room = randomUUID(); const endpoint = this.relayUrl(room);
    await signalRemote({ source: this.identity.deviceId, kind: "relay", room });
    if (signal.aborted) throw new Error("Tunnel attempt cancelled.");
    return establish(await connectWebsocket(endpoint.url, endpoint.headers, signal));
  }
  handler(request: http.IncomingMessage, url: URL, response: http.ServerResponse, readJson: (request: http.IncomingMessage, maxBytes: number) => Promise<unknown>): boolean {
    const prefix = "/api/rabilink/peer/";
    if (!url.pathname.startsWith(prefix)) return false;
    const action = url.pathname.slice(prefix.length);
    if (!["servers", "probe", "selection", "identity", "events"].includes(action) && !action.startsWith("http/")) return false;
    const send = (status: number, data: unknown) => { if (!response.headersSent) response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); };
    if (!this.controlAllowed(request, url)) { send(403, { error: "请通过已授权的 WebGUI 访问语音服务器。" }); return true; }
    if (this.options.readOnly && (request.method !== "GET" || action.startsWith("http/"))) { send(423, { error: "manager_read_only" }); return true; }
    const run = async () => {
      if (action === "events" && request.method === "GET") {
        const ids = JSON.parse(url.searchParams.get("ids") || "[]") as unknown;
        if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== "string")) throw new Error("Invalid event subscription.");
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" }); response.write(": connected\n\n");
        const listener = (value: { deviceId: string }) => { if (ids.includes(value.deviceId)) { if (response.writableLength > 65_536) response.destroy(); else response.write("event: status\ndata: " + JSON.stringify(value) + "\n\n"); } };
        const selection = (value: unknown) => response.write("event: selection\ndata: " + JSON.stringify(value) + "\n\n");
        const stopped = () => response.end();
        this.connections.on("selection", selection);
        this.controller.signal.addEventListener("abort", stopped, { once: true });
        this.connections.on("status", listener);
        // event-driven-allow: transport heartbeat keepalive; ping only live channels, no directory or business reads.
        const timer = setInterval(() => { void this.connections.refreshLatency(ids); if (!response.destroyed) response.write(": keepalive\n\n"); }, 15_000);
        const cleanup = () => { clearInterval(timer); this.connections.removeListener("status", listener); this.connections.removeListener("selection", selection); this.controller.signal.removeEventListener("abort", stopped); };
        response.once("close", cleanup); return;
      }
      if (action === "selection" && request.method === "GET") { send(200, { selectedDeviceId: this.selected() }); return; }
      if (action === "identity" && request.method === "GET") { const { privateKey, ...identity } = this.identity; send(200, identity); return; }
      if (action === "servers" && request.method === "GET") { send(200, await this.directory()); return; }
      if (action === "probe" && request.method === "POST") {
        const body = await readJson(request, 8192) as { deviceIds: string[] };
        if (!Array.isArray(body.deviceIds) || body.deviceIds.some(id => typeof id !== "string")) throw new Error("Invalid probe.");
        send(200, await this.probe(body.deviceIds)); return;
      }
      if (action === "selection" && request.method === "PUT") {
        const body = await readJson(request, 8192) as { deviceId: string };
        if (typeof body.deviceId !== "string") throw new Error("Invalid selection."); await this.select(body.deviceId); send(200, { selectedDeviceId: body.deviceId }); return;
      }
      const match = action.match(/^http\/([^/]+)\/([^/]+)(\/.*)$/);
      if (match) { await proxyTunnel(await this.session(decodeURIComponent(match[1])), decodeURIComponent(match[2]), match[3] + url.search, request, response); return; }
      send(405, { error: "Method not allowed." });
    };
    void run().catch(error => send(error instanceof TunnelDenied ? 403 : 502, { error: error instanceof TunnelDenied ? error.message : "远端连接失败，请检查设备版本、授权与网络。" }));
    return true;
  }
  stop() { this.lanBrowser?.stop(); this.lanPublication?.stop(); this.bonjour?.destroy(); this.controller.abort(); this.connections.stop(); this.rtc.stop(); for (const session of this.incoming) session.close(); this.incoming.clear(); this.websocket.close(); }
}
