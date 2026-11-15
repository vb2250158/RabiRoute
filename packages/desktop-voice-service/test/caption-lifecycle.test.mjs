import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createResidentHost} from '../src/assistant-host.mjs';
import {initialAssistantSettings} from '../src/assistant-settings.mjs';

function fixture(overrides={},configureResult){
 let config={...initialAssistantSettings(),electronExecutable:process.execPath,asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture',...overrides};
 const events=[];let output,handlers;
 const host=createResidentHost({settings:()=>config,saveSettings:async patch=>{config={...config,...patch}},
   credentials:{describe:async()=>({configured:true})},
   conversation:()=>({open:async()=>events.push('conversation-open'),getSessionId:()=>null,close(){}}),
   observeOutput:observer=>{output=observer.onText;return()=>{}},
   createProviders:()=>({createAsr:()=>({createRound:value=>{handlers=value;return{}},start:()=>{events.push('asr-start');handlers.onStart?.()},stop:()=>events.push('asr-stop')}),synthesize:async()=>Buffer.alloc(2)}),
   deviceFactory:async()=>{events.push('device-open');return {
     close:async()=>events.push('device-close'),
     configurePresenter:async settings=>{events.push({configure:settings.enabled});return configureResult?configureResult(settings):{visible:settings.enabled,bounds:{x:20,y:20,width:720,height:150}}},
     present:async value=>events.push({present:value.text}),
     enumerateDevices:async()=>[{id:'fixture',kind:'audioinput'}],
   }},
 });return {host,events,output:value=>output(value)};
}

test('saving captions opens a desktop window with voice stopped and no model or microphone use',async()=>{
 const {host,events}=fixture();try{
   await host.command({action:'settings',patch:{captionsEnabled:true}});
   assert.equal(events.filter(e=>e==='device-open').length,1);
   assert.ok(events.some(e=>e.configure===true));
   assert.equal((await host.state()).voice.phase,'stopped');
   assert.equal(events.includes('conversation-open'),false);assert.equal(events.includes('asr-start'),false);
   assert.equal((await host.state()).caption.status,'visible');
 }finally{await host.dispose()}
 assert.equal(events.filter(e=>e==='device-close').length,1);
});

test('caption-only, voice and diagnostics reuse one device and stopping voice keeps captions alive',async()=>{
 const {host,events,output}=fixture();try{
   await host.command({action:'settings',patch:{captionsEnabled:true}});
   assert.equal((await host.command({action:'devices'})).length,1);
   await host.command({action:'start'});assert.ok(events.includes('asr-start'));
   await host.command({action:'stop'});assert.ok(events.includes('asr-stop'));
   assert.equal(events.filter(e=>e==='device-open').length,1);assert.equal(events.includes('device-close'),false);
   output({text:'停止语音后的文字回复'});await delay(70);
   assert.ok(events.some(e=>e.present==='停止语音后的文字回复'));
   await host.command({action:'settings',patch:{captionsEnabled:false}});
   assert.equal(events.filter(e=>e==='device-close').length,1);
   assert.equal((await host.state()).caption.status,'hidden');
 }finally{await host.dispose()}
 assert.equal(events.filter(e=>e==='device-close').length,1);
});

test('startup restores saved captions and the caption test does not create conversation messages',async()=>{
 const {host,events}=fixture({captionsEnabled:true});try{
   await host.initialize();assert.equal(events.filter(e=>e==='device-open').length,1);
   await host.command({action:'test-captions'});
   assert.ok(events.some(e=>e.present==='这是一条测试字幕。'));
   assert.ok((await host.state()).caption.lastTestAt);
   assert.equal(events.includes('conversation-open'),false);assert.equal(events.includes('asr-start'),false);
 }finally{await host.dispose()}
});

test('an invisible native window is reported as failure and can retry without opening another device',async()=>{
 let visible=false;const {host,events}=fixture({},settings=>({visible:settings.enabled&&visible}));try{
  await assert.rejects(host.command({action:'settings',patch:{captionsEnabled:true}}),/CAPTION_WINDOW_NOT_VISIBLE/);
  assert.equal((await host.state()).caption.status,'failed');
  visible=true;await host.command({action:'test-captions'});
  assert.equal((await host.state()).caption.status,'visible');assert.equal(events.filter(e=>e==='device-open').length,1);
 }finally{await host.dispose()}
});
test('failed diagnostic release stays failed on repeated close and host disposal',async()=>{
 const config={...initialAssistantSettings(),electronExecutable:process.execPath};let closes=0;
 const host=createResidentHost({settings:()=>config,saveSettings:async()=>{},credentials:{describe:async()=>({configured:true})},
  conversation:()=>({getSessionId:()=>null,close(){}}),observeOutput:()=>()=>{},
  deviceFactory:async()=>({enumerateDevices:async()=>[],close:async()=>{closes++;throw Error('PROCESS_CLEANUP_UNCONFIRMED')}})});
 await assert.rejects(host.command({action:'devices'}),/PROCESS_CLEANUP_UNCONFIRMED/);
 await assert.rejects(host.command({action:'devices'}),/ASSISTANT_DEVICE_CLEANUP_UNCONFIRMED/);
 await assert.rejects(host.command({action:'start'}),/ASSISTANT_DEVICE_CLEANUP_UNCONFIRMED/);
 await assert.rejects(host.dispose(),/ASSISTANT_CLEANUP_UNCONFIRMED/);
 assert.ok(closes>=1);
});
