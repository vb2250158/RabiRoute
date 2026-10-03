import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import { randomUUID, verify, createHash, sign } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { connectWebsocket, websocketChannel, type TunnelChannel } from "./channel.js";
import { isTunnelPublicKey, loadTunnelIdentity, TunnelDenied, type TunnelGrant } from "./security.js";
import { establishTunnel, type TunnelSession } from "./session.js";
import { PeerConnections, type TunnelCandidate } from "./connections.js";
import { TunnelRtc } from "./rtc.js";
import { proxyTunnel, proxyTunnelUpgrade, serveTunnel, tunnelFetch, type TunnelService } from "./http.js";
import type { DiscoveredRabiPeer } from "../rabiPeerDiscovery.js";
import type { PeerCall } from "../rabiPeerClient.js";
import { PERSONA_BOOTSTRAP_DOMAIN, PERSONA_PEER_SERVICE, PERSONA_REFERENCE_CAPABILITY, personaPeerRequestAllowed } from "../shared/personaPeerService.js";

type Config = { selectedDeviceId: string; trustedDevices: TunnelGrant[]; services: Record<string, TunnelService> };
export const APPLICATION_ACCESS_CAPABILITY = "rabilink-application-access-v1";
export const APPLICATION_BOOTSTRAP_DOMAIN = "rabi-application-bootstrap-v1";
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
  private readonly applicationBootstrapFlights = new Map<string, Promise<void>>();
  private readonly applicationBootstrapReady = new Map<string, { scope: string; publicKey: string }>();
  private readonly sessionScopes = new WeakMap<TunnelSession, string>();
  readonly identity;
  constructor(private readonly options: {
    dataDir: string; deviceId: string; generation: string; readOnly?: boolean;
    discover(): Promise<DiscoveredRabiPeer[]>;
    signal(call: PeerCall, signal?: AbortSignal): Promise<unknown>;
    relay(): { url: string; token: string };
    services(): Record<string, TunnelService>;
    onStatus(value: unknown): void;
    allowControl?(request: http.IncomingMessage, url: URL): boolean;
    allowApplicationConnection(): boolean;
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
      if (typeof value.selectedDeviceId !== "string" || !Array.isArray(value.trustedDevices) || value.trustedDevices.some(grant => typeof grant.deviceId !== "string" || typeof grant.publicKey !== "string" || !Array.isArray(grant.services) || grant.services.some(service => typeof service !== "string") || grant.bootstrapScope !== undefined && (typeof grant.bootstrapScope !== "string" || !/^[a-f0-9]{64}$/.test(grant.bootstrapScope)))) throw new Error("Invalid tunnel grants.");
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
    if (!grant) throw new TunnelDenied("peer_device_not_trusted");
    if (!this.applicationConnectionAllowed() || grant.bootstrapScope !== this.bootstrapScope()) throw new TunnelDenied("peer_service_denied");
    return grant;
  }
  private applicationConnectionAllowed(): boolean {
    return !this.options.readOnly && !this.controller.signal.aborted && this.options.allowApplicationConnection()
      && Boolean(this.options.relay().token.trim());
  }
  private bootstrapScope() { const relay=this.options.relay(); return createHash("sha256").update(relay.url.replace(/\/+$/,"")+"\n"+relay.token).digest("hex"); }
  async select(id: string) {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    if (id) { await this.ensureApplicationConnection(id); const peer = await this.target(id); if (!peer.supported) throw new Error("peer_upgrade_required"); }
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
      txt: { protocol: "1", deviceId: this.identity.deviceId, generation: this.identity.generation, personaReference: "1", applicationAccess: "1" } });
    this.lanBrowser = this.bonjour.find({ type: "rabitunnel", protocol: "tcp" });
    this.lanBrowser.on("up", service => {
      const id = String(service.txt?.deviceId || "");
      if (!id || id === this.identity.deviceId || String(service.txt?.protocol) !== "1" || this.lanPeers.size >= 32) return;
      try { this.grant(id); } catch { return; }
      const addresses = (service.addresses || []).filter(value => /^\d+\.\d+\.\d+\.\d+$/.test(value)).slice(0, 4);
      const known = this.peers.find(peer => peer.id === id);
      const peer: DiscoveredRabiPeer = { id, name: known?.name || id, online: true, deviceKind: "pc", capabilities: ["peer-tunnel-v1", ...(String(service.txt?.personaReference) === "1" ? [PERSONA_REFERENCE_CAPABILITY] : []), ...(String(service.txt?.applicationAccess) === "1" ? [APPLICATION_ACCESS_CAPABILITY] : [])], peerUrls: addresses.map(address => "http://" + address + ":" + service.port) };
      this.lanPeers.set(id, peer);
      void this.connections.reconsider(this.candidate(peer));
      this.options.onStatus(this.connections.snapshot(this.candidate(peer)));
    });
    this.lanBrowser.on("down", service => { this.lanPeers.delete(String(service.txt?.deviceId || "")); });
  }
  private mergedPeers() {
    const map = new Map(this.peers.map(peer => [peer.id, peer]));
    for (const [id, peer] of this.lanPeers) {
      const old = map.get(id); map.set(id, { ...peer, name: old?.name || peer.name, capabilities: [...new Set([...peer.capabilities, ...(old?.capabilities || [])])], peerUrls: [...new Set([...peer.peerUrls, ...(old?.peerUrls || [])])].slice(0, 4) });
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
    return { selectedDeviceId: this.selected(), peers: this.mergedPeers().filter(peer => peer.id !== this.identity.deviceId).map(peer => ({ ...this.connections.snapshot(this.candidate(peer)), personaSupported: peer.capabilities.includes(PERSONA_REFERENCE_CAPABILITY) && peer.capabilities.includes(APPLICATION_ACCESS_CAPABILITY) })) };
  }
  private candidate(peer: DiscoveredRabiPeer): TunnelCandidate & DiscoveredRabiPeer {
    let trusted = false; try { this.grant(peer.id); trusted = true; } catch { /* A pin is not a current application connection. */ }
    return { ...peer, supported: peer.capabilities.includes("peer-tunnel-v1") && peer.capabilities.includes(APPLICATION_ACCESS_CAPABILITY), trusted };
  }
  private async target(id: string) {
    await this.directory(); const peer = this.mergedPeers().find(item => item.id === id);
    if (!peer) throw new Error("peer_not_discovered"); return this.candidate(peer);
  }
  async session(id: string, probe = false) {
    await this.ensureApplicationConnection(id);
    const grant = this.grant(id);
    const session = await this.connections.get(await this.target(id), probe);
    if (session.remote.publicKey !== grant.publicKey) { session.close(); throw new TunnelDenied("peer_identity_changed"); }
    if (this.sessionScopes.get(session) !== this.bootstrapScope()) { session.close(); throw new TunnelDenied("peer_service_denied"); }
    return session;
  }
  async probe(ids: string[]) {
    if (ids.length > 10) throw new Error("At most ten visible peers may be probed.");
    await Promise.all(ids.map(async id => { try { await this.session(id, true); } catch { /* Status remains visible in the directory. */ } }));
    return this.directory();
  }
  /** Authenticate the current application once before using any offered service. */
  async ensureApplicationConnection(id: string): Promise<void> {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    if (!this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
    const scope = this.bootstrapScope();
    const prior = this.config().trustedDevices.find(grant => grant.deviceId === id);
    const ready = this.applicationBootstrapReady.get(id);
    if (ready?.scope === scope && ready.publicKey === prior?.publicKey && prior.bootstrapScope === scope) return;
    const pending = this.applicationBootstrapFlights.get(id);
    if (pending) return pending;
    const flight = this.bootstrapApplicationConnection(id, scope);
    this.applicationBootstrapFlights.set(id, flight);
    try { await flight; }
    finally { if (this.applicationBootstrapFlights.get(id) === flight) this.applicationBootstrapFlights.delete(id); }
  }
  private async bootstrapApplicationConnection(id: string, scope: string): Promise<void> {
    const peer = await this.target(id);
    if (!peer.capabilities.includes(APPLICATION_ACCESS_CAPABILITY)) throw new Error("peer_upgrade_required");
    if (!peer.supported) throw new Error("peer_upgrade_required");
    if (!peer.online) throw new Error("peer_device_offline");
    const fields = { source: this.identity.deviceId, publicKey: this.identity.publicKey, target: id, expiresAt: Date.now() + 30_000 };
    const input = { ...fields, kind: "bootstrap-application", signature: sign(null, Buffer.from(APPLICATION_BOOTSTRAP_DOMAIN + JSON.stringify(fields)), this.identity.privateKey).toString("base64") };
    const reply = await this.options.signal({ targetDeviceId: id, capability: "transport", operation: "tunnel", input }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])) as { deviceId?: string; publicKey?: string; generation?: string };
    if (!this.applicationConnectionAllowed() || this.bootstrapScope() !== scope) throw new TunnelDenied("peer_service_denied");
    if (reply?.deviceId !== id || typeof reply.generation !== "string" || !reply.generation.trim() || reply.generation.length > 128
      || !isTunnelPublicKey(reply.publicKey)) throw new TunnelDenied("peer_identity_denied");
    const config = this.config();
    const prior = config.trustedDevices.find(grant => grant.deviceId === id);
    if (prior && prior.publicKey !== reply.publicKey) throw new TunnelDenied("peer_identity_changed");
    if (!prior) config.trustedDevices.push({ deviceId: id, publicKey: reply.publicKey, services: [], bootstrapScope: scope });
    else { prior.bootstrapScope = scope; prior.services = []; }
    this.persist(config);
    this.applicationBootstrapReady.set(id, { scope, publicKey: reply.publicKey });
    this.options.onStatus({ deviceId: id, trusted: true });
  }
  private persist(config: Config): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temporary, this.file);
  }
  async proxySelected(request: http.IncomingMessage, url: URL, response: http.ServerResponse) {
    const selected = this.selected();
    if (!selected) throw new Error("No remote server selected.");
    await proxyTunnel(await this.session(selected), "manager", url.pathname + url.search, request, response);
  }
  fetch(id: string, service: string, pathname: string, init: RequestInit = {}) {
    if (service === PERSONA_PEER_SERVICE && !personaPeerRequestAllowed({ method: init.method || "GET", path: pathname })) return Promise.reject(new TunnelDenied("peer_service_denied"));
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
    const sessionScope = this.bootstrapScope();
    this.accepting++;
    void establishTunnel(channel, this.identity, grant, false, AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]))
      .then(session => {
        this.incoming.add(session); session.once("close", () => this.incoming.delete(session));
        serveTunnel(session, () => {
          const builtIn = this.options.services();
          const services = { ...builtIn, ...this.config().services };
          // The Manager origin and request guard remain owned by the application.
          if (builtIn.manager) services[PERSONA_PEER_SERVICE] = { baseUrl: builtIn.manager.baseUrl, headers: builtIn.manager.headers, requestAllowed: personaPeerRequestAllowed };
          else delete services[PERSONA_PEER_SERVICE];
          if (services.resources) services.resources = { ...services.resources, headers: { ...services.resources.headers, "x-rabilink-resource-owner": source } };
          return services;
        }, service => {
          const current = this.grant(source);
          return current.publicKey === session.remote.publicKey && current.bootstrapScope === sessionScope;
        });
      }).catch(() => channel.close()).finally(() => this.accepting--);
  }
  async offer(input: unknown): Promise<unknown> {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    // This entry is owned by the application-authenticated encrypted signal dispatcher.
    // Legacy mobile bootstrap kinds retain their signatures, with the same application policy.
    const bootstrap = input as { kind?: string; source?: string; publicKey?: string; target?: string; expiresAt?: number; signature?: string };
    if (bootstrap?.kind === "bootstrap-application" || bootstrap?.kind === "bootstrap-speech" || bootstrap?.kind === "bootstrap-resources" || bootstrap?.kind === "bootstrap-persona") {
      const application = bootstrap.kind === "bootstrap-application";
      const resource = bootstrap.kind === "bootstrap-resources";
      const persona = bootstrap.kind === "bootstrap-persona";
      if (!this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
      if (typeof bootstrap.source !== "string" || !((persona || application) ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : /^[A-Za-z0-9_-]{1,120}$/).test(bootstrap.source)
          || bootstrap.target !== this.identity.deviceId || typeof bootstrap.publicKey !== "string" || bootstrap.publicKey.length > 2048
          || !Number.isFinite(bootstrap.expiresAt) || bootstrap.expiresAt! < Date.now() || bootstrap.expiresAt! > Date.now() + 60_000)
        throw new TunnelDenied("peer_bootstrap_denied");
      const fields = { source: bootstrap.source, publicKey: bootstrap.publicKey, target: bootstrap.target, expiresAt: bootstrap.expiresAt };
      if (!isTunnelPublicKey(bootstrap.publicKey) || !verify(null, Buffer.from((application ? APPLICATION_BOOTSTRAP_DOMAIN : persona ? PERSONA_BOOTSTRAP_DOMAIN : resource ? "rabi-resources-bootstrap-v1" : "rabi-speech-bootstrap-v1") + JSON.stringify(fields)), bootstrap.publicKey, Buffer.from(bootstrap.signature || "", "base64")))
        throw new TunnelDenied("peer_signature_denied");
      const config = this.config();
      const prior = config.trustedDevices.find(grant => grant.deviceId === bootstrap.source);
      if (prior && prior.publicKey !== bootstrap.publicKey) throw new TunnelDenied("peer_identity_changed");
      const scope = this.bootstrapScope();
      if (!prior) config.trustedDevices.push({ deviceId: bootstrap.source, publicKey: bootstrap.publicKey, services: [], bootstrapScope: scope });
      else { prior.services = []; prior.bootstrapScope = scope; }
      this.persist(config);
      this.applicationBootstrapReady.set(bootstrap.source, { scope, publicKey: bootstrap.publicKey });
      return { deviceId: this.identity.deviceId, generation: this.identity.generation, publicKey: this.identity.publicKey };
    }
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
    if (decodeURIComponent(match[2]) === PERSONA_PEER_SERVICE) { socket.destroy(); return true; }
    if (this.options.readOnly) { socket.destroy(); return true; }
    if (!this.controlAllowed(request, url)) { socket.destroy(); return true; }
    void this.session(decodeURIComponent(match[1])).then(session => proxyTunnelUpgrade(session, decodeURIComponent(match[2]), match[3] + url.search, request, socket, head)).catch(() => socket.destroy());
    return true;
  }
  upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url || "/", "http://peer.local");
    if (url.pathname !== "/api/rabilink/peer/tunnel/socket") return false;
    const source = url.searchParams.get("source") || "";
    void this.ensureApplicationConnection(source).then(() => {
      this.grant(source);
      if (this.accepting + this.incoming.size >= 8 || socket.destroyed) throw new Error("busy");
      this.websocket.handleUpgrade(request, socket, head, ws => this.accept(websocketChannel(ws), source));
    }).catch(() => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    return true;
  }
  private async connect(peer: TunnelCandidate, transport: "lan" | "p2p" | "relay", signal: AbortSignal): Promise<TunnelSession> {
    await this.ensureApplicationConnection(peer.id);
    const grant = this.grant(peer.id);
    const scope = this.bootstrapScope();
    const establish = async (channel: TunnelChannel) => {
      const session = await establishTunnel(channel, this.identity, grant, true, signal);
      if (signal.aborted || !this.applicationConnectionAllowed() || scope !== this.bootstrapScope()) { session.close(); throw new Error("Tunnel attempt cancelled."); }
      this.sessionScopes.set(session, scope); return session;
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
          if (attempt.aborted || !this.applicationConnectionAllowed() || scope !== this.bootstrapScope()) { session.close(); throw new Error("Candidate cancelled."); }
          this.sessionScopes.set(session, scope);
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
      if (match) {
        const id = decodeURIComponent(match[1]), service = decodeURIComponent(match[2]), pathname = match[3] + url.search;
        if (service === PERSONA_PEER_SERVICE) {
          if (!personaPeerRequestAllowed({ method: request.method || "GET", path: pathname })) throw new TunnelDenied("peer_service_denied");
        }
        await proxyTunnel(await this.session(id), service, pathname, request, response); return;
      }
      send(405, { error: "Method not allowed." });
    };
    void run().catch(error => send(error instanceof TunnelDenied ? 403 : error?.message === "peer_upgrade_required" ? 426 : 502, {
      error: error instanceof TunnelDenied || error?.message === "peer_upgrade_required" ? error.message : "远端连接失败，请检查设备版本、连接与网络。"
    }));
    return true;
  }
  stop() { this.lanBrowser?.stop(); this.lanPublication?.stop(); this.bonjour?.destroy(); this.controller.abort(); this.connections.stop(); this.rtc.stop(); for (const session of this.incoming) session.close(); this.incoming.clear(); this.websocket.close(); }
}
