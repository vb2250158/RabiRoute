import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeHttpAdapter } from '../lib/knowledge-http-client.mjs';
import { startKnowledgeHttpServer } from '../lib/knowledge-http-server.mjs';
import { createKnowledgeTools } from '../lib/knowledge-tools.mjs';
test('official client reaches real HTTP MCP and rejects argument override', async () => {
  let calls = 0;
  const tools = createKnowledgeTools({allowedRoles:['example'], client:{async invoke(){calls++;return {status:200,body:{code:0,data:[]},headers:{}};}}});
  const token = 'fixture-only-not-a-real-secret-123456789';
  const server = await startKnowledgeHttpServer({tools,token});
  try {
    const config = {url:server.address,token};
    const listed = await knowledgeHttpAdapter.request(config,{operation:'list'});
    assert.equal(listed.tools.length,6);
    await knowledgeHttpAdapter.request(config,{operation:'call',name:'plan_list',args:{roleId:'example'}});
    assert.equal(calls,1);
    assert.throws(()=>knowledgeHttpAdapter.validate('plan_list',{roleId:'example',url:'https://example.invalid'}));
    assert.equal(calls,1);
    await assert.rejects(knowledgeHttpAdapter.request({...config,token:'bad-token'.repeat(5)},{operation:'list'}));
  } finally { await server.close(); }
});
