import test from 'node:test';
import assert from 'node:assert/strict';
import { createRabiLinkKnowledgeBridge } from './rabiLinkKnowledgeBridge.js';
const meta = { appId: 'app', deviceBindingId: 'device', ownerAccountId: 'owner', targetDeviceId: 'pc' };
const policy = { enabled: true, url: 'http://127.0.0.1:12345/mcp', token: 'x'.repeat(40), allowedRoles: ['role'], allowedTools: ['plan_get','plan_create','memory_get'] };
test('denied requests do not reach transport', async () => {
  let calls = 0;
  const adapter = { validate(_name: string, args: Record<string, unknown>) { if ('url' in args) throw Error('schema'); }, async request() { calls++; return {}; } };
  const bridge = createRabiLinkKnowledgeBridge(policy, adapter);
  for (const value of [{operation:'call',name:'plan_get',args:{roleId:'other'}}, {operation:'call',name:'plan_create',args:{roleId:'role'}}, {operation:'call',name:'memory_get',args:{roleId:'role',kind:'recent'}}, {operation:'call',name:'plan_get',args:{roleId:'role',url:'https://example.invalid'}}, {operation:'call',name:'unknown',args:{roleId:'role'}}]) await assert.rejects(bridge.execute(meta, value));
  await assert.rejects(createRabiLinkKnowledgeBridge({}, adapter).execute(meta, {operation:'list'}));
  assert.equal(calls, 0);
  for (const url of ['http://localhost:12345/mcp','http://127.0.0.1:12345/mcp?q=1','http://user@127.0.0.1:12345/mcp','https://127.0.0.1:12345/mcp']) assert.throws(() => createRabiLinkKnowledgeBridge({...policy,url},adapter));
});
test('writes require stable key, transport uncertainty never retries', async () => {
  let calls = 0;
  const bridge = createRabiLinkKnowledgeBridge({...policy,allowWrites:true}, {validate(){},async request(){calls++;throw Error('secret transport error');}});
  await assert.rejects(bridge.execute(meta,{operation:'call',name:'plan_create',args:{roleId:'role'}}));
  assert.equal(calls,0);
  const result = await bridge.execute(meta,{operation:'call',name:'plan_create',args:{roleId:'role',idempotencyKey:'stable-key'}});
  assert.deepEqual(result,{ok:false,uncertain:true,code:'KNOWLEDGE_OUTCOME_UNCERTAIN'});
  assert.equal(calls,1);
});
