import type { IncomingMessage } from "node:http";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const authenticated = new WeakSet<object>();
const authorityGuards = new WeakMap<object, () => void>();

/** Set only after Manager verifies the remote connection; request headers cannot create this identity. */
export function markAuthenticatedConnectionRequest(request: IncomingMessage, assertCurrentAuthority?: () => void): void {
  authenticated.add(request);
  if (assertCurrentAuthority) authorityGuards.set(request, assertCurrentAuthority);
}

export function hasAuthenticatedConnectionRequest(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  // Revalidate an admitted Agent lease even when ingress marked this request earlier.
  const source = getTrustedLanAgentSource(request as IncomingMessage);
  authorityGuards.get(request)?.();
  return authenticated.has(request) || Boolean(source);
}
