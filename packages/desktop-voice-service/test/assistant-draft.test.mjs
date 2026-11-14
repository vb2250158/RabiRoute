import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentHost } from '../src/assistant-host.mjs';
import { initialAssistantSettings, previewAssistantSettings } from '../src/assistant-settings.mjs';

test('host preview is read-only, commits once and rejects malformed batches before effects', async()=>{
  let config=initialAssistantSettings(),writes=0,configured=0,opened=0;
  const host=createResidentHost({
    settings:()=>config,
    previewSettings:patches=>previewAssistantSettings(config,patches),
    saveSettingsBatch:async patches=>{config=previewAssistantSettings(config,patches);writes++},
    saveSettings:async()=>{throw Error('UNEXPECTED_SINGLE_WRITE')},
    credentials:{describe:async(kind,endpoint,provider)=>({configured:provider==='volcengine'})},
    conversation:()=>({getSessionId:()=>null,configure:()=>configured++,close:()=>{}}),
    observeOutput:()=>()=>{},deviceFactory:async()=>{opened++;throw Error('UNEXPECTED_DEVICE')},
  });
  try{
    const before=await host.state(),patches=[{asrMode:'volcengine'},{asrEnableEmotionDetection:true}];
    const result=await host.command({action:'preview-settings',patches});
    assert.equal(result.settings.asrEnableEmotionDetection,true);
    assert.equal(result.credentials.asr.configured,true);
    assert.deepEqual(await host.state(),before);
    assert.equal(writes,0);assert.equal(configured,0);assert.equal(opened,0);
    for(const patches of [null,{},[null],Array(65).fill({}),[{speechProfiles:{}}],[{asrEndWindowSize:1}]]){
      await assert.rejects(host.command({action:'settings',patches}));
      assert.equal(writes,0);assert.equal(configured,0);
    }
    await assert.rejects(host.command({action:'settings',patches:[],patch:{}}));
    const saved=await host.command({action:'settings',patches});
    assert.equal(writes,1);assert.equal(configured,1);assert.equal(opened,0);
    assert.deepEqual(saved.settings,result.settings);
    assert.equal(saved.settingsDraft,true);
  }finally{await host.dispose()}
});
