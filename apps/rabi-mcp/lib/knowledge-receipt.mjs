/** Knowledge HTTP receipts; no storage, retries, or business-state ownership. */
export function isStrongEtag(value) {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value);
}
export function stableKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(value)) throw new TypeError('An explicit stable idempotencyKey is required.');
  return value;
}
export function knowledgeReceipt(receipt, { mutation = false, idempotencyKey, resourceId } = {}) {
  let body;
  try { body = typeof receipt?.body === 'string' ? JSON.parse(receipt.body) : receipt?.body; } catch { /* Invalid JSON is not success. */ }
  const statusCode = Number.isInteger(receipt?.statusCode) ? receipt.statusCode : 0;
  const headers = Object.fromEntries(Object.entries(receipt?.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const state = body?.commitState;
  let uncertain = receipt?.uncertain === true || body?.uncertain === true || state === 'unknown' || (mutation && (statusCode === 0 || statusCode >= 500 || receipt?.identityChanged === true));
  const httpSuccess = statusCode >= 200 && statusCode < 300 && receipt?.ok === true && body?.code === 0;
  const identityValid = typeof body?.data?.id === 'string' && body.data.id.trim().length > 0 && (!resourceId || body.data.id === resourceId);
  const validCommit = !mutation || (headers['idempotency-key'] === idempotencyKey && isStrongEtag(headers.etag) && identityValid && (!state || state === 'committed'));
  if (mutation && statusCode >= 200 && statusCode < 300 && (!httpSuccess || !validCommit)) uncertain = true;
  if (mutation && !httpSuccess && state !== 'not_started' && state !== 'committed' && statusCode !== 412) uncertain = true;
  const validReadIdentity = !resourceId || identityValid;
  const ok = httpSuccess && validCommit && validReadIdentity && receipt?.identityChanged !== true && !uncertain;
  const commitState = mutation ? ok ? 'committed' : state === 'committed' ? 'committed' : uncertain ? 'unknown' : state === 'not_started' || statusCode === 412 ? 'not_started' : 'unknown' : undefined;
  return {
    ok, statusCode, uncertain, ...(commitState ? { commitState } : {}),
    ...(headers.etag ? { etag: headers.etag } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(ok ? { data: body.data } : { error: 'KNOWLEDGE_REQUEST_NOT_CONFIRMED', reason: typeof body?.reason === 'string' ? body.reason : undefined,
      nextAction: mutation ? 'Read authoritative state; preserve the original body and key. Never automatically replay. For 412, reread and confirm intent before using a new key and ETag.' : 'Inspect the response status; an unavailable query is not an empty result.' })
  };
}
