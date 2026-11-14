import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';

// The original key becomes the session allocator after its rows are migrated.
// Per-scope journals retain operation digests; model recreation is not deletion.
const ALLOCATOR_KEY = 'rabilink-aiui-api-ledger-v1';
const JOURNAL_PREFIX = 'rabilink-aiui-api-ledger-v2:';
export const API_TOOL_LEDGER_LIMIT = 128;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(value);

export function validateApiToolRows(rows) {
  if (!Array.isArray(rows) || rows.length > API_TOOL_LEDGER_LIMIT * 2) fail('TOOL_LEDGER_INVALID');
  const calls = new Set();
  let operations = 0;
  for (const row of rows) {
    if (!row || !identifier(row.id) || !['pending', 'completed', 'uncertain'].includes(row.state)
      || row.sessionId !== undefined && !identifier(row.sessionId)
      || row.fingerprint !== undefined && (typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint))
      || row.operationId !== undefined && (typeof row.operationId !== 'string' || !/^[A-Za-z0-9:._-]{1,256}$/.test(row.operationId))
      || Object.keys(row).some(key => !['id', 'sessionId', 'operationId', 'fingerprint', 'state'].includes(key))) fail('TOOL_LEDGER_INVALID');
    const callKey = JSON.stringify([row.sessionId || '', row.id]);
    if (calls.has(callKey)) fail('TOOL_LEDGER_INVALID');
    calls.add(callKey);
    if (row.operationId) operations++;
  }
  if (operations > API_TOOL_LEDGER_LIMIT || rows.length - operations > API_TOOL_LEDGER_LIMIT) fail('TOOL_LEDGER_INVALID');
  return rows;
}

export function openApiToolLedger({ storage, scope, isCurrent = () => true }) {
  if (!storage?.getStorageSync || !storage?.setStorageSync || typeof scope !== 'string' || !scope) fail('API_LEDGER_DEPENDENCIES_REQUIRED');
  const assertContext = () => { if (!isCurrent()) fail('API_SCOPE_CHANGED'); };
  const saveVerified = (key, value) => {
    assertContext();
    storage.setStorageSync(key, value);
    if (JSON.stringify(storage.getStorageSync(key)) !== JSON.stringify(value)) fail('API_LEDGER_SAVE_UNCONFIRMED');
  };
  const readJournal = hash => {
    const value = storage.getStorageSync(JOURNAL_PREFIX + hash);
    if (value === undefined) return null;
    if (value?.version !== 2 || value.scope !== hash || !Number.isSafeInteger(value.counter) || value.counter < 1) fail('API_LEDGER_INVALID');
    validateApiToolRows(value.rows);
    return value;
  };
  assertContext();
  const previous = storage.getStorageSync(ALLOCATOR_KEY);
  if (previous !== undefined) {
    if (!previous || !Number.isSafeInteger(previous.counter) || previous.counter < 1
      || previous.version !== undefined && previous.version !== 2) fail('API_LEDGER_INVALID');
    if (previous.version === undefined) {
      if (typeof previous.scope !== 'string' || !previous.scope || previous.rows?.length > API_TOOL_LEDGER_LIMIT) fail('API_LEDGER_INVALID');
      validateApiToolRows(previous.rows);
      const oldScope = sha256Text(previous.scope);
      // A failed allocator write may leave the verified journal already copied.
      // Retry migration without overwriting that newer journal.
      if (!readJournal(oldScope)) saveVerified(JOURNAL_PREFIX + oldScope, {
        version: 2, scope: oldScope, counter: previous.counter,
        rows: previous.rows.filter(row => row.operationId).map(row => ({ ...row, sessionId: row.sessionId || 'aiui-' + previous.counter }))
      });
    }
  }
  const counter = (previous?.counter || 0) + 1;
  if (!Number.isSafeInteger(counter)) fail('API_SESSION_LIMIT');
  const hash = sha256Text(scope), key = JOURNAL_PREFIX + hash;
  const existing = readJournal(hash);
  // If an allocator was lost, do not reuse an operation/session namespace.
  if (existing && existing.counter >= counter) fail('API_LEDGER_ALLOCATOR_INVALID');
  const record = { version: 2, scope: hash, counter,
    rows: (existing?.rows || []).filter(row => row.operationId) };
  saveVerified(ALLOCATOR_KEY, { version: 2, counter });
  saveVerified(key, record);
  const ownsJournal = () => isCurrent() && storage.getStorageSync(ALLOCATOR_KEY)?.counter === counter
    && storage.getStorageSync(key)?.counter === counter;
  const requireOwner = () => { if (!ownsJournal()) fail('API_SCOPE_CHANGED'); };
  return {
    sessionId: 'aiui-' + counter,
    isCurrent: ownsJournal,
    storage: {
      load() { requireOwner(); return readJournal(hash).rows; },
      save(rows) {
        requireOwner(); validateApiToolRows(rows);
        saveVerified(key, { ...record, rows });
      }
    }
  };
}
