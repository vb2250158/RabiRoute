import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { TunnelChannel } from "./channel.js";
import { createTunnelHandshake, type TunnelGrant, type TunnelHello, type TunnelIdentity } from "./security.js";

export type TunnelRequest = { service: string; method: string; path: string; headers: Record<string, string | string[]>; upgrade?: boolean };
export type TunnelHead = { status: number; headers: Record<string, string | string[]> };
type Frame = { type: string; id: string; request?: TunnelRequest; head?: TunnelHead; data?: string; bytes?: number };
export const TUNNEL_STREAM_LIMITS = Object.freeze({ dataFrameBytes: 12_000, streamWindowBytes: 65_536, maxConcurrentStreams: 16 });
const windowBytes = TUNNEL_STREAM_LIMITS.streamWindowBytes;
export class TunnelStream extends Duplex {
  readonly response: Promise<TunnelHead>;
  private resolveHead!: (head: TunnelHead) => void;
  private rejectHead!: (error: Error) => void;
  private credit = windowBytes;
  private uncredited = 0;
  private wake?: () => void;
  private pendingWrites?: Set<Promise<void>>;
  constructor(readonly id: string, private readonly session: TunnelSession, private readonly writeAuthority?: () => void) {
    super({ highWaterMark: windowBytes, allowHalfOpen: true });
    this.response = new Promise((resolve, reject) => { this.resolveHead = resolve; this.rejectHead = reject; });
    void this.response.catch(() => {});
    // Stream errors are returned through response/pipe; never crash the Manager.
    this.on("error", () => {});
  }
  head(value: TunnelHead) { this.resolveHead(value); }
  async reply(head: TunnelHead) { await this.session.send({ type: "head", id: this.id, head }); }
  override _read() {
    if (this.uncredited) { void this.session.send({ type: "window", id: this.id, bytes: this.uncredited }).catch(() => {}); this.uncredited = 0; }
  }
  receive(bytes: Buffer) {
    if (bytes.length > TUNNEL_STREAM_LIMITS.dataFrameBytes || this.readableLength + bytes.length > windowBytes + TUNNEL_STREAM_LIMITS.dataFrameBytes) throw new Error("Tunnel receive window exceeded.");
    if (this.push(bytes)) void this.session.send({ type: "window", id: this.id, bytes: bytes.length }).catch(() => {});
    else this.uncredited += bytes.length;
  }
  replenish(bytes: number) {
    if (!Number.isInteger(bytes) || bytes < 1 || this.credit + bytes > windowBytes) throw new Error("Invalid tunnel credit.");
    this.credit += bytes; this.wake?.(); this.wake = undefined;
  }
  private trackWrite(work: Promise<void>): Promise<void> {
    const pending = this.pendingWrites ??= new Set(); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  }
  private assertWriteCurrent(): void {
    if (this.destroyed) throw new Error("Tunnel request cancelled.");
    this.writeAuthority?.();
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const run = async () => {
      for (let offset = 0; offset < chunk.length;) {
        while (!this.credit && !this.destroyed) await new Promise<void>(resolve => { this.wake = resolve; });
        if (this.destroyed) throw new Error("Tunnel request cancelled.");
        const length = Math.min(TUNNEL_STREAM_LIMITS.dataFrameBytes, this.credit, chunk.length - offset);
        this.credit -= length;
        await this.session.send({ type: "data", id: this.id, data: chunk.subarray(offset, offset + length).toString("base64") }, () => this.assertWriteCurrent());
        offset += length;
      }
    };
    void this.trackWrite(run()).then(() => callback(), error => callback(error));
  }
  override _final(callback: (error?: Error | null) => void) { void this.trackWrite(this.session.send({ type: "end", id: this.id }, () => this.assertWriteCurrent())).then(() => callback(), callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.rejectHead(error || new Error("Tunnel request closed.")); this.wake?.(); this.wake = undefined;
    const reset = this.session.streams.delete(this.id) && (!this.readableEnded || !this.writableFinished)
      ? this.session.send({ type: "reset", id: this.id }) : Promise.resolve();
    // Closing a Node stream must also join its accepted asynchronous write and
    // reset callbacks. No late writer may outlive the owning upgrade lease.
    void Promise.allSettled([...(this.pendingWrites ?? []), reset]).then(() => callback(error));
  }
}
export class TunnelSession extends EventEmitter {
  readonly streams = new Map<string, TunnelStream>();
  private pendingRequests: { stream: TunnelStream; request: TunnelRequest }[] = [];
  closed = false;
  lastUsedAt = Date.now();
  private pingWaiters = new Map<string, { resolve(value: number): void; reject(error: Error): void; start: number; timer: ReturnType<typeof setTimeout> }>();
  private serial = Promise.resolve();
  private readonly producers = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(readonly remote: TunnelHello, readonly grant: TunnelGrant, private readonly channel: TunnelChannel,
    private readonly cipher: { encode(value: unknown): Buffer; decode(bytes: Buffer): unknown }, private readonly caller: boolean) {
    super();
    channel.on("data", this.receive);
    channel.once("close", () => this.close());
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "request" && this.pendingRequests.length) {
      const pending = this.pendingRequests; this.pendingRequests = [];
      queueMicrotask(() => {
        if (!this.closed) for (const item of pending) if (!item.stream.destroyed) this.emit("request", item.stream, item.request);
      });
    }
    return this;
  }
  send(frame: Frame, authorize?: () => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Tunnel disconnected; request result may be unknown."));
    let authorityRejected = false;
    const sent = this.serial.then(() => {
      if (this.closed) throw new Error("Tunnel disconnected; request result may be unknown.");
      try { authorize?.(); } catch (error) { authorityRejected = true; throw error; }
      // Encode only after dispatch admission. A rejected request must not spend
      // a cipher sequence or destroy the shared connection used by other calls.
      return this.channel.send(this.cipher.encode(frame));
    });
    this.serial = sent.catch(() => { if (!authorityRejected) this.close(); });
    return sent;
  }
  /** Includes actual native producer cleanup in the owning session's retirement. */
  trackProducer(work: Promise<unknown>): void {
    this.producers.add(work);
    void work.then(() => this.producers.delete(work), () => this.producers.delete(work));
  }
  private receive = (bytes: Buffer) => {
    try {
      this.lastUsedAt = Date.now(); this.emit("activity");
      const frame = this.cipher.decode(bytes) as Frame;
      if (!frame || typeof frame.id !== "string" || frame.id.length > 80) throw new Error("Invalid tunnel frame.");
      if (frame.type === "ping") { void this.send({ type: "pong", id: frame.id }).catch(() => {}); return; }
      if (frame.type === "pong") {
        const pending = this.pingWaiters.get(frame.id);
        if (pending) { clearTimeout(pending.timer); this.pingWaiters.delete(frame.id); pending.resolve(performance.now() - pending.start); }
        return;
      }
      if (frame.type === "open") {
        if (this.caller || this.streams.size >= TUNNEL_STREAM_LIMITS.maxConcurrentStreams || this.streams.has(frame.id) || !frame.request) throw new Error("Invalid tunnel stream.");
        const stream = new TunnelStream(frame.id, this); this.streams.set(frame.id, stream);
        // A WebSocket can deliver Hello and open in one turn before its owner's
        // establishTunnel.then installs serveTunnel. The stream limit bounds this queue.
        if (this.listenerCount("request")) this.emit("request", stream, frame.request);
        else this.pendingRequests.push({ stream, request: frame.request });
        return;
      }
      const stream = this.streams.get(frame.id);
      if (!stream) return; // Late cancellation acknowledgements are harmless.
      switch (frame.type) {
        case "head": if (!frame.head) throw new Error("Invalid response."); stream.head(frame.head); break;
        case "data": if (typeof frame.data !== "string" || frame.data.length > Math.ceil(TUNNEL_STREAM_LIMITS.dataFrameBytes / 3) * 4) throw new Error("Invalid data."); stream.receive(Buffer.from(frame.data, "base64")); break;
        case "end": stream.push(null); break;
        case "window": stream.replenish(frame.bytes!); break;
        case "reset": this.streams.delete(frame.id); stream.destroy(new Error("Remote request cancelled.")); break;
        default: throw new Error("Unknown tunnel frame.");
      }
    } catch { this.close(); }
  };
  open(request: TunnelRequest, authorize?: () => void): TunnelStream {
    if (this.closed || !this.caller || this.streams.size >= TUNNEL_STREAM_LIMITS.maxConcurrentStreams) throw new Error("Tunnel unavailable or busy.");
    const stream = new TunnelStream(randomUUID(), this, authorize); this.streams.set(stream.id, stream);
    this.lastUsedAt = Date.now(); void this.send({ type: "open", id: stream.id, request }, authorize).catch(error => stream.destroy(error)); return stream;
  }
  ping(timeoutMs = getTimeoutMs("backend.peerTunnel.session.ping.timeoutMs", 3_000)): Promise<number> {
    if (this.closed) return Promise.reject(new Error("Tunnel disconnected."));
    if (this.pingWaiters.size >= 2) return Promise.reject(new Error("Tunnel probe already running."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pingWaiters.delete(id); reject(new Error("Tunnel probe timed out.")); this.close(); }, timeoutMs);
      this.pingWaiters.set(id, { resolve, reject, start: performance.now(), timer }); void this.send({ type: "ping", id }).catch(() => {});
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Install the promise before closing the channel, which may emit close synchronously.
    let finished!: () => void, failed!: (error: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject; });
    // Native close events also initiate retirement without an awaiting caller.
    // Keep the original rejected promise available to the eventual owner join.
    void this.closing.catch(() => undefined);
    this.closed = true; this.pendingRequests = []; this.channel.removeListener("data", this.receive);
    const channelClose = Promise.resolve().then(() => this.channel.close());
    for (const value of this.pingWaiters.values()) { clearTimeout(value.timer); value.reject(new Error("Tunnel disconnected.")); }
    this.pingWaiters.clear();
    const streams = [...this.streams.values()];
    const closures = streams.map(stream => stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve)));
    for (const stream of streams) stream.destroy(new Error("Tunnel disconnected; request result may be unknown."));
    this.streams.clear();
    const errors: unknown[] = [];
    try { this.emit("close"); } catch (error) { errors.push(error); }
    void (async () => {
      const [native] = await Promise.allSettled([channelClose, this.serial, ...closures]);
      if (native.status === "rejected") errors.push(native.reason);
      // Stream close handlers can adopt their upstream close only during cancellation.
      while (this.producers.size) await Promise.allSettled([...this.producers]);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Tunnel session cleanup failed.");
    })().then(finished, failed);
    return this.closing;
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
