import type { IncomingMessage } from "node:http";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

const authenticated = new WeakSet<object>();

/** Set only after Manager verifies the remote connection; request headers cannot create this identity. */
export function markAuthenticatedConnectionRequest(request: IncomingMessage): void { authenticated.add(request); }

export function hasAuthenticatedConnectionRequest(request: Pick<IncomingMessage, "headers" | "socket">): boolean {
  return authenticated.has(request) || Boolean(getTrustedLanAgentSource(request as IncomingMessage));
}
