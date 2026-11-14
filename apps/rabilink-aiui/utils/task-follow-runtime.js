import { validateApiRequest } from '../../../packages/rabi-api-contract/request.mjs';
import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { canonicalAgentIntent, snapshotTaskObservation } from '../../../packages/assistant-runtime/src/decision-protocol.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const copy = value => JSON.parse(JSON.stringify(value));
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const states = ['watching', 'ready', 'announced', 'stopped'];
const scalar = value => typeof value === 'string' && value.length <= 128;
const pointerValid = value => typeof value === 'string' && value.length <= 512
  && (value === '' || value.startsWith('/') && !/~(?:[^01]|$)/.test(value));
function select(value, pointer) {
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !has(value, key)) fail('TASK_STATUS_FIELD_MISSING');
    value = value[key];
  }
  return value;
}
function descriptor(args, defaultTargetDeviceId) {
  if (Object.keys(args).some(key => !['action', 'taskId', 'targetDeviceId', 'path', 'statusPointer', 'terminalValues', 'resultPointer', 'intervalMs'].includes(key))) fail('TASK_ARGUMENTS_INVALID');
  const targetDeviceId = args.targetDeviceId ?? defaultTargetDeviceId;
  if (typeof targetDeviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetDeviceId)
      || typeof args.taskId !== 'string' || !args.taskId.trim() || args.taskId.length > 256
      || !pointerValid(args.statusPointer) || !pointerValid(args.resultPointer ?? '')
      || !Array.isArray(args.terminalValues) || !args.terminalValues.length || args.terminalValues.length > 16
      || !args.terminalValues.every(scalar)) fail('TASK_ARGUMENTS_INVALID');
  const intervalMs = args.intervalMs ?? 10000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) fail('TASK_ARGUMENTS_INVALID');
  const request = validateApiRequest({ method: 'GET', path: args.path });
  return { taskId: args.taskId, targetDeviceId, path: request.path, statusPointer: args.statusPointer,
    terminalValues: [...new Set(args.terminalValues)].sort(), resultPointer: args.resultPointer ?? '', intervalMs };
}
export const TASK_FOLLOW_TOOL = Object.freeze({ type: 'function', function: {
  name: 'rabi_task_follow',
  description: '跟进原异步任务，不重新派发工作。watch 按刚查到的合同登记原 taskId、GET状态路径、JSON Pointer状态字段与终态字符串；Pointer 从HTTP JSON正文根开始，resultPointer可选择需要通知的结果。前台页面定期读取并保存终态，空闲时由同一助手通知；隐藏后停止、重开原绑定后恢复。list列出记录，read按id查看完整结果，stop只停止跟进、不取消后端任务。编号与终态必须来自真实合同/回执。',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['watch', 'list', 'read', 'stop'] }, id: { type: 'string' },
    taskId: { type: 'string' }, targetDeviceId: { type: 'string' }, path: { type: 'string' },
    statusPointer: { type: 'string' }, terminalValues: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
    resultPointer: { type: 'string' }, intervalMs: { type: 'integer', minimum: 1000, maximum: 60000 }
  }, required: ['action'], additionalProperties: false }
} });

/** Page-bound, read-only polling. Backend state stays at its original owner.
 * Durable terminal facts/summary precede presentation; no credentials are saved. */
export function createTaskFollowRuntime({ storage, scope, ownerId, defaultTargetDeviceId, read, isCurrent,
  now = Date.now, onStatus = () => {} }) {
  if (!storage?.getStorageSync || !storage?.setStorageSync || !scope || !ownerId
      || typeof read !== 'function' || typeof isCurrent !== 'function') fail('TASK_DEPENDENCIES_REQUIRED');
  const key = 'rabilink-aiui-task-follow-v1:' + sha256Text(scope);
  let closed = false, polling = false;
  const current = () => !closed && isCurrent();
  function load() {
    const stored = storage.getStorageSync(key);
    if (stored === undefined) return { version: 1, ownerId, rows: [] };
    if (stored?.version !== 1 || typeof stored.ownerId !== 'string' || !Array.isArray(stored.rows) || stored.rows.length > 48) fail('TASK_JOURNAL_INVALID');
    const ids = new Set();
    for (const row of stored.rows) {
      if (!row || !/^[a-f0-9]{64}$/.test(row.id) || ids.has(row.id) || !states.includes(row.state)
          || !Number.isFinite(row.nextReadAt) || !Number.isFinite(row.updatedAt)) fail('TASK_JOURNAL_INVALID');
      const checked = descriptor({ action: 'watch', ...row.task }, defaultTargetDeviceId);
      if (canonicalAgentIntent(checked) !== canonicalAgentIntent(row.task)
          || row.id !== sha256Text(canonicalAgentIntent([scope, row.task.targetDeviceId, row.task.taskId, row.task.path]))) fail('TASK_JOURNAL_INVALID');
      if (['ready', 'announced'].includes(row.state)) {
        if (!row.observation || JSON.stringify(row.observation).length > 60000) fail('TASK_JOURNAL_INVALID');
        const observation = snapshotTaskObservation(row.observation);
        if (observation.id !== row.id || observation.scope !== scope || observation.kind !== 'api-task-result'
            || !row.task.terminalValues.includes(observation.status)
            || canonicalAgentIntent(observation.body?.task) !== canonicalAgentIntent(row.task)) fail('TASK_JOURNAL_INVALID');
      }
      if (row.summary !== undefined && (typeof row.summary !== 'string' || !row.summary.trim() || row.summary.length > 16000)) fail('TASK_JOURNAL_INVALID');
      if (row.state === 'announced' && !row.summary) fail('TASK_JOURNAL_INVALID');
      ids.add(row.id);
    }
    return copy(stored);
  }
  function save(value) {
    if (!current()) fail('TASK_SCOPE_CHANGED');
    storage.setStorageSync(key, value);
    if (canonicalAgentIntent(storage.getStorageSync(key)) !== canonicalAgentIntent(value)) fail('TASK_SAVE_UNCONFIRMED');
  }
  const initial = load(); save({ ...initial, ownerId });
  function state() {
    if (!current()) fail('TASK_SCOPE_CHANGED');
    const value = load(); if (value.ownerId !== ownerId) fail('TASK_SCOPE_CHANGED');
    return value;
  }
  function update(id, change) {
    const value = state(), row = value.rows.find(row => row.id === id);
    if (!row) fail('TASK_NOT_FOUND');
    change(row); row.updatedAt = now(); save(value); return copy(row);
  }
  const summary = row => ({ id: row.id, task: row.task, state: row.state, lastError: row.lastError || '',
    status: row.observation?.status, summaryAvailable: Boolean(row.summary) });
  return Object.freeze({ scope,
    handleToolCall(event) {
      if (event?.isComplete !== true) return Promise.resolve({ ignored: true });
      let args;
      try {
        const encoded = typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.arguments);
        if (typeof encoded !== 'string' || encoded.length > 8192) fail('TASK_ARGUMENTS_INVALID');
        args = JSON.parse(encoded);
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('TASK_ARGUMENTS_INVALID');
      } catch (_) { return Promise.reject(new Error('TASK_ARGUMENTS_INVALID')); }
      return Promise.resolve().then(() => {
        const value = state(); let result;
        if (args.action === 'watch') {
          const task = descriptor(args, defaultTargetDeviceId);
          const id = sha256Text(canonicalAgentIntent([scope, task.targetDeviceId, task.taskId, task.path]));
          let row = value.rows.find(row => row.id === id);
          if (row && canonicalAgentIntent(row.task) !== canonicalAgentIntent(task)) fail('TASK_WATCH_CONFLICT');
          if (!row) {
            if (value.rows.filter(row => ['watching', 'ready'].includes(row.state)).length >= 16) fail('TASK_WATCH_FULL');
            // Only old, already-announced/stopped read subscriptions retire.
            // This never deletes API mutation identities or backend task state.
            const retained = value.rows.filter(row => ['announced', 'stopped'].includes(row.state));
            if (retained.length >= 32) value.rows.splice(value.rows.indexOf(retained[0]), 1);
            row = { id, task, state: 'watching', nextReadAt: now(), updatedAt: now() };
            value.rows.push(row); save(value);
          }
          result = summary(row);
        } else {
          const allowed = args.action === 'list' ? ['action'] : ['action', 'id'];
          if (Object.keys(args).some(key => !allowed.includes(key))) fail('TASK_ARGUMENTS_INVALID');
          if (args.action === 'list') result = { records: value.rows.map(summary) };
          else if (args.action === 'read' || args.action === 'stop') {
            if (typeof args.id !== 'string') fail('TASK_ARGUMENTS_INVALID');
            const row = value.rows.find(row => row.id === args.id); if (!row) fail('TASK_NOT_FOUND');
            result = args.action === 'read' ? row : update(args.id, row => { row.state = 'stopped'; });
          } else fail('TASK_ARGUMENTS_INVALID');
        }
        return { result: { structuredContent: { ok: true, data: result } } };
      });
    },
    async poll() {
      if (polling || !current()) return;
      polling = true;
      try {
        for (const candidate of state().rows.filter(row => row.state === 'watching' && row.nextReadAt <= now())) {
          const latest = state().rows.find(row => row.id === candidate.id);
          if (latest?.state !== 'watching') continue;
          // Persist the next read boundary before IO; this is never a business write.
          update(candidate.id, row => { row.nextReadAt = now() + row.task.intervalMs; });
          let result;
          try { result = await read({ method: 'GET', path: candidate.task.path, targetDeviceId: candidate.task.targetDeviceId }); }
          catch (_) { if (current()) update(candidate.id, row => { row.lastError = 'TASK_READ_UNCONFIRMED'; }); continue; }
          if (!current()) return;
          if (state().rows.find(row => row.id === candidate.id)?.state !== 'watching') continue;
          try {
            const receipt = result?.structuredContent;
            if (receipt?.ok !== true || receipt.uncertain || result.isError) fail('TASK_READ_UNCONFIRMED');
            const status = select(receipt.data, candidate.task.statusPointer);
            if (!scalar(status)) fail('TASK_STATUS_INVALID');
            if (!candidate.task.terminalValues.includes(status)) { update(candidate.id, row => { row.lastError = ''; }); continue; }
            const observation = { id: candidate.id, scope, kind: 'api-task-result', status,
              body: { task: candidate.task, result: select(receipt.data, candidate.task.resultPointer) } };
            if (JSON.stringify(observation).length > 60000) fail('TASK_RESULT_LIMIT');
            update(candidate.id, row => { row.state = 'ready'; row.observation = observation; row.lastError = ''; });
          } catch (error) {
            if (current()) update(candidate.id, row => { row.lastError = ['TASK_STATUS_FIELD_MISSING', 'TASK_STATUS_INVALID', 'TASK_RESULT_LIMIT'].includes(error?.code) ? error.code : 'TASK_READ_UNCONFIRMED'; });
          }
        }
      } finally { polling = false; if (current()) onStatus(); }
    },
    pending() { return state().rows.filter(row => row.state === 'ready'); },
    saveSummary(id, text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) fail('TASK_SUMMARY_INVALID');
      return update(id, row => { if (row.state !== 'ready') fail('TASK_STATE_CHANGED'); row.summary = text; });
    },
    receipts: {
      has(_scope, id) { if (_scope !== scope) fail('TASK_SCOPE_CHANGED'); return state().rows.some(row => row.id === id && ['announced', 'stopped'].includes(row.state)); },
      acknowledge(_scope, id) {
        if (_scope !== scope) fail('TASK_SCOPE_CHANGED');
        update(id, row => {
          if (row.state === 'stopped') return; // Retire a queued observation explicitly stopped by its owner.
          if (row.state !== 'ready' || !row.summary) fail('TASK_STATE_CHANGED'); row.state = 'announced';
        });
        return true;
      }
    },
    dispose() { closed = true; }
  });
}
