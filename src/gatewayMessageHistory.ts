import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { subscribeMessageHistoryChanges } from "./messageHistoryChanges.js";

export const GATEWAY_MESSAGE_HISTORY_PREFIX = "RABIROUTE_MESSAGE_HISTORY_CHANGED:";
export type GatewayMessageHistoryIdentity = Readonly<{ gatewayId: string; gatewayGenerationId: string; pid: number }>;
export type GatewayMessageHistoryChanged = GatewayMessageHistoryIdentity & Readonly<{ protocolVersion: 1 }>;

/** Pipe chunks can divide both a protocol line and a multibyte Route identifier. */
export function createGatewayOutputLineReader(): (chunk: Buffer) => string[] {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return chunk => {
    buffer += decoder.write(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    return lines.filter(Boolean);
  };
}

/** A hint only. The receiving owner rereads committed records; no private data crosses stdout. */
export function gatewayMessageHistoryLine(identity: GatewayMessageHistoryIdentity): string {
  return GATEWAY_MESSAGE_HISTORY_PREFIX + JSON.stringify({ protocolVersion: 1, gatewayId: identity.gatewayId,
    gatewayGenerationId: identity.gatewayGenerationId, pid: identity.pid });
}

export function parseGatewayMessageHistoryLine(line: string, expected: GatewayMessageHistoryIdentity): GatewayMessageHistoryChanged | null {
  if (!line.startsWith(GATEWAY_MESSAGE_HISTORY_PREFIX) || line.length > 4096) return null;
  try {
    const value = JSON.parse(line.slice(GATEWAY_MESSAGE_HISTORY_PREFIX.length));
    if (value?.protocolVersion !== 1 || value.gatewayId !== expected.gatewayId
      || value.gatewayGenerationId !== expected.gatewayGenerationId || value.pid !== expected.pid
      || !expected.gatewayId || !expected.gatewayGenerationId || !Number.isSafeInteger(expected.pid) || expected.pid <= 0) return null;
    return Object.freeze({ protocolVersion: 1, gatewayId: expected.gatewayId, gatewayGenerationId: expected.gatewayGenerationId, pid: expected.pid });
  } catch { return null; }
}

/** Subscribe only to the existing post-persistence hint; coalesce bursts and retain one hint under backpressure. */
export function reportGatewayMessageHistory(options: {
  identity: GatewayMessageHistoryIdentity;
  output: Pick<Writable, "write" | "once" | "removeListener" | "destroyed">;
  subscribe?: typeof subscribeMessageHistoryChanges;
}): () => void {
  let disposed = false, scheduled = false, blocked = false, dirty = false;
  const identity = Object.freeze({ ...options.identity });
  const drain = () => { blocked = false; if (dirty) schedule(); };
  function flush() {
    scheduled = false;
    if (disposed || blocked || !dirty || options.output.destroyed) return;
    dirty = false;
    try {
      if (!options.output.write(gatewayMessageHistoryLine(identity) + "\n")) {
        blocked = true; options.output.once("drain", drain);
      }
    } catch { /* Losing a notification cannot undo a committed ledger write. */ }
  }
  function schedule() { if (!disposed && !scheduled && !blocked) { scheduled = true; queueMicrotask(flush); } }
  const unsubscribe = (options.subscribe ?? subscribeMessageHistoryChanges)(() => { dirty = true; schedule(); });
  return () => { disposed = true; dirty = false; unsubscribe(); options.output.removeListener("drain", drain); };
}
