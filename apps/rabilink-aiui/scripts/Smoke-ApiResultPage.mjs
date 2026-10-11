import test from 'node:test';
import assert from 'node:assert/strict';
import { apiResultPageMethods } from '../utils/api-result-page.js';
test('generic result surface supports unbound authenticated devices without a role catalog', async () => {
  let scope = 'one'; const spoken = [];
  const page = { ...apiResultPageMethods, data: {}, deviceAgentProfile: null, rabiApiConfig: () => ({ token: 'synthetic' }), agentProfileScope: () => scope,
    setData(patch) { Object.assign(this.data,patch); }, speakText(text) { spoken.push(text); }, cleanupChatModel() { this.cleaned = true; } };
  await page.refreshApiTools(); assert.match(page.data.knowledgeToolStatus,/HTTP 中转/);
  page.deviceAgentTurnActive = true; page.applyPendingApiTools(); assert.equal(page.cleaned,undefined);
  page.deviceAgentTurnActive = false; page.applyPendingApiTools(); assert.equal(page.cleaned,true);
  page.knowledgeResultView = { api: true, scope, confirmed: true, pages: ['实际结果'], index: 0 };
  assert.equal(page.browseKnowledgeResultFromSpeech('读出工具结果'),true); assert.match(spoken[0],/实际结果/);
  scope = 'two'; page.browseKnowledgeResultFromSpeech('读出工具结果'); assert.equal(spoken.length,1); assert.equal(page.knowledgeResultView,null);
  assert.equal(Object.hasOwn(apiResultPageMethods,'selectKnowledgeRoleFromSpeech'),false);
});
