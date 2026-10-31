import type http from "node:http";
import type { ResourceApiTarget } from "./resourceApiContract.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { resourceOwnerId } from "./resourceCacheProtocol.js";

export type ResourceApiInput = ResourceApiTarget & Readonly<{ request: http.IncomingMessage; url: URL;
  parsed?: Readonly<{ value: unknown }>; readBytes?: (limit: number) => Promise<Buffer> }>;
/** Public connection admission and device resources transport are alternative existing entries. */
export function authenticatedResourceOwner(request: http.IncomingMessage, device: { local(request: http.IncomingMessage): boolean; key(): string }): string | null {
  const connected = Boolean(assertTrustedLanAgentPrincipal(request)) || hasAuthenticatedConnectionRequest(request);
  if (!connected && (!device.local(request) || !device.key() || request.headers["x-rabilink-resource-key"] !== device.key())) return null;
  return resourceOwnerId(request.headers["x-rabilink-resource-owner"]);
}
/** Captures admission, rather than allowing a revoked remote request to become local. */
export function resourceRequestGuard(request: http.IncomingMessage): () => void {
  const principal = assertTrustedLanAgentPrincipal(request);
  const check = () => {
    try {
      if (assertTrustedLanAgentPrincipal(request) !== principal) throw new Error("Resource request identity changed.");
      hasAuthenticatedConnectionRequest(request);
    } catch { throw Object.assign(new Error("Access denied"), { status: 403 }); }
  };
  check(); return check;
}
export async function resourceRequestBytes(input: ResourceApiInput, limit: number): Promise<Buffer> {
  if (input.readBytes) return input.readBytes(limit);
  return readResourceBytes(input.request, limit);
}
export async function readResourceBytes(source: AsyncIterable<unknown>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function resourceRequestJson(input: ResourceApiInput, limit: number, fatal = false): Promise<unknown> {
  if (input.parsed) return input.parsed.value;
  const body = await resourceRequestBytes(input, limit);
  return JSON.parse(fatal ? new TextDecoder("utf-8", { fatal: true }).decode(body) : body.toString("utf8"));
}
