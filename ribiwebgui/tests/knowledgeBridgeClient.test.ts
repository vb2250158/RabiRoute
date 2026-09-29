import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeBridgeDraft, knowledgeBridgePatch, readKnowledgeIdentity, saveKnowledgeIdentity } from '../src/knowledgeBridgeClient.ts';
const source = { enabled: true, url: 'http://127.0.0.1:8123/mcp', allowedRoles: ['example'], allowedTools: ['plan_list'], allowWrites: false, grants: [{appId:'app',deviceBindingId:'device',ownerAccountId:'owner'}], token: 'never-copy-this-secret', tokenConfigured: true };
test('draft never hydrates token and partial patch preserves unrelated config', () => {
  const draft = knowledgeBridgeDraft(source); assert.equal(draft.token, '');
  const patch = knowledgeBridgePatch(draft, true); assert.equal('token' in patch.rabiLinkRelay.knowledgeBridge, false);
  assert.deepEqual(Object.keys(patch.rabiLinkRelay), ['knowledgeBridge']);
  assert.equal(patch.rabiLinkRelay.knowledgeBridge.allowWrites, false);
});
test('reject remote URL, masked token and unauthorized field injection', () => {
  assert.throws(() => knowledgeBridgePatch({...knowledgeBridgeDraft(source),url:'https://example.com/mcp'},true));
  assert.throws(() => knowledgeBridgePatch({...knowledgeBridgeDraft(source),token:'*'.repeat(40)},true));
  assert.throws(() => knowledgeBridgePatch({...knowledgeBridgeDraft(source),grants:'[{"appId":"a","deviceBindingId":"d","ownerAccountId":"o","token":"x"}]'},true));
});
test('GET strips leaked token and PATCH never retries unknown outcome', async () => {
  const snapshot = await readKnowledgeIdentity((async () => new Response(JSON.stringify({code:0,data:{rabiLinkRelay:{knowledgeBridge:source}}}))) as typeof fetch);
  assert.equal('token' in snapshot.bridge,false);
  let count=0;
  await assert.rejects(saveKnowledgeIdentity(knowledgeBridgePatch(knowledgeBridgeDraft(source),true),(async () => { count++; throw new Error('lost'); }) as typeof fetch));
  assert.equal(count,1);
});
test('successful PATCH still requires matching authoritative readback', async () => {
  const patch = knowledgeBridgePatch(knowledgeBridgeDraft(source),true);
  const fetcher = (saved: unknown) => (async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({code:0,data:{rabiLinkRelay:{knowledgeBridge:init?.method === 'PATCH' ? source : saved}}}))) as typeof fetch;
  await assert.rejects(saveKnowledgeIdentity(patch,fetcher({...source,allowedRoles:['other']})),/不一致/);
  const result = await saveKnowledgeIdentity(patch,fetcher(source)); assert.equal(result.tokenConfigured,true);
});
