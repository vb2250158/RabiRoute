import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelUsageStore } from '../src/model-usage-store.mjs';
import { compatibleUsage } from '../../../packages/desktop-voice-service/src/model-usage.mjs';

test('usage keeps same-name connections independent and measures cache rate only on paired fields', async t => {
  const directory = await mkdtemp(join(tmpdir(),'model-usage-fixture-'));
  const store = createModelUsageStore(join(directory,'usage.sqlite'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const first = {kind:'llm',id:'first',provider:'compatible',endpoint:'https://example.test/v1/chat/completions',model:'shared'};
  const second = {...first,id:'second'};
  assert.deepEqual(store.read(first),{requests:0,metrics:{}});
  store.record(first,compatibleUsage({prompt_tokens:120,completion_tokens:5,prompt_tokens_details:{cached_tokens:30}}));
  store.record(first,compatibleUsage({prompt_tokens:400,completion_tokens:11}));
  store.record(second,compatibleUsage({prompt_tokens:10,completion_tokens:3,prompt_tokens_details:{cached_tokens:0}}));
  store.close();
  const stats = store.read(first);
  assert.equal(stats.requests,2);
  assert.deepEqual(stats.metrics.inputTokens,{value:520,measured:2});
  assert.deepEqual(stats.metrics.cachedTokens,{value:30,measured:1});
  assert.deepEqual(stats.cacheRate,{value:.25,measured:1});
  assert.deepEqual(store.read(second).cacheRate,{value:0,measured:1});
  assert.deepEqual(store.read({...first,model:'alternate'}),{requests:0,metrics:{}});
  assert.deepEqual(store.read({...first,endpoint:'https://another.test/model'}),{requests:0,metrics:{}});
});
