import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAssistantSettings, patchAssistantSettings } from '../src/assistant-settings.mjs';
import { modelCredentialRef, listProviderModels } from '../src/model-providers.mjs';
import { createChatModel } from '../src/chat-model.mjs';

test('WorkBuddy and compatible settings restore independently while speech changes survive', () => {
  let settings = initialAssistantSettings({overrides:{llmModel:'original'}});
  settings = patchAssistantSettings(settings,{llmProvider:'workbuddy-cn',asrMode:'volcengine',persona:'fixture'});
  assert.equal(settings.llmEndpoint,'http://127.0.0.1:18088/v1/chat/completions');
  assert.equal(settings.llmModel,'');
  assert.equal(settings.asrMode,'volcengine');
  assert.equal(settings.asrModel,'bigmodel');
  settings = patchAssistantSettings(settings,{llmModel:'from-gateway'});
  settings = patchAssistantSettings(settings,{llmProvider:'compatible'});
  assert.equal(settings.llmModel,'original');
  assert.equal(settings.persona,'fixture');
  settings = patchAssistantSettings(settings,{llmProvider:'workbuddy-cn'});
  assert.equal(settings.llmModel,'from-gateway');
  assert.notEqual(modelCredentialRef('compatible',settings.llmEndpoint),modelCredentialRef('workbuddy-cn',settings.llmEndpoint));
  assert.throws(()=>patchAssistantSettings(settings,{llmEndpoint:'https://example.com/v1/chat/completions'}),/LOCAL_GATEWAY_REQUIRED/);
});

test('catalog keeps gateway origin, disables redirects and deduplicates returned models', async () => {
  let calls=0;
  const models=await listProviderModels({kind:'llm',provider:'workbuddy-cn',endpoint:'http://127.0.0.1:18088/v1/chat/completions',resolveCredential:async()=> 'fixture-gateway-key',
    fetcher:async(url,options)=>{
      calls++;assert.equal(url.href,'http://127.0.0.1:18088/v1/models');
      assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'Bearer fixture-gateway-key');
      return Response.json({data:[{id:'a',name:'Model A'},{id:'a',name:'Model A'},{id:'b'},{}]});
    }});
  assert.equal(calls,1);assert.deepEqual(models.map(m=>m.id),['b','a']);
});

test('CLI keys never reach OpenAI through catalogs or chat', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;throw Error('UNEXPECTED_NETWORK')};
  await assert.rejects(listProviderModels({kind:'llm',provider:'compatible',endpoint:'https://api.openai.com/v1/chat/completions',resolveCredential:async()=> 'ck_fixture',fetcher}),/CREDENTIAL_PROVIDER_MISMATCH/);
  const model=createChatModel({endpoint:'https://api.openai.com/v1/chat/completions',model:'fixture',resolveCredential:async()=> 'ck_fixture',fetcher});
  await assert.rejects(model.promptStreaming([{role:'user',content:'fixture'}]),/CREDENTIAL_PROVIDER_MISMATCH/);
  model.destroy();assert.equal(calls,0);
});

test('catalog rejects unsupported services and insecure remote endpoints before credential resolution', async () => {
  let calls=0;const resolveCredential=async()=>{calls++;return 'fixture'};
  for(const args of [{kind:'tts',provider:'volcengine',endpoint:'wss://example.com'},{kind:'asr',provider:'compatible',endpoint:'http://example.com/v1/audio/transcriptions'}]){
    await assert.rejects(listProviderModels({...args,resolveCredential}));
  }
  assert.equal(calls,0);
});
