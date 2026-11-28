import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSettingsStore } from '../src/settings-store.mjs';

test('legacy model hotwords become one dictionary across provider changes and reloads', async () => {
  const directory = await mkdtemp(join(tmpdir(),'assistant-dictionary-fixture-'));
  const file = join(directory,'settings.json');
  const read = async () => JSON.parse(await readFile(file,'utf8'));
  try {
    const legacy = {
      version:1, encrypted:{},
      settings:{asrHotwords:' Rabi \r\n ', speechProfiles:{asr:{
        volcengine:{asrHotwords:'ＲＡＢＩ\n专业词'}, 'volcengine::bigmodel':{asrHotwords:'工作流'},
      }}},
    };
    await writeFile(file,JSON.stringify(legacy));
    const store = await openSettingsStore(directory);
    assert.deepEqual(await read(),legacy);
    assert.equal(store.read().asrDictionary,'Rabi\n专业词\n工作流');
    await store.saveBatch([{asrMode:'volcengine'},{asrModel:'bigmodel-1.0'},{asrMode:'compatible'}]);
    const reopened = await openSettingsStore(directory);
    assert.equal(reopened.read().asrDictionary,'Rabi\n专业词\n工作流');
    assert.ok(!JSON.stringify(await read()).includes('asrHotwords'));
    await assert.rejects(reopened.save({asrDictionary:'x'.repeat(16385)}),/SETTINGS_INVALID/);
    assert.equal((await read()).settings.asrDictionary,'Rabi\n专业词\n工作流');
    await reopened.save({asrHotwords:'旧客户端写入'});
    assert.equal((await read()).settings.asrDictionary,'旧客户端写入');
    await reopened.save({asrDictionary:''});
    assert.equal((await openSettingsStore(directory)).read().asrDictionary,'');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

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

test('named model services preserve legacy credentials and isolate keys at the same API endpoint', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'assistant-model-services-'));
  const protector={protect:async value=>Buffer.from(value).toString('base64'),unprotect:async value=>Buffer.from(value,'base64').toString()};
  const fixtureSecrets=Array.from({length:3},()=>`generated-test-value-${randomUUID()}`);
  const [legacySecret,firstSecret,secondSecret]=fixtureSecrets;
  try {
    const store=await openSettingsStore(directory,protector);
    const endpoint='https://voice.example.test/v1/chat/completions';
    await store.save({llmModel:'existing',llmEndpoint:endpoint});
    await store.credentials.set('llm',endpoint,legacySecret,'compatible');
    assert.equal(await store.modelServices.resolve('saved-llm'),legacySecret);
    const base={kind:'llm',provider:'compatible',endpoint,model:'example'};
    const [one,two]=await Promise.all([
      store.modelServices.save({...base,name:'First',apiKey:firstSecret}),
      store.modelServices.save({...base,name:'Second',apiKey:secondSecret}),
    ]);
    assert.notEqual(one.id,two.id);
    assert.equal(await store.modelServices.resolve(one.id),firstSecret);
    assert.equal(await store.modelServices.resolve(two.id),secondSecret);
    await store.modelServices.save({...one,name:'Renamed'});
    assert.equal(await store.modelServices.resolve(one.id),firstSecret);
    await store.modelServices.save({...one,endpoint:'https://new.example.test/v1/chat/completions'});
    assert.equal(await store.modelServices.resolve(one.id),undefined);
    const reopened=await openSettingsStore(directory,protector);
    assert.equal(await reopened.modelServices.resolve(two.id),secondSecret);
    assert.equal(await reopened.modelServices.resolve('saved-llm'),legacySecret);
    assert.deepEqual(Object.keys(reopened.modelServices.definitions()).sort(),['asr','image','llm','search','speaker','tts','video']);
    assert.doesNotMatch(JSON.stringify(reopened.modelServices.list()),/generated-test-value-/);
    assert.doesNotMatch(await readFile(join(directory,'settings.json'),'utf8'),/generated-test-value-/);
  }finally{await rm(directory,{recursive:true,force:true})}
});
