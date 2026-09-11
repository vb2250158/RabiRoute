import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { RTCDataChannel } from "werift";

class BufferedChannel extends EventEmitter implements TunnelChannel {
  send!: (bytes: Buffer) => Promise<void>;
  close!: () => void;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "data" && !this.listenerCount("data")) {
      const bytes = args[0] as Buffer;
      this.pendingBytes += bytes.length;
      if (this.pendingBytes > 65_536) { this.pending = []; this.emit("close"); return false; }
      this.pending.push(bytes); return true;
    }
    return super.emit(event, ...args);
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "data" && this.pending.length) queueMicrotask(() => {
      const queued = this.pending; this.pending = []; this.pendingBytes = 0;
      for (const bytes of queued) this.emit("data", bytes);
    });
    return this;
  }
}
export interface TunnelChannel extends EventEmitter { send(bytes: Buffer): Promise<void>; close(): void; }
export function websocketChannel(socket: WebSocket): TunnelChannel {
  const result = new BufferedChannel() as TunnelChannel;
  socket.on("message", bytes => result.emit("data", Buffer.from(bytes as Buffer)));
  socket.on("close", () => result.emit("close"));
  socket.on("error", () => { socket.terminate(); result.emit("close"); });
  result.send = bytes => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 2 * 1024 * 1024) return reject(new Error("Tunnel channel unavailable."));
    socket.send(bytes, error => error ? reject(error) : resolve());
  });
  result.close = () => socket.terminate();
  return result;
}
export function rtcChannel(channel: RTCDataChannel, close: () => void): TunnelChannel {
  const result = new BufferedChannel() as TunnelChannel;
  channel.onMessage.subscribe(bytes => result.emit("data", Buffer.from(bytes)));
  channel.stateChange.subscribe(state => { if (state === "closed") result.emit("close"); });
  result.send = async bytes => {
    if (channel.readyState !== "open" || channel.bufferedAmount > 2 * 1024 * 1024) throw new Error("Tunnel channel unavailable.");
    channel.send(bytes);
  };
  result.close = close;
  return result;
}
export function connectWebsocket(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<TunnelChannel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, maxPayload: 40_000, handshakeTimeout: 5_000, followRedirects: false });
    const abort = () => { ws.terminate(); reject(new Error("Tunnel connection cancelled.")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    ws.once("error", error => { signal.removeEventListener("abort", abort); reject(error); });
    ws.once("open", () => { signal.removeEventListener("abort", abort); resolve(websocketChannel(ws)); });
  });
}
