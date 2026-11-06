import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDeviceAgentThreadRequest, type DeviceAgentThreadsOptions } from './deviceAgentThreads.js';

test('device thread discovery retains actual identity while sends use the common endpoint ledger', async () => {
  let scope = 'scope-a';
  const owner = { sessions: () => [{ agentId: 'eye-a', sessionId: 'session-a', name: 'Test device', loaded: true, ownerEpoch: 'epoch-a', updatedAt: '2026-10-10T00:00:00.000Z' }], readSession: () => ({ sessionId: 'session-a', deliveries: [] }) };
  const options = { ownerInstanceId: 'pc-a', scope: () => scope, owner } as unknown as DeviceAgentThreadsOptions;
  const list = await handleDeviceAgentThreadRequest({ agentAdapter: 'deviceAgent', action: 'list' }, {}, options);
  assert.equal(list?.statusCode, 200); assert.equal(list?.data.total, 1);
  assert.deepEqual((list?.data.threads as any[])[0].instanceBinding, { instanceId: 'pc-a', agentId: 'eye-a' });
  const base = { agentAdapter: 'deviceAgent' as const, instanceBinding: { instanceId: 'pc-a', agentId: 'eye-a' }, threadId: 'session-a', action: 'send' as const, deliveryId: 'original', prompt: 'test', messageSource: { type: 'system' as const, eventType: 'fixture', eventName: 'Fixture', eventId: 'original' } };
  assert.equal(await handleDeviceAgentThreadRequest({...base,responsePolicy:'required'}, {}, options),undefined);
  assert.equal(await handleDeviceAgentThreadRequest({...base,instanceBinding:{instanceId:'pc-b',agentId:'eye-a'}}, {}, options),undefined);
  assert.equal(await handleDeviceAgentThreadRequest({...base,action:'reconcile_delivery'}, {}, options),undefined);
  await assert.rejects(handleDeviceAgentThreadRequest({ ...base, action:'read',threadId:'wrong' }, {}, options), /DEVICE_AGENT_SESSION_NOT_FOUND/);
  scope = ''; await assert.rejects(handleDeviceAgentThreadRequest({agentAdapter:'deviceAgent',action:'list'}, {}, options), /DEVICE_AGENT_CONNECTION_REQUIRED/);
});

test('device thread ingress rechecks admission before handing send to the shared ledger', async () => {
  const options = { ownerInstanceId: 'pc-a', scope: () => 'scope-a', owner: { sessions: () => [] } } as unknown as DeviceAgentThreadsOptions;
  await assert.rejects(handleDeviceAgentThreadRequest({ agentAdapter:'deviceAgent',action:'send' }, {requestAuthority:()=>{throw new Error('REVOKED');}}, options), /REVOKED/);
});
