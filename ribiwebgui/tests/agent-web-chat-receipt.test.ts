import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebChatClient } from '../../src/plugins/io.rabiroute.manager.persona/web/persona/agentWebChatClient';

const target = { key: 'original', threadId: 'workbuddy-thread',
  agent: { provider: 'workbuddy', key: 'workbuddy', id: 'local:workbuddy', routes: [] } };
const intent = { deliveryId: 'webchat-original', prompt: 'original message', webChatAttachments: [] };
const caller = '/api/agent/deliveries/caller/webchat-original';
const reconcile = '/api/agent/deliveries/agent-original/reconcile';
const uncertain = () => Response.json({ status: 'delivery_unconfirmed' }, { status: 202 });
const dispatching = () => Response.json({ data: { state: 'dispatching', deliveryId: 'agent-original' } });
const committed = (sessionId: string) => Response.json({ data: { state: 'committed', receipt: { endpoint: { sessionId } } } });

test('WorkBuddy Web chat reconciles the original receipt without resending the prompt', async () => {
  const requests: string[] = [];
  const answers = [uncertain(), dispatching(), Response.json({ data: { state: 'received' } }), committed(target.threadId)];
  const client = createAgentWebChatClient((async (url: string, init?: RequestInit) => {
    requests.push((init?.method ?? 'GET') + ' ' + url);
    if (url === reconcile) assert.equal(init?.body, '{}');
    return answers.shift()!;
  }) as typeof fetch);
  assert.deepEqual(await client.send(target, intent), { state: 'accepted' });
  assert.deepEqual(requests, ['POST /api/agent/webchat', 'GET ' + caller, 'POST ' + reconcile, 'GET ' + caller]);
});

test('querying the original receipt never treats another thread or missing evidence as accepted', async () => {
  for (const final of [committed('wrong-thread'), dispatching()]) {
    const requests: string[] = [];
    const answers = [dispatching(), Response.json({}, { status: 202 }), final];
    const client = createAgentWebChatClient((async (url: string, init?: RequestInit) => {
      requests.push((init?.method ?? 'GET') + ' ' + url);
      return answers.shift()!;
    }) as typeof fetch);
    assert.equal((await client.receipt(target, intent)).state, 'uncertain');
    assert.deepEqual(requests, ['GET ' + caller, 'POST ' + reconcile, 'GET ' + caller]);
  }
});

test('a proven prepared intent can retry and a previously committed intent needs no reconcile call', async () => {
  const answers = [Response.json({ data: { state: 'prepared', canSubmitSameIntent: true } }), committed(target.threadId)];
  const client = createAgentWebChatClient((async (url: string, init?: RequestInit) => {
    assert.equal(url, caller);
    assert.equal(init?.method, undefined);
    return answers.shift()!;
  }) as typeof fetch);
  assert.equal((await client.receipt(target, intent)).state, 'retry');
  assert.equal((await client.receipt(target, intent)).state, 'accepted');
});
