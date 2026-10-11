import { createHash } from 'node:crypto';
import { validateApiRequest } from '../packages/rabi-api-contract/request.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One connection credential grants public API transport. Persona is context, never a permission filter.
 * Ledger adapter must synchronously commit before dispatch; uncertain writes are never replayed.
 */
export function createDeviceApiService({ load, save, dispatch }) {
  const active = new Map();
  const scopeKey = identity => digest([identity.appId, identity.bindingId]);
  function identityCheck(identity) {
    if (!identity || !identity.appId || !identity.bindingId || !identity.targetDeviceId) fail('API_CONNECTION_REQUIRED');
  }
  function ledger(identity) {
    const rows = load(scopeKey(identity)) || [];
    if (!Array.isArray(rows) || rows.length > 2048) fail('API_LEDGER_INVALID');
    return rows;
  }
  async function request(identity, input) {
    identityCheck(identity);
    const validated = validateApiRequest(input);
    const { mutation, ...packet } = validated;
    if (!mutation) return dispatch(identity, packet, false);
    const fingerprint = digest([identity.targetDeviceId, packet]);
    const scope = scopeKey(identity), key = scope + ':' + packet.operationId;
    const rows = ledger(identity);
    const old = rows.find(row => row.id === packet.operationId);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('API_OPERATION_CONFLICT');
      if (active.has(key)) return active.get(key);
      // Persistence stores status only; read the original resource/receipt for the actual result.
      return { structuredContent: { ok: false, uncertain: true, code: 'API_READBACK_REQUIRED', operationId: old.id, state: old.state } };
    }
    if (rows.length >= 2048) fail('API_LEDGER_FULL');
    save(scope, [...rows, { id: packet.operationId, fingerprint, state: 'pending' }]);
    const running = Promise.resolve().then(() => dispatch(identity, packet, true)).then(result => {
      const state = result?.structuredContent?.ok === true && !result.structuredContent.uncertain ? 'completed' : 'uncertain';
      save(scope, ledger(identity).map(row => row.id === packet.operationId ? { ...row, state } : row));
      return result;
    }).catch(() => ({ structuredContent: { ok: false, uncertain: true, code: 'API_OUTCOME_UNCERTAIN', operationId: packet.operationId } })).finally(() => active.delete(key));
    active.set(key, running);
    return running;
  }
  return { request, receipt(identity, operationId) { identityCheck(identity); const row = ledger(identity).find(item => item.id === operationId); return row ? { operationId: row.id, state: row.state } : null; } };
}
