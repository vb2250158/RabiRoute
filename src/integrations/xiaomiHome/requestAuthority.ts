import type { IncomingMessage } from "node:http";
import { assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";

/** Explicit request ownership; autonomous monitors and startup never capture this guard. */
export type XiaomiHomeRequestAuthority = Readonly<{
  assert: () => void;
  dispatch: () => void;
}>;

export class XiaomiHomeRequestAuthorityError extends Error {
  readonly status = 403;
  readonly code = "xiaomi_home_request_forbidden";
  constructor(readonly outcome: "not_started" | "unknown") {
    super(outcome === "unknown"
      ? "Request authority changed after dispatch; the result is unknown. Do not retry automatically."
      : "Request authority changed; the operation was not started.");
    this.name = "XiaomiHomeRequestAuthorityError";
  }
}

export function createXiaomiHomeRequestAuthority(request: IncomingMessage): XiaomiHomeRequestAuthority {
  let dispatched = false;
  const assert = () => {
    try { assertTrustedLanAgentPrincipal(request); }
    catch { throw new XiaomiHomeRequestAuthorityError(dispatched ? "unknown" : "not_started"); }
  };
  return Object.freeze({ assert, dispatch: () => { assert(); dispatched = true; } });
}

export function rethrowXiaomiHomeAuthorityError(error: unknown): void {
  if (error instanceof XiaomiHomeRequestAuthorityError) throw error;
}
