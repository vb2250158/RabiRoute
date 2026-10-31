import { hasTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import type { IncomingMessage } from "node:http";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const authenticated = new WeakSet<object>();
const authorityGuards = new WeakMap<object, () => void>();
const consumedQueryParameters = new WeakMap<object, readonly string[]>();

/** Ingress records only parameter names after handling transport authentication; values are never copied. */
export function markConsumedConnectionQueryParameters(request: IncomingMessage, names: readonly string[]): void {
  consumedQueryParameters.set(request, Object.freeze([...new Set(names)]));
}

/** Business contracts see their query fields, while authentication keeps the original URL and lease. */
export function businessConnectionRequestUrl(request: IncomingMessage, url: URL): URL {
  const business = new URL(url.href);
  for (const name of consumedQueryParameters.get(request) ?? []) business.searchParams.delete(name);
  return business;
}

/** Set only after Manager verifies the remote connection; request headers cannot create this identity. */
export function markAuthenticatedConnectionRequest(request: IncomingMessage, assertCurrentAuthority?: () => void): void {
  authenticated.add(request);
  if (assertCurrentAuthority) authorityGuards.set(request, assertCurrentAuthority);
}

export function hasAuthenticatedConnectionRequest(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  // Revalidate an admitted Agent lease even when ingress marked this request earlier.
  const source = getTrustedLanAgentSource(request as IncomingMessage);
  authorityGuards.get(request)?.();
  return authenticated.has(request) || Boolean(source) || hasTrustedLanAgentPrincipal(request as IncomingMessage);
}
