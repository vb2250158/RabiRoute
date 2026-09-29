import { validateAgentProfile, PROFILE_LIMITS } from './rabilink-agent-profile.mjs';
export function normalizeAgentProfileState(value) {
  if (value === undefined) return undefined;
  const invalid = () => { throw new Error('Invalid stored Agent profile state'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['profile','applied','operations'].includes(k))) invalid();
  const profile = validateAgentProfile(value.profile);
  const applied = input => {
    if (input === null) return null;
    if (!input || Object.keys(input).some(k => !['appliedRevision','status','errorCode'].includes(k)) || !Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 1 || input.appliedRevision > profile.revision || !['applied','failed'].includes(input.status)) invalid();
    if ((input.status === 'failed') !== (input.errorCode !== undefined) || (input.errorCode !== undefined && !['MODEL_UNAVAILABLE','PERSIST_FAILED','INVALID_PROFILE','TOOLS_UNAVAILABLE','APPLY_FAILED'].includes(input.errorCode))) invalid();
    return structuredClone(input);
  };
  if (!Array.isArray(value.operations) || value.operations.length > PROFILE_LIMITS.operations) invalid();
  const keys = new Set();
  const operations = value.operations.map(operation => {
    if (!operation || Object.keys(operation).some(k => !['key','intentHash','receipt'].includes(k)) || !/^[A-Za-z0-9:._-]{1,128}$/.test(operation.key) || !/^[a-f0-9]{64}$/.test(operation.intentHash) || keys.has(operation.key)) invalid();
    keys.add(operation.key);
    const receipt = operation.receipt;
    if (!receipt || Object.keys(receipt).some(k => !['idempotencyKey','savedRevision','profile','applied'].includes(k)) || receipt.idempotencyKey !== operation.key) invalid();
    const prior = validateAgentProfile(receipt.profile);
    if (receipt.savedRevision !== prior.revision || prior.revision > profile.revision) invalid();
    const acknowledgement = applied(receipt.applied);
    if (acknowledgement && acknowledgement.appliedRevision > prior.revision) invalid();
    return { key: operation.key, intentHash: operation.intentHash, receipt: { idempotencyKey: operation.key, savedRevision: prior.revision, profile: prior, applied: acknowledgement } };
  });
  return { profile, applied: applied(value.applied), operations };
}
export function assertProfileManagementCsrf(req) {
  // Custom header + JSON require browser preflight; no CORS credential grant is provided.
  if (req.headers['x-rabilink-profile-write'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['sec-fetch-site'] === 'cross-site') {
    const error = new Error('PROFILE_CSRF_REJECTED'); error.statusCode = 403; throw error;
  }
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { origin = null; }
    if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) {
      const error = new Error('PROFILE_CSRF_REJECTED'); error.statusCode = 403; throw error;
    }
  }
}
