import { getTimeoutMs } from "../shared/timeoutSettings.js";
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
import { proxyTunnel, proxyTunnelUpgrade, peerProxyRequestHeaders, serveTunnel, tunnelFetch, type TunnelService } from "./http.js";
import type { DiscoveredRabiPeer } from "../rabiPeerDiscovery.js";
import type { PeerCall } from "../rabiPeerClient.js";
import { PERSONA_PEER_SERVICE, PERSONA_REFERENCE_CAPABILITY, personaPeerRequestAllowed } from "../shared/personaPeerService.js";
import { issueInternalManagerHopHeaders } from "../shared/internalManagerHop.js";
import type { ApiUpgradeInput, ApiHttpProxyInput } from "../manager/apiOperationContract.js";
import { openPeerEvents, PEER_EVENT_LIMITS } from "./events.js";

type Config = { selectedDeviceId: string; trustedDevices: TunnelGrant[]; services: Record<string, TunnelService> };
export const APPLICATION_ACCESS_CAPABILITY = "rabilink-application-access-v1";
export const APPLICATION_BOOTSTRAP_DOMAIN = "rabi-application-bootstrap-v1";
export const DEVICE_DELEGATION_DOMAIN = "rabi-device-delegation-v1";
export type DeviceConnectionAuthority = { sourceDeviceId: string; scope: string; issuedAt: number; assertCurrent(): void };
type DeviceGrant = TunnelGrant & { kind: "device"; epoch: string; expiresAt: number; proofExpiresAt: number; nonce: string; timer: ReturnType<typeof setTimeout> };
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
  private readonly deviceGrants = new Map<string, DeviceGrant>();
  private readonly pending = new Set<Promise<unknown>>();
  private retirement?: Promise<void>;
  readonly identity;
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
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
    this.identity = loadTunnelIdentity(path.join(options.dataDir, "tunnel-identity.json"), options.deviceId, options.generation, { persist: !options.readOnly });
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
  private grant(id: string): TunnelGrant & { epoch?: string } {
    if (id.startsWith("glasses-")) {
      const device = this.deviceGrants.get(id);
      if (!device || device.expiresAt <= Date.now() || !this.applicationConnectionAllowed() || device.bootstrapScope !== this.bootstrapScope()) throw new TunnelDenied("peer_device_authority_expired");
      return device;
    }
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
  async grantDeviceConnection(input: unknown, authority: DeviceConnectionAuthority) {
    const value = input as { source?: string; publicKey?: string; target?: string; expiresAt?: number; nonce?: string; signature?: string };
    const assertCurrent = () => {
      authority.assertCurrent();
      if (!this.applicationConnectionAllowed() || authority.scope !== this.bootstrapScope()
        || !/^glasses-[a-f0-9]{16}$/.test(authority.sourceDeviceId)
        || !Number.isSafeInteger(authority.issuedAt) || authority.issuedAt > Date.now()
        || Date.now() >= authority.issuedAt + 45_000) throw new TunnelDenied("peer_device_authority_expired");
    };
    assertCurrent();
    if (!value || value.source !== authority.sourceDeviceId || value.target !== this.identity.deviceId
      || !isTunnelPublicKey(value.publicKey) || !Number.isSafeInteger(value.expiresAt)
      || value.expiresAt! <= Date.now() || value.expiresAt! > authority.issuedAt + 45_000
      || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.nonce)
      || typeof value.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)) throw new TunnelDenied("peer_device_bootstrap_denied");
    const fields = { source: value.source, publicKey: value.publicKey, target: value.target, expiresAt: value.expiresAt, nonce: value.nonce };
    if (!verify(null, Buffer.from(DEVICE_DELEGATION_DOMAIN + JSON.stringify(fields)), value.publicKey, Buffer.from(value.signature, "base64"))) throw new TunnelDenied("peer_signature_denied");
    assertCurrent();
    const prior = this.deviceGrants.get(value.source);
    if (prior?.nonce === value.nonce && (prior.publicKey !== value.publicKey || prior.proofExpiresAt !== value.expiresAt)) throw new TunnelDenied("peer_device_bootstrap_denied");
    const sameLease = prior && prior.publicKey === value.publicKey && prior.expiresAt > Date.now() && prior.bootstrapScope === authority.scope;
    const epoch = sameLease ? prior.epoch : randomUUID();
    // Replaying an earlier signed renewal cannot reduce or extend a newer lease.
    const expiresAt = sameLease ? Math.max(prior.expiresAt, value.expiresAt!) : value.expiresAt!;
    if (prior) clearTimeout(prior.timer);
    if (!sameLease) for (const session of this.incoming) if (session.remote.deviceId === value.source) session.close();
    if (!prior) {
      for (const [id, stale] of this.deviceGrants) if (stale.expiresAt <= Date.now()) {
        clearTimeout(stale.timer); this.deviceGrants.delete(id);
      }
      if (this.deviceGrants.size >= 512) throw new TunnelDenied("peer_device_capacity_exceeded");
    }
    const timer = setTimeout(() => {
      const current = this.deviceGrants.get(value.source!);
      if (current?.epoch === epoch && current.expiresAt <= Date.now()) {
        for (const session of this.incoming) if (session.remote.deviceId === value.source) session.close();
        this.deviceGrants.delete(value.source!);
      }
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
    this.deviceGrants.set(value.source, { kind: "device", deviceId: value.source, publicKey: value.publicKey,
      services: [], bootstrapScope: authority.scope, epoch, expiresAt, proofExpiresAt: value.expiresAt!, nonce: value.nonce, timer });
    return { sourceDeviceId: value.source, deviceId: this.identity.deviceId, publicKey: this.identity.publicKey,
      generation: this.identity.generation, managerGeneration: this.options.generation, expiresAt, epoch };
  }
  assertControl(request: http.IncomingMessage, url: URL, mutation = false): void {
    if (this.controller.signal.aborted || !this.controlAllowed(request, url)) throw new TunnelDenied("peer_service_denied");
    if (mutation && this.options.readOnly) throw new TunnelDenied("manager_read_only");
  }
  events(ids: string[], assertCurrent: () => void) { return openPeerEvents(this.connections, this.controller.signal, ids, assertCurrent); }
  async select(id: string, assertCurrent?: () => void) {
    assertCurrent?.();
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    if (id) { await this.ensureApplicationConnection(id); assertCurrent?.(); const peer = await this.target(id); assertCurrent?.(); if (!peer.supported) throw new Error("peer_upgrade_required"); }
    assertCurrent?.();
    const config = this.config(); config.selectedDeviceId = id;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 }); renameSync(temp, this.file);
    this.connections.select(id); this.connections.emit("selection", { selectedDeviceId: id }); this.options.onStatus({ selectedDeviceId: id });
  }
  startLanDiscovery(port: number) {
    if (this.options.readOnly || this.bonjour || !Number.isInteger(port) || port < 1) return;
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
  async probe(ids: string[], assertCurrent?: () => void) {
    assertCurrent?.();
    if (ids.length > PEER_EVENT_LIMITS.ids) throw new Error("At most ten visible peers may be probed.");
    await Promise.all(ids.map(async id => { assertCurrent?.(); try { await this.session(id, true); } catch { assertCurrent?.(); /* Status remains visible in the directory. */ } assertCurrent?.(); }));
    assertCurrent?.();
    return this.directory();
  }
  /** Authenticate the current application once before using any offered service. */
  async ensureApplicationConnection(id: string): Promise<void> {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    if (!this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
    // A delegated Eye lease is already authenticated; it must never use application TOFU.
    if (id.startsWith("glasses-")) { this.grant(id); return; }
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
    const reply = await this.options.signal({ targetDeviceId: id, capability: "transport", operation: "tunnel", input }, AbortSignal.any([this.controller.signal, AbortSignal.timeout(getTimeoutMs("peer.signal", 20_000))])) as { deviceId?: string; publicKey?: string; generation?: string };
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
  async proxySelected(request: http.IncomingMessage, url: URL, response: http.ServerResponse, authorize?: () => void) {
    authorize?.();
    const selected = this.selected();
    if (!selected) throw new Error("No remote server selected.");
    const session = await this.session(selected);
    authorize?.();
    await proxyTunnel(session, "manager", url.pathname + url.search, request, response, authorize);
    authorize?.();
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
    let grant: TunnelGrant & { epoch?: string }; try { grant = this.grant(source); } catch { channel.close(); return; }
    const sessionScope = this.bootstrapScope();
    const sessionEpoch = grant.epoch;
    this.accepting++;
    void this.track(establishTunnel(channel, this.identity, grant, false, AbortSignal.any([this.controller.signal, AbortSignal.timeout(getTimeoutMs("peer.handshake", 5_000))]))
      .then(async session => {
        const assertSessionCurrent = () => {
          const current = this.grant(source);
          if (session.closed || current.publicKey !== session.remote.publicKey || current.bootstrapScope !== sessionScope || current.epoch !== sessionEpoch) throw new TunnelDenied("peer_service_denied");
        };
        try { assertSessionCurrent(); } catch (error) { await session.close(); throw error; }
        this.incoming.add(session); session.once("close", () => { void this.track(session.close()).then(() => this.incoming.delete(session), () => undefined); });
        serveTunnel(session, () => {
          const builtIn = this.options.services();
          const services = { ...builtIn, ...this.config().services };
          const internalHeaders = (method: string, target: string) => issueInternalManagerHopHeaders({
            kind: "peer", generation: this.options.generation, scope: sessionScope,
            deviceId: session.remote.deviceId, method, target
          }, assertSessionCurrent);
          // Only the application may choose the Manager owner or attest a remote device.
          // serveTunnel strips caller identity headers before adding these owned headers.
          if (builtIn.manager) {
            const headers = { ...builtIn.manager.headers, "x-rabilink-tunnel-device-id": session.remote.deviceId };
            services.manager = { ...builtIn.manager, headers, internalHeaders };
            services[PERSONA_PEER_SERVICE] = { baseUrl: builtIn.manager.baseUrl, headers, internalHeaders, requestAllowed: personaPeerRequestAllowed };
          } else {
            delete services.manager;
            delete services[PERSONA_PEER_SERVICE];
          }
          if (builtIn.resources) services.resources = { ...builtIn.resources, internalHeaders,
            headers: { ...builtIn.resources.headers, "x-rabilink-resource-owner": source } };
          else delete services.resources;
          return services;
        }, service => {
          assertSessionCurrent(); return true;
        });
      }).catch(() => channel.close()).finally(() => this.accepting--));
  }
  async offer(input: unknown): Promise<unknown> {
    if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
    // This entry is owned by the application-authenticated encrypted signal dispatcher.
    // Eye owner identities require the separate, current device-credential lease.
    const bootstrap = input as { kind?: string; source?: string; publicKey?: string; target?: string; expiresAt?: number; signature?: string };
    if (bootstrap?.kind === "bootstrap-application") {
      if (!this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
      if (typeof bootstrap.source === "string" && bootstrap.source.startsWith("glasses-")) throw new TunnelDenied("peer_device_bootstrap_required");
      if (typeof bootstrap.source !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bootstrap.source)
          || bootstrap.target !== this.identity.deviceId || typeof bootstrap.publicKey !== "string" || bootstrap.publicKey.length > 2048
          || !Number.isFinite(bootstrap.expiresAt) || bootstrap.expiresAt! < Date.now() || bootstrap.expiresAt! > Date.now() + 60_000)
        throw new TunnelDenied("peer_bootstrap_denied");
      const fields = { source: bootstrap.source, publicKey: bootstrap.publicKey, target: bootstrap.target, expiresAt: bootstrap.expiresAt };
      if (!isTunnelPublicKey(bootstrap.publicKey) || !verify(null, Buffer.from(APPLICATION_BOOTSTRAP_DOMAIN + JSON.stringify(fields)), bootstrap.publicKey, Buffer.from(bootstrap.signature || "", "base64")))
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
    if (typeof bootstrap?.kind === "string" && bootstrap.kind.startsWith("bootstrap-")) throw new TunnelDenied("peer_bootstrap_kind_denied");
    const value = input as { source?: string; kind?: string; sdp?: string; room?: string };
    if (!value || typeof value.source !== "string") throw new TunnelDenied("peer_source_required");
    this.grant(value.source);
    if (this.accepting + this.incoming.size >= 8) throw new Error("Tunnel connection limit reached.");
    if (value.kind === "p2p") return this.rtc.offer(value.sdp, channel => this.accept(channel, value.source!));
    if (value.kind === "relay" && typeof value.room === "string" && /^[a-f0-9-]{36}$/.test(value.room)) {
      const endpoint = this.relayUrl(value.room);
      const channel = await connectWebsocket(endpoint.url, endpoint.headers, AbortSignal.any([this.controller.signal, AbortSignal.timeout(getTimeoutMs("peer.handshake", 5_000))]));
      this.accept(channel, value.source); return { ready: true };
    }
    throw new Error("Invalid tunnel offer.");
  }
  async openProxyHttp(input: ApiHttpProxyInput): Promise<void> {
    const { request, url, response, path } = input;
    const pathname = "/" + path.path + url.search;
    const authorize = () => {
      input.assertCurrent();
      if (this.options.readOnly) throw new TunnelDenied("manager_read_only");
      if (!this.controlAllowed(request, url) || !this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
    };
    authorize();
    if (path.service === PERSONA_PEER_SERVICE && !personaPeerRequestAllowed({ method: request.method || "GET", path: pathname })) throw new TunnelDenied("peer_service_denied");
    const requestHeaders = peerProxyRequestHeaders(request.headers);
    const session = await this.session(path.deviceId!);
    authorize();
    await proxyTunnel(session, path.service!, pathname, request, response, authorize, { ...input, requestHeaders });
  }
  async openProxyUpgrade(input: ApiUpgradeInput): Promise<void> {
    const { request, url, socket } = input;
    if (this.options.readOnly || !this.controlAllowed(request, url)) { socket.destroy(); return; }
    const authorize = () => {
      input.assertCurrent();
      if (this.options.readOnly || !this.controlAllowed(request, url) || !this.applicationConnectionAllowed()) throw new TunnelDenied("peer_service_denied");
    };
    authorize();
    const requestHeaders = peerProxyRequestHeaders(request.headers);
    const session = await this.session(input.path.deviceId!);
    authorize();
    await proxyTunnelUpgrade(session, input.path.service!, "/" + input.path.path + url.search, request, socket, Buffer.from(input.head), authorize, { ...input, requestHeaders });
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
      if (signal.aborted || !this.applicationConnectionAllowed() || scope !== this.bootstrapScope()) { await session.close(); throw new Error("Tunnel attempt cancelled."); }
      this.sessionScopes.set(session, scope); return session;
    };
    if (transport === "lan") {
      const controllers = peer.peerUrls.slice(0, 4).map(() => new AbortController());
      const attempts = peer.peerUrls.slice(0, 4).map(async (raw, index) => {
          const url = new URL(raw); const parts = url.hostname.split(".").map(Number); const [a,b] = parts;
          if (url.protocol !== "http:" || url.username || url.password || parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
            || !(a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) throw new Error("Invalid LAN candidate.");
          url.protocol = "ws:"; url.pathname = "/api/rabilink/peer/tunnel/socket"; url.search = new URLSearchParams({ source: this.identity.deviceId }).toString();
          const attempt = AbortSignal.any([signal, controllers[index].signal]);
          const channel = await connectWebsocket(url.toString(), {}, attempt);
          const session = await establishTunnel(channel, this.identity, grant, true, attempt);
          if (attempt.aborted || !this.applicationConnectionAllowed() || scope !== this.bootstrapScope()) { await session.close(); throw new Error("Candidate cancelled."); }
          this.sessionScopes.set(session, scope);
          return { session, index };
        });
      try {
        const winner = await Promise.any(attempts);
        controllers.forEach((controller, index) => { if (index !== winner.index) controller.abort(); });
        const settled = await Promise.allSettled(attempts);
        await Promise.all(settled.flatMap((result, index) => result.status === "fulfilled" && index !== winner.index ? [result.value.session.close()] : []));
        return winner.session;
      } catch (error) {
        controllers.forEach(controller => controller.abort());
        const settled = await Promise.allSettled(attempts);
        await Promise.allSettled(settled.flatMap(result => result.status === "fulfilled" ? [result.value.session.close()] : []));
        throw error;
      }
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
  stop(): Promise<void> {
    if (this.retirement) return this.retirement;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.retirement = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const errors: unknown[] = [];
    const attempt = (action: () => void) => { try { action(); } catch (error) { errors.push(error); } };
    for (const grant of this.deviceGrants.values()) clearTimeout(grant.timer);
    this.deviceGrants.clear(); this.controller.abort();
    attempt(() => this.lanBrowser?.stop()); attempt(() => this.lanPublication?.stop()); attempt(() => this.bonjour?.destroy());
    const closures = [...this.incoming].map(session => Promise.resolve().then(() => session.close()));
    attempt(() => this.websocket.close());
    void (async () => {
      const cleanup = Promise.allSettled([
        Promise.resolve().then(() => this.connections.stop()), Promise.resolve().then(() => this.rtc.stop()), ...closures
      ]);
      await Promise.allSettled([
        ...(this.directoryFlight ? [this.directoryFlight] : []), ...this.applicationBootstrapFlights.values()
      ]);
      for (const result of await cleanup) if (result.status === "rejected") errors.push(result.reason);
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      this.incoming.clear();
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Peer transport cleanup failed.");
    })().then(resolve, reject);
    return this.retirement;
  }
}
