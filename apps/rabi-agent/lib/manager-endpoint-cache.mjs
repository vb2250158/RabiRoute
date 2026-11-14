import { MANAGER_TRANSPORT_ABI } from './manager-transport-contract.mjs';

const same = (left, right) => left?.applicationGenerationId === right?.applicationGenerationId && left?.managerInstanceId === right?.managerInstanceId;
/** Rebuildable connection facts only. Server auth, user flags and quotas are not grants cached here. */
export function createManagerEndpointCache() {
  let endpoint, modern = false, dirty = false, failedRevision, observedRevision, epoch = 0, sequence = 0, metadataSequence = 0, observationSequence = 0;
  const begin = () => ({ epoch, sequence: ++sequence });
  const invalidate = () => { endpoint = undefined; modern = false; dirty = false; failedRevision = undefined; observedRevision = undefined; epoch++; observationSequence = sequence; };
  function remember(value, context, token = begin()) {
    if (token.epoch !== epoch || token.sequence < metadataSequence) return false;
    endpoint = value;
    modern = value?.meta?.apiTransport?.abi === MANAGER_TRANSPORT_ABI && context?.abi === MANAGER_TRANSPORT_ABI && same(value.meta, context);
    if (token.sequence >= observationSequence) observedRevision = context?.metadataRevision;
    failedRevision = undefined;
    dirty = modern && value.meta.apiTransport.metadataRevision !== observedRevision;
    metadataSequence = token.sequence; observationSequence = Math.max(observationSequence, token.sequence);
    return true;
  }
  function observe(context, token) {
    if (!context || !modern || !endpoint || token.epoch !== epoch || token.sequence < observationSequence) return false;
    observationSequence = token.sequence;
    if (!same(endpoint.meta, context)) { invalidate(); return true; }
    observedRevision = context.metadataRevision;
    dirty = endpoint.meta.apiTransport.metadataRevision !== context.metadataRevision && failedRevision !== context.metadataRevision;
    return false;
  }
  const deferMetadata = (token, revision) => { if (token.epoch === epoch && token.sequence >= metadataSequence) {
    failedRevision = revision; dirty = modern && endpoint.meta.apiTransport.metadataRevision !== observedRevision && failedRevision !== observedRevision;
  } };
  return { begin, remember, observe, invalidate, deferMetadata, metadataRevision: () => observedRevision, get: () => modern ? endpoint : undefined, snapshot: () => endpoint, needsMetadata: () => dirty };
}
