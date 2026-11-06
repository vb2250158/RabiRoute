import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** Consumer shape of the versioned generic host.peer-transports@1 port. */
export interface HtmlShareChannel extends Pick<EventEmitter, "on" | "off" | "once"> {
  send(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}
export interface HtmlShareRtc {
  offer(sdp: unknown, accept: (channel: HtmlShareChannel) => void): Promise<{ sdp: string }>;
  stop(): Promise<void>;
}
export interface HtmlShareSocketServer extends Pick<EventEmitter, "on" | "off"> {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, accept: (socket: unknown) => void): void;
  close(callback?: (error?: Error) => void): void;
}
export type HtmlShareTransports = Readonly<{
  priority: readonly string[];
  createRtc(): HtmlShareRtc;
  createWebSocketServer(options: Readonly<{ maxPayload: number }>): HtmlShareSocketServer;
  websocketChannel(socket: unknown): HtmlShareChannel;
  connectWebsocket(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<HtmlShareChannel>;
}>;
