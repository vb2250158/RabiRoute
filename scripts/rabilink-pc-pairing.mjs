import { createHash } from 'node:crypto';

export const PAIRING_LIMITS = Object.freeze({ lifetimeMs: 1_800_000, requests: 500, credentialsPerApp: 100 });
export const pairingHash = value => createHash('sha256').update(value).digest('hex');
export const pairingFingerprint = request => pairingHash(JSON.stringify([request.id, request.deviceId, request.deviceGuid, request.credentialHash])).slice(0, 16);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
function requestIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PAIRING_INVALID_REQUEST');
  const { id, deviceId, deviceGuid, deviceName, proofHash, credentialHash } = input;
  if (!uuidPattern.test(id || '') || !uuidPattern.test(deviceGuid || '')
      || typeof deviceId !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(deviceId)
      || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(deviceName)
      || !hashPattern.test(proofHash || '') || !hashPattern.test(credentialHash || '')) fail('PAIRING_INVALID_REQUEST');
  return { id, deviceId, deviceGuid, deviceName: deviceName.trim(), proofHash, credentialHash };
}

/** One atomic application-store commit consumes the one-time ticket and grants the PC credential. */
export function createPcPairingService({ readStore, writeStore, now = Date.now, onEvent = () => {} }) {
  function view(store, request) {
    const app = store.apps.find(item => item.id === request.appId && item.enabled !== false);
    const credential = app?.pcCredentials?.find(item => item.id === request.credentialId && item.enabled !== false);
    const active = credential && credential.appTokenHash === pairingHash(app.token);
    return { id: request.id, deviceId: request.deviceId, deviceGuid: request.deviceGuid, deviceName: request.deviceName,
      fingerprint: pairingFingerprint(request), state: active ? 'approved' : 'revoked', appId: request.appId, credentialId: request.credentialId };
  }
  return {
    issue(accountId, appId, input) {
      if (!uuidPattern.test(input?.id || '') || !hashPattern.test(input?.ticketHash || '')) fail('PAIRING_INVALID_REQUEST');
      const store = readStore(), app = store.apps.find(item => item.id === appId && item.ownerAccountId === accountId && item.enabled !== false);
      if (!app) fail('PAIRING_APPLICATION_NOT_FOUND', 404);
      store.pcPairingTickets ||= [];
      const previous = store.pcPairingTickets.find(item => item.id === input.id);
      if (previous) {
        if (previous.appId !== appId || previous.ownerAccountId !== accountId || previous.ticketHash !== input.ticketHash) fail('PAIRING_IDEMPOTENCY_CONFLICT', 409);
        return { id: previous.id, appId, expiresAt: previous.expiresAt, consumed: Boolean(previous.requestId) };
      }
      if (store.pcPairingTickets.some(item => item.ticketHash === input.ticketHash)) fail('PAIRING_IDEMPOTENCY_CONFLICT', 409);
      store.pcPairingTickets = store.pcPairingTickets.filter(item => item.expiresAt + 86_400_000 > now());
      if (store.pcPairingTickets.length >= PAIRING_LIMITS.requests
          || store.pcPairingTickets.filter(item => item.appId === appId && !item.requestId && item.expiresAt > now()).length >= 10) fail('PAIRING_CAPACITY', 429);
      const ticket = { id: input.id, appId, ownerAccountId: accountId, ticketHash: input.ticketHash,
        appTokenHash: pairingHash(app.token), expiresAt: now() + PAIRING_LIMITS.lifetimeMs };
      store.pcPairingTickets.push(ticket); writeStore(store);
      onEvent('pc_pairing_ticket_issued', { ticketId: ticket.id, appId });
      return { id: ticket.id, appId, expiresAt: ticket.expiresAt, consumed: false };
    },
    begin(input, ticketValue) {
      const identity = requestIdentity(input);
      if (typeof ticketValue !== 'string' || !/^rpt_[A-Za-z0-9_-]{43}$/.test(ticketValue)) fail('PAIRING_TICKET_REQUIRED', 401);
      const store = readStore(), ticketHash = pairingHash(ticketValue);
      const ticket = (store.pcPairingTickets || []).find(item => item.ticketHash === ticketHash);
      if (!ticket) fail('PAIRING_TICKET_INVALID', 401);
      const previous = (store.pcPairings || []).find(item => item.id === identity.id);
      if (previous) {
        if (previous.ticketHash !== ticketHash || JSON.stringify(requestIdentity(previous)) !== JSON.stringify(identity)) fail('PAIRING_IDEMPOTENCY_CONFLICT', 409);
        return view(store, previous);
      }
      if (ticket.requestId) fail('PAIRING_TICKET_CONSUMED', 409);
      if (ticket.expiresAt <= now()) fail('PAIRING_TICKET_EXPIRED', 410);
      const app = store.apps.find(item => item.id === ticket.appId && item.ownerAccountId === ticket.ownerAccountId && item.enabled !== false);
      if (!app || ticket.appTokenHash !== pairingHash(app.token)) fail('PAIRING_TICKET_INVALID', 401);
      app.pcCredentials ||= [];
      if (app.pcCredentials.length >= PAIRING_LIMITS.credentialsPerApp) fail('PAIRING_CREDENTIAL_CAPACITY', 409);
      const identitiesMatch = item => item.deviceId === identity.deviceId || item.deviceGuid === identity.deviceGuid;
      const activeCredential = item => item.enabled !== false && item.appTokenHash === pairingHash(app.token);
      const previousRevoked = app.pcCredentials.some(item => identitiesMatch(item) && !activeCredential(item));
      if ((!previousRevoked && store.workers.some(item => item.appId === app.id && (item.id === identity.deviceId || item.guid === identity.deviceGuid)))
          || app.pcCredentials.some(item => identitiesMatch(item) && activeCredential(item))) fail('PAIRING_DEVICE_ALREADY_EXISTS', 409);
      const request = { ...identity, ticketHash, appId: app.id, ownerAccountId: ticket.ownerAccountId, credentialId: 'pc-' + identity.id };
      app.pcCredentials.push({ id: request.credentialId, deviceId: identity.deviceId, deviceGuid: identity.deviceGuid, deviceName: identity.deviceName,
        credentialHash: identity.credentialHash, appTokenHash: pairingHash(app.token), enabled: true, createdAt: new Date(now()).toISOString() });
      (store.pcPairings ||= []).push(request); ticket.requestId = request.id;
      writeStore(store); onEvent('pc_pairing_approved', { pairingId: request.id, appId: app.id });
      return view(store, request);
    },
    read(id, proof) {
      const store = readStore(), request = (store.pcPairings || []).find(item => item.id === id);
      if (!request) fail('PAIRING_NOT_FOUND', 404);
      if (typeof proof !== 'string' || !/^rpp_[A-Za-z0-9_-]{43}$/.test(proof) || pairingHash(proof) !== request.proofHash) fail('PAIRING_PROOF_REQUIRED', 401);
      return view(store, request);
    },
    revoke(accountId, appId, credentialId) {
      const store = readStore();
      const app = store.apps.find(item => item.id === appId && item.ownerAccountId === accountId);
      const credential = app?.pcCredentials?.find(item => item.id === credentialId);
      if (!credential) fail('PAIRING_CREDENTIAL_NOT_FOUND', 404);
      credential.enabled = false; writeStore(store);
      onEvent('pc_pairing_revoked', { credentialId, appId });
      return { id: credentialId, enabled: false };
    }
  };
}
export function findPcCredential(store, token) {
  if (typeof token !== 'string' || !/^rbw_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = pairingHash(token);
  for (const app of store.apps) {
    if (app.enabled === false) continue;
    const pcCredential = app.pcCredentials?.find(item => item.enabled !== false && item.credentialHash === hash && item.appTokenHash === pairingHash(app.token));
    if (pcCredential) return { app, pcCredential, deviceBinding: null };
  }
  return null;
}
export function assertPcPairingCsrf(req) {
  if (req.headers['x-rabilink-pairing-write'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')
      || req.headers['sec-fetch-site'] === 'cross-site') fail('PAIRING_CSRF_REJECTED', 403);
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail('PAIRING_CSRF_REJECTED', 403); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) fail('PAIRING_CSRF_REJECTED', 403);
  }
}
