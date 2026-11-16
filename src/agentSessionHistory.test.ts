import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAgentThreadRequest } from './agentThreads.js';
const taskId = '019f0000-0000-7000-8000-000000000001';

test('read history calls only the selected native provider without reading metadata or sending', async () => {
  const calls: unknown[] = [];
  const history = { entries: [], nextCursor: 'next' };
  const result = await handleAgentThreadRequest({ action: 'read', agentAdapter: 'codex', threadId: taskId,
    history: { cursor: 'original', limit: 50 } }, {
    allowedWorkspaces: [],
    invokeAgentOperation: async (provider, operation, payload) => { calls.push({ provider, operation, payload }); return history as any; }
  });
  assert.deepEqual(calls, [{ provider: 'codex', operation: 'threads.history', payload: { sessionId: taskId, cursor: 'original', limit: 50 } }]);
  assert.equal(result.data.history, history);
  assert.equal(result.data.action, 'read');
});

test('missing provider history propagates its failure without invoking another owner', async () => {
  let calls = 0;
  await assert.rejects(handleAgentThreadRequest({ action: 'read', agentAdapter: 'workbuddy', threadId: taskId, history: {} }, {
    allowedWorkspaces: [], invokeAgentOperation: async () => { calls++; throw new Error('Original history unavailable'); }
  }), /Original history unavailable/);
  assert.equal(calls, 1);
});
