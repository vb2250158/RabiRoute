import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
export function createHtmlShareRelay(options: {
  directory: string;
  authorize(request: IncomingMessage, url: URL, body: unknown): { ok: boolean; app?: { id: string }; deviceBinding?: unknown };
  target(appId: string, deviceId: string): { app: { id: string }; worker: { id: string; peerUrls: string[] } } | undefined;
  signal(request: IncomingMessage, target: unknown, id: string, offer: { kind?: string; sdp?: string; room?: string }): Promise<unknown>;
}): {
  handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean>;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  stop(): void;
};
