import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSettingsStore } from '../src/settings-store.mjs';

test('preview does not write and batch commits all model choices once without partial invalid saves',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-draft-fixture-'));
  try{
    const store=await openSettingsStore(directory),before=store.read();
    const patches=[{asrMode:'volcengine'},{asrRecognitionMode:'utterance',asrEnableAgeDetection:true},{asrModel:'bigmodel-1.0'},{asrModel:'bigmodel'}];
    const preview=store.preview(patches);
    assert.equal(preview.asrEnableAgeDetection,true);assert.equal(preview.asrRecognitionMode,'utterance');
    assert.deepEqual(store.read(),before);
    await assert.rejects(readFile(join(directory,'settings.json')),e=>e.code==='ENOENT');
    await store.saveBatch(patches);
    assert.deepEqual(store.read(),preview);
    const persisted=await readFile(join(directory,'settings.json'),'utf8');
    await assert.rejects(store.saveBatch([{asrEnableAgeDetection:false},{asrEndWindowSize:1}]),/SETTINGS_INVALID/);
    assert.equal(await readFile(join(directory,'settings.json'),'utf8'),persisted);
    for(const invalid of [null,{},[null],new Array(65).fill({}),[{speechProfiles:{}}]])assert.throws(()=>store.preview(invalid));
  }finally{await rm(directory,{recursive:true,force:true})}
});
test('queued credential save stays bound to original provider and survives reload without exposing plaintext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-secret-fixture-'));
  const protector={protect:async value=>Buffer.from(value).toString('base64'),unprotect:async value=>Buffer.from(value,'base64').toString()};
  try {
    const store=await openSettingsStore(directory,protector),endpoint=store.read().asrEndpoint;
    const pending=store.credentials.set('asr',endpoint,'fixture-asr-secret','compatible');
    await store.save({asrMode:'volcengine'});await pending;
    assert.equal(await store.credentials.resolve('asr',store.read().asrEndpoint,'volcengine'),undefined);
    assert.equal(await store.credentials.resolve('tts',store.read().ttsEndpoint,'compatible'),undefined);
    await store.save({asrMode:'compatible'});
    const next=await openSettingsStore(directory,protector);
    assert.equal(await next.credentials.resolve('asr',endpoint,'compatible'),'fixture-asr-secret');
    assert.ok(!(await readFile(join(directory,'settings.json'),'utf8')).includes('fixture-asr-secret'));
    assert.ok(!JSON.stringify(next.read()).includes('fixture-asr-secret'));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('Windows DPAPI round trip persists no plaintext', {skip:process.platform!=='win32'}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-dpapi-fixture-'));
  try {
    const store=await openSettingsStore(directory),endpoint=store.read().llmEndpoint;
    await store.credentials.set('llm',endpoint,'fixture-only-not-an-api-key','compatible');
    const document=await readFile(join(directory,'settings.json'),'utf8');
    assert.ok(!document.includes('fixture-only-not-an-api-key'));
    const reloaded=await openSettingsStore(directory);
    assert.equal(await reloaded.credentials.resolve('llm',endpoint,'compatible'),'fixture-only-not-an-api-key');
  }finally{await rm(directory,{recursive:true,force:true})}
});
