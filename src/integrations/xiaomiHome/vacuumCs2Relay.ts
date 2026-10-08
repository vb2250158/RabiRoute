import dgram, { type RemoteInfo } from "node:dgram";
import { isIP } from "node:net";

type Endpoint = { address: string; port: number };
type Packet = { type: number; payload: Buffer; from: Endpoint };
export type Cs2RelayOffer = { peer: string; servers: string[] };
const codes = { list: 0x67, relayTo: 0x82, register: 0x83, hello: 0x70, helloAck: 0x71, port: 0x72, portAck: 0x73, join: 0x80, ready: 0x84, setup: 0x28 };
const initTable = Buffer.from("4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df", "hex");
export class Cs2RelayError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function publicRelayAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
}
export function peerBlock(peer: string): Buffer {
  const match = /^([A-Za-z0-9]{1,8})-(\d{1,10})-([A-Za-z0-9]{1,8})$/.exec(peer);
  if (!match || Number(match[2]) > 0xffffffff) throw new Cs2RelayError("camera_relay_parameters_invalid");
  const out = Buffer.alloc(20); out.write(match[1]!, 0, "ascii"); out.writeUInt32BE(Number(match[2]), 8); out.write(match[3]!, 12, "ascii"); return out;
}
/** Protocol facts from micam's CS2 init-string and wire-format documentation; no login code is reused. */
export function cs2RelayOffer(peer: unknown, init: unknown): Cs2RelayOffer | undefined {
  if (peer === undefined && init === undefined) return;
  if (typeof peer !== "string" || typeof init !== "string" || init.length > 1024) throw new Cs2RelayError("camera_relay_parameters_invalid");
  peerBlock(peer);
  const encoded = init.split(":")[0]!;
  if (!/^(?:[A-P]{2}){1,256}$/.test(encoded)) throw new Cs2RelayError("camera_relay_parameters_invalid");
  let running = 57, decoded = "";
  for (let i = 0; i < encoded.length / 2; i++) {
    const value = ((encoded.charCodeAt(2 * i) - 65) << 4 | encoded.charCodeAt(2 * i + 1) - 65) ^ running ^ initTable[i % initTable.length]!;
    decoded += String.fromCharCode(value); running ^= value;
  }
  const servers = [...new Set(decoded.split(",").filter(Boolean))];
  if (!servers.length || servers.length > 8 || servers.some(address => !publicRelayAddress(address))) throw new Cs2RelayError("camera_relay_parameters_invalid");
  return { peer, servers };
}
export function cs2Frame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + payload.length); out[0] = 0xf1; out[1] = type; out.writeUInt16BE(payload.length, 2); payload.copy(out, 4); return out;
}
function packet(bytes: Buffer, from: RemoteInfo): Packet | undefined {
  if (bytes.length < 4 || bytes.length > 4096 || bytes[0] !== 0xf1 || bytes.readUInt16BE(2) !== bytes.length - 4) return;
  return { type: bytes[1]!, payload: bytes.subarray(4), from: { address: from.address, port: from.port } };
}
export function addressBlock(endpoint: Endpoint): Buffer {
  const out = Buffer.alloc(16); out.writeUInt16BE(2); out.writeUInt16LE(endpoint.port, 2);
  endpoint.address.split(".").map(Number).reverse().forEach((value, i) => out[4 + i] = value); return out;
}
function decodeAddress(bytes: Buffer): Endpoint | undefined {
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 2 || bytes.subarray(8, 16).some(value => value !== 0)) return;
  const address = [...bytes.subarray(4, 8)].reverse().join("."), port = bytes.readUInt16LE(2);
  return port && publicRelayAddress(address) ? { address, port } : undefined;
}
const sameEndpoint = (a: Endpoint, b: Endpoint) => a.address === b.address && a.port === b.port;
/** RLY_PORT_ACK has a six-byte prefix; observed wire vectors also include a two-byte trailer. */
export function cs2SessionAllocation(payload: Buffer): { token: Buffer; port: number } | undefined {
  if (payload.length < 6 || payload.length > 4092) return;
  const port = payload.readUInt16BE(4);
  return port ? { token: Buffer.from(payload.subarray(0, 4)), port } : undefined;
}

/** A session-scoped UDP bridge. MISS authentication/encryption remains in the pinned native transport. */
export class VacuumCs2Relay {
  private readonly remote: dgram.Socket;
  private readonly local: dgram.Socket;
  private readonly uid: Buffer;
  private inbox: Packet[] = [];
  private wake?: () => void;
  private relay?: Endpoint;
  private localPeer=false;
  private client?: Endpoint;
  private closed = false;
  private deadline = 0;
  private localAddress = "0.0.0.0";
  private removeAbort?: () => void;
  constructor(private readonly offer: Cs2RelayOffer, socketFactory: () => dgram.Socket = () => dgram.createSocket("udp4")) {
    this.uid = peerBlock(offer.peer);
    if (!offer.servers.length || offer.servers.length > 8 || offer.servers.some(address => !publicRelayAddress(address))) throw new Cs2RelayError("camera_relay_parameters_invalid");
    this.remote = socketFactory(); this.local = socketFactory();
    this.remote.on("error", () => this.close()); this.local.on("error", () => this.close());
    this.remote.on("message", (bytes, from) => this.receive(bytes, from));
    this.local.on("message", (bytes, from) => this.forward(bytes, from));
  }
  private send(to: Endpoint, type: number, payload: Buffer = Buffer.alloc(0)) { if (!this.closed) this.remote.send(cs2Frame(type, payload), to.port, to.address, () => {}); }
  private receive(bytes: Buffer, from: RemoteInfo) {
    if (this.closed) return;
    const value = packet(bytes, from); if (!value) return;
    if (this.relay) {
      if (!sameEndpoint(value.from, this.relay)) return;
      if (value.type === codes.setup) { this.setup(value.payload); return; }
      if (value.type === 0xe0 && !this.client) { this.send(this.relay, 0xe1); return; }
      if (this.client && [0xd0, 0xd1, 0xe0, 0xe1, 0xf0, 0xf1].includes(value.type)) this.local.send(bytes, this.client.port, this.client.address, () => {});
      return;
    }
    if (this.inbox.length < 128) this.inbox.push(value);
    this.wake?.();
  }
  private forward(bytes: Buffer, from: RemoteInfo) {
    if (!this.relay || from.address !== "127.0.0.1") return;
    const value = packet(bytes, from); if (!value || this.client && !sameEndpoint(value.from, this.client)) return;
    if (value.type === 0x30 || value.type === 0x41) {
      this.client ??= value.from;
      this.local.send(cs2Frame(value.type === 0x30 ? 0x41 : 0x42, this.uid), from.port, from.address, () => {}); return;
    }
    if (this.client && [0xd0, 0xd1, 0xe0, 0xe1, 0xf0, 0xf1].includes(value.type)) this.remote.send(bytes, this.relay.port, this.relay.address, () => {});
  }
  private setup(request: Buffer) {
    if (!this.relay || request.length !== 88 || request[0] !== 0xa1 || request[1] !== 1 || !request.subarray(20, 40).equals(this.uid)) return;
    const external = decodeAddress(request.subarray(40, 56)); if (!external) return;
    const reply = Buffer.from(request); reply[1] = 2; reply.set([0xfe, 0xff, 0xff, 0xff], 56);
    for (let i = 0; i < 4; i++) reply[60 + i] = request[7 - i]!;
    reply.set(addressBlock({ address: this.localAddress, port: this.remote.address().port }), 64);
    reply[80] = 2; reply[81] = 0; reply.writeUInt16BE(external.port, 82); reply.set(external.address.split(".").map(Number), 84);
    this.send(this.relay, codes.setup, reply);
  }
  private async next(until: number): Promise<Packet | undefined> {
    while (!this.closed && Date.now() < Math.min(until, this.deadline)) {
      if (this.inbox.length) return this.inbox.shift();
      await new Promise<void>(resolve => { const timer = setTimeout(() => { this.wake = undefined; resolve(); }, Math.min(100, until - Date.now())); this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); }; });
    }
  }
  private async awaitPacket(type: number, from: Endpoint, waitMs: number) {
    const until = Math.min(this.deadline, Date.now() + waitMs);
    for (;;) { const value = await this.next(until); if (!value) return; if (value.type === type && sameEndpoint(value.from, from)) return value; }
  }
  /** The cloud-owned LAN peer must return the exact UID before its media endpoint is bridged. */
  async connectLocal(address: string, signal: AbortSignal, timeoutMs = 3000): Promise<string> {
    if(isIP(address)!==4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))throw new Cs2RelayError("camera_relay_parameters_invalid");
    this.deadline=Date.now()+Math.min(3000,Math.max(1,timeoutMs));
    const abort=()=>this.close();signal.addEventListener("abort",abort,{once:true});this.removeAbort=()=>signal.removeEventListener("abort",abort);
    try{
      if(signal.aborted)throw new Cs2RelayError("camera_relay_cancelled");
      const bind=(socket:dgram.Socket,host:string)=>new Promise<void>((resolve,reject)=>{const failed=()=>reject(new Cs2RelayError("camera_relay_connection_failed"));socket.once("error",failed);socket.once("close",failed);socket.bind(0,host,()=>{socket.off("error",failed);socket.off("close",failed);resolve();});});
      await Promise.all([bind(this.remote,"0.0.0.0"),bind(this.local,"127.0.0.1")]);
      let punch:Packet|undefined;
      while(!punch && !this.closed && Date.now()<this.deadline){
        this.send({address,port:32108},0x30);
        const until=Date.now()+400;
        for(;;){const p=await this.next(until);if(!p)break;if(p.type===0x41 && p.from.address===address && p.payload.equals(this.uid)){punch=p;break;}}
      }
      if(!punch)throw new Cs2RelayError("camera_relay_discovery_timeout");
      let ready:Packet|undefined;
      while(!ready && !this.closed && Date.now()<this.deadline){
        this.send(punch.from,0x41,punch.payload);
        const until=Date.now()+400;
        for(;;){const p=await this.next(until);if(!p)break;if(p.type===0x42 && p.from.address===address && p.payload.equals(this.uid)){ready=p;break;}}
      }
      if(!ready)throw new Cs2RelayError("camera_relay_device_join_timeout");
      this.relay=ready.from;this.localPeer=true;this.inbox=[];return `127.0.0.1:${this.local.address().port}`;
    }catch(error){this.close();throw error instanceof Cs2RelayError?error:new Cs2RelayError("camera_relay_connection_failed");}
  }
  async connect(signal: AbortSignal, timeoutMs = 30000): Promise<string> {
    this.deadline = Date.now() + Math.min(30000, Math.max(1, timeoutMs));
    const abort = () => this.close(); signal.addEventListener("abort", abort, { once: true });
    this.removeAbort = () => signal.removeEventListener("abort", abort);
    try {
      if (signal.aborted) throw new Cs2RelayError("camera_relay_cancelled");
      const bind = (socket: dgram.Socket, address: string) => new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Cs2RelayError("camera_relay_connection_failed"));
        socket.once("error", failed); socket.once("close", failed);
        socket.bind(0, address, () => { socket.off("error", failed); socket.off("close", failed); resolve(); });
      });
      await Promise.all([bind(this.remote, "0.0.0.0"), bind(this.local, "127.0.0.1")]);
      // UDP connect selects the outbound interface without sending a datagram or modifying OS routes.
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Cs2RelayError("camera_relay_connection_failed"));
        this.remote.once("error", failed); this.remote.once("close", failed);
        this.remote.connect(32100, this.offer.servers[0]!, () => {
          this.remote.off("error", failed); this.remote.off("close", failed);
          this.localAddress = this.remote.address().address; this.remote.disconnect(); resolve();
        });
      });
      const servers = this.offer.servers.map(address => ({ address, port: 32100 }));
      const candidates = new Map<string, { endpoint: Endpoint; tokens: Buffer[] }>();
      const collectCandidate = (value: Packet) => {
        if (value.type !== codes.relayTo || !servers.some(server => sameEndpoint(server, value.from)) || value.payload.length !== 20) return;
        const endpoint = decodeAddress(value.payload); if (!endpoint || endpoint.port !== 25000 || candidates.size >= 8 && !candidates.has(endpoint.address)) return;
        const key = endpoint.address, candidate = candidates.get(key) || { endpoint, tokens: [] };
        const token = Buffer.from(value.payload.subarray(16));
        if (candidate.tokens.length < 8 && !candidate.tokens.some(old => old.equals(token))) candidate.tokens.push(token);
        candidates.set(key, candidate);
      };
      let chosen: Endpoint | undefined;
      let discovered = false;
      // Reacquire rendezvous tokens after a failed registration round. Late LIST
      // replies also remain useful during registration; dropping them pins stale tokens.
      for (let round = 0; round < 3 && !chosen && !this.closed && Date.now() < this.deadline; round++) {
        candidates.clear();
        for (const server of servers) this.send(server, codes.list, this.uid);
        const until = Date.now() + 2500;
        for (;;) { const value = await this.next(until); if (!value) break; collectCandidate(value); }
        discovered ||= candidates.size > 0;
        for (let attempt = 0; attempt < 4 && !chosen && !this.closed && Date.now() < this.deadline; attempt++) {
          for (const { endpoint, tokens } of candidates.values()) {
            for (const token of tokens) for (let repeat = 0; repeat < 4; repeat++) this.send(endpoint, codes.register, Buffer.concat([token, this.uid, Buffer.alloc(4)]));
            this.send(endpoint, codes.hello);
          }
          const slice = Date.now() + (candidates.size ? 1500 : 100);
          for (;;) {
            const value = await this.next(slice); if (!value) break;
            collectCandidate(value);
            if (value.type === codes.helloAck && [...candidates.values()].some(c => sameEndpoint(c.endpoint, value.from))) { chosen = value.from; break; }
          }
        }
      }
      if (!chosen) throw new Cs2RelayError(discovered ? "camera_relay_registration_timeout" : "camera_relay_discovery_timeout");
      let allocation: ReturnType<typeof cs2SessionAllocation>;
      for (let attempt = 0; attempt < 4 && !allocation && !this.closed; attempt++) { this.send(chosen, codes.port); const value = await this.awaitPacket(codes.portAck, chosen, 1500); if (value) allocation = cs2SessionAllocation(value.payload); }
      if (!allocation) throw new Cs2RelayError("camera_relay_allocation_timeout");
      const sessionRelay = { address: chosen.address, port: allocation.port }, token = allocation.token;
      let joined = false;
      for (let attempt = 0; attempt < 6 && !joined && !this.closed; attempt++) {
        const request = Buffer.concat([this.uid, addressBlock(sessionRelay), token]);
        for (const server of servers) this.send(server, codes.join, request);
        for (let repeat = 0; repeat < 24; repeat++) this.send(sessionRelay, codes.register, Buffer.concat([token, this.uid, Buffer.alloc(4)]));
        joined = Boolean(await this.awaitPacket(codes.ready, sessionRelay, 1500));
      }
      if (!joined) throw new Cs2RelayError("camera_relay_device_join_timeout");
      this.relay = sessionRelay; this.inbox = [];
      return `127.0.0.1:${this.local.address().port}`;
    } catch (error) { this.close(); throw error instanceof Cs2RelayError ? error : new Cs2RelayError("camera_relay_connection_failed"); }
    finally { if (this.closed) this.removeAbort?.(); }
  }
  close() {
    if (this.closed) return; this.closed = true;
    this.removeAbort?.(); this.removeAbort = undefined;
    if (this.relay) this.remote.send(cs2Frame(this.localPeer?0xf1:0xf0), this.relay.port, this.relay.address, () => {});
    this.wake?.(); this.wake = undefined; this.inbox = [];
    for (const socket of [this.remote, this.local]) { try { socket.close(); } catch {} }
  }
}
