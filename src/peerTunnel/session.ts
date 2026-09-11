import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { TunnelChannel } from "./channel.js";
import { createTunnelHandshake, type TunnelGrant, type TunnelHello, type TunnelIdentity } from "./security.js";

export type TunnelRequest = { service: string; method: string; path: string; headers: Record<string, string | string[]>; upgrade?: boolean };
export type TunnelHead = { status: number; headers: Record<string, string | string[]> };
type Frame = { type: string; id: string; request?: TunnelRequest; head?: TunnelHead; data?: string; bytes?: number };
const windowBytes = 65_536;
export class TunnelStream extends Duplex {
  readonly response: Promise<TunnelHead>;
  private resolveHead!: (head: TunnelHead) => void;
  private rejectHead!: (error: Error) => void;
  private credit = windowBytes;
  private uncredited = 0;
  private wake?: () => void;
  constructor(readonly id: string, private readonly session: TunnelSession) {
    super({ highWaterMark: windowBytes, allowHalfOpen: true });
    this.response = new Promise((resolve, reject) => { this.resolveHead = resolve; this.rejectHead = reject; });
    void this.response.catch(() => {});
    // Stream errors are returned through response/pipe; never crash the Manager.
    this.on("error", () => {});
  }
  head(value: TunnelHead) { this.resolveHead(value); }
  async reply(head: TunnelHead) { await this.session.send({ type: "head", id: this.id, head }); }
  override _read() {
    if (this.uncredited) { void this.session.send({ type: "window", id: this.id, bytes: this.uncredited }); this.uncredited = 0; }
  }
  receive(bytes: Buffer) {
    if (bytes.length > 12_000 || this.readableLength + bytes.length > windowBytes + 12_000) throw new Error("Tunnel receive window exceeded.");
    if (this.push(bytes)) void this.session.send({ type: "window", id: this.id, bytes: bytes.length });
    else this.uncredited += bytes.length;
  }
  replenish(bytes: number) {
    if (!Number.isInteger(bytes) || bytes < 1 || this.credit + bytes > windowBytes) throw new Error("Invalid tunnel credit.");
    this.credit += bytes; this.wake?.(); this.wake = undefined;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const run = async () => {
      for (let offset = 0; offset < chunk.length;) {
        while (!this.credit && !this.destroyed) await new Promise<void>(resolve => { this.wake = resolve; });
        if (this.destroyed) throw new Error("Tunnel request cancelled.");
        const length = Math.min(12_000, this.credit, chunk.length - offset);
        this.credit -= length;
        await this.session.send({ type: "data", id: this.id, data: chunk.subarray(offset, offset + length).toString("base64") });
        offset += length;
      }
    };
    void run().then(() => callback(), error => callback(error));
  }
  override _final(callback: (error?: Error | null) => void) { void this.session.send({ type: "end", id: this.id }).then(() => callback(), callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.rejectHead(error || new Error("Tunnel request closed.")); this.wake?.(); this.wake = undefined;
    if (this.session.streams.delete(this.id) && (!this.readableEnded || !this.writableFinished)) void this.session.send({ type: "reset", id: this.id });
    callback(error);
  }
}
export class TunnelSession extends EventEmitter {
  readonly streams = new Map<string, TunnelStream>();
  closed = false;
  lastUsedAt = Date.now();
  private pingWaiters = new Map<string, { resolve(value: number): void; reject(error: Error): void; start: number; timer: ReturnType<typeof setTimeout> }>();
  private serial = Promise.resolve();
  constructor(readonly remote: TunnelHello, readonly grant: TunnelGrant, private readonly channel: TunnelChannel,
    private readonly cipher: { encode(value: unknown): Buffer; decode(bytes: Buffer): unknown }, private readonly caller: boolean) {
    super();
    channel.on("data", this.receive);
    channel.once("close", () => this.close());
  }
  send(frame: Frame): Promise<void> {
    if (this.closed) return Promise.resolve();
    const bytes = this.cipher.encode(frame);
    const sent = this.serial.then(() => this.channel.send(bytes));
    this.serial = sent.catch(() => this.close());
    return this.serial;
  }
  private receive = (bytes: Buffer) => {
    try {
      this.lastUsedAt = Date.now(); this.emit("activity");
      const frame = this.cipher.decode(bytes) as Frame;
      if (!frame || typeof frame.id !== "string" || frame.id.length > 80) throw new Error("Invalid tunnel frame.");
      if (frame.type === "ping") { void this.send({ type: "pong", id: frame.id }); return; }
      if (frame.type === "pong") {
        const pending = this.pingWaiters.get(frame.id);
        if (pending) { clearTimeout(pending.timer); this.pingWaiters.delete(frame.id); pending.resolve(performance.now() - pending.start); }
        return;
      }
      if (frame.type === "open") {
        if (this.caller || this.streams.size >= 16 || this.streams.has(frame.id) || !frame.request) throw new Error("Invalid tunnel stream.");
        const stream = new TunnelStream(frame.id, this); this.streams.set(frame.id, stream);
        this.emit("request", stream, frame.request); return;
      }
      const stream = this.streams.get(frame.id);
      if (!stream) return; // Late cancellation acknowledgements are harmless.
      switch (frame.type) {
        case "head": if (!frame.head) throw new Error("Invalid response."); stream.head(frame.head); break;
        case "data": if (typeof frame.data !== "string" || frame.data.length > 16_000) throw new Error("Invalid data."); stream.receive(Buffer.from(frame.data, "base64")); break;
        case "end": stream.push(null); break;
        case "window": stream.replenish(frame.bytes!); break;
        case "reset": this.streams.delete(frame.id); stream.destroy(new Error("Remote request cancelled.")); break;
        default: throw new Error("Unknown tunnel frame.");
      }
    } catch { this.close(); }
  };
  open(request: TunnelRequest): TunnelStream {
    if (this.closed || !this.caller || this.streams.size >= 16) throw new Error("Tunnel unavailable or busy.");
    const stream = new TunnelStream(randomUUID(), this); this.streams.set(stream.id, stream);
    this.lastUsedAt = Date.now(); void this.send({ type: "open", id: stream.id, request }); return stream;
  }
  ping(timeoutMs = 3_000): Promise<number> {
    if (this.closed) return Promise.reject(new Error("Tunnel disconnected."));
    if (this.pingWaiters.size >= 2) return Promise.reject(new Error("Tunnel probe already running."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pingWaiters.delete(id); reject(new Error("Tunnel probe timed out.")); this.close(); }, timeoutMs);
      this.pingWaiters.set(id, { resolve, reject, start: performance.now(), timer }); void this.send({ type: "ping", id });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.channel.removeListener("data", this.receive); this.channel.close();
    for (const value of this.pingWaiters.values()) { clearTimeout(value.timer); value.reject(new Error("Tunnel disconnected.")); }
    this.pingWaiters.clear();
    for (const stream of this.streams.values()) stream.destroy(new Error("Tunnel disconnected; request result may be unknown."));
    this.streams.clear(); this.emit("close");
  }
}
export function establishTunnel(channel: TunnelChannel, identity: TunnelIdentity, grant: TunnelGrant, caller: boolean, signal: AbortSignal): Promise<TunnelSession> {
  return new Promise((resolve, reject) => {
    const handshake = createTunnelHandshake(identity, grant.deviceId);
    const fail = (error: Error) => { cleanup(); channel.close(); reject(error); };
    const abort = () => fail(new Error("Tunnel handshake cancelled."));
    const closed = () => fail(new Error("Tunnel handshake closed."));
    const cleanup = () => { channel.removeListener("data", receive); channel.removeListener("close", closed); signal.removeEventListener("abort", abort); };
    const receive = (bytes: Buffer) => {
      try {
        if (bytes.length > 8_192) throw new Error("Handshake too large.");
        const remote = JSON.parse(bytes.toString()) as TunnelHello;
        const cipher = handshake.accept(remote, grant, caller);
        cleanup(); resolve(new TunnelSession(remote, grant, channel, cipher, caller));
      } catch (error) { fail(error as Error); }
    };
    channel.on("data", receive); channel.once("close", closed);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void channel.send(Buffer.from(JSON.stringify(handshake.hello))).catch(fail);
  });
}
