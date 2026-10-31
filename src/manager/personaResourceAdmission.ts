import type http from 'node:http';
import { assertTrustedLanAgentPrincipal } from './lanAgentRequestAccess.js';
import { hasAuthenticatedConnectionRequest } from './connectionRequestAccess.js';

export type PersonaResourceIdentity = { applicationGenerationId: string; managerInstanceId: string };
/** Provenance and generation only; public resource access does not acquire a feature grant. */
export function preparePersonaResourceAdmission(request: http.IncomingMessage, signal?: AbortSignal, identity?: () => PersonaResourceIdentity) {
  const lease = assertTrustedLanAgentPrincipal(request), originallyAuthenticated = hasAuthenticatedConnectionRequest(request);
  const before = identity ? Object.freeze({ ...identity() }) : undefined;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (assertTrustedLanAgentPrincipal(request) !== lease) throw Object.assign(new Error('Original persona resource connection changed.'), { statusCode: 403 });
    if (originallyAuthenticated && !hasAuthenticatedConnectionRequest(request)) throw Object.assign(new Error('Original persona resource connection expired.'), { statusCode: 403 });
    if (!originallyAuthenticated) hasAuthenticatedConnectionRequest(request);
    const current = identity?.();
    if (before && (!current || !before.applicationGenerationId || !before.managerInstanceId || before.applicationGenerationId !== current.applicationGenerationId || before.managerInstanceId !== current.managerInstanceId)) {
      throw Object.assign(new Error('Manager identity changed while reading a persona resource.'), { statusCode: 409 });
    }
  };
  assertCurrent(); return assertCurrent;
}
