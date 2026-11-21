import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createResidentHost } from '../src/assistant-host.mjs';
import { initialAssistantSettings } from '../src/assistant-settings.mjs';
import { createPlaybackEchoFilter } from '../src/playback-echo.mjs';

test('resident stop and voice disable drain capture before closing the device', async () => {
  const events = [];
  const config = {...initialAssistantSettings(), electronExecutable:process.execPath,
    asrMode:'native', ttsModel:'fixture', ttsVoice:'fixture'};
  const host = createResidentHost({settings:()=>config, saveSettings:async patch=>Object.assign(config,patch),
    credentials:{describe:async()=>({configured:true})},
    conversation:()=>({open:async()=>{},getSessionId:()=>null,close:()=>{}}),
    observeOutput:()=>()=>{}, speech:()=>({catalog:async()=>({maxAudioBytes:1000})}),
    createProviders:()=>({synthesize:async()=>Buffer.alloc(2)}),
    deviceFactory:async({signal,onEvent})=>{
      onEvent({event:'capture.level',level:.25});
      let closed=false;
      const close=async()=>{closed=true;events.push('close')};
      signal.addEventListener('abort',()=>{void close()},{once:true});
      return {close,configurePresenter:async()=>{},present:async()=>{
        if(closed)throw Error('DEVICE_CLOSED');
      },createRecording:()=>{let disposal;return {start:async()=>{},amplitude:()=>0,
        dispose:()=>disposal??=(async()=>{await delay(5);if(closed)throw Error('DEVICE_CLOSED');events.push('capture-disposed')})(),
      }}};
    },
  });
  try {
    await host.command({action:'settings',patch:{voiceEnabled:false}});
    await assert.rejects(host.command({action:'start'}),{message:'ASSISTANT_VOICE_DISABLED'});
    await assert.rejects(host.startWithRecording(()=>{throw Error('WAKE_CAPTURE_LEAK')}),{message:'ASSISTANT_VOICE_DISABLED'});
    await assert.rejects(host.command({action:'resume'}),{message:'ASSISTANT_VOICE_DISABLED'});
    for(let i=0;i<2;i++) {
      await host.command({action:'settings',patch:{voiceEnabled:true}});
      assert.equal((await host.state()).voice.phase,'stopped');
      await host.command({action:'start'});
      assert.equal((await host.state()).waveform.samples.at(-1),.25);
      await host.command(i===0?{action:'settings',patch:{voiceEnabled:false}}:{action:'stop'});
      await delay(65);
      assert.equal((await host.state()).error,null);
      assert.equal((await host.state()).voice.phase,'stopped');
    }
    assert.deepEqual(events,['capture-disposed','close','capture-disposed','close']);
  } finally {await host.dispose()}
});

test('speech enters conversation once and the pet keeps a separate, temporary transcript',async()=>{
 let handlers, onText, petPresentation;const received=[];const config={...initialAssistantSettings(),electronExecutable:process.execPath,asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture'};
 const host=createResidentHost({settings:()=>config,saveSettings:async()=>{},credentials:{describe:async()=>({configured:true})},
 conversation:()=>({open:async()=>{},getSessionId:()=>null,close(){},submit:async(text,id)=>{received.push({text,id});return{accepted:true}}}),
 observeOutput:options=>{onText=options.onText;return()=>{}},
 pet:{present(_config,presentation){petPresentation=presentation},state:()=>({}),dispose:async()=>{}},
 createProviders:()=>({asrFeedback:'streaming',createAsr:()=>({createRound(value){handlers=value;return{}},start(){handlers.onStart?.()},stop(){}}),synthesize:async()=>Buffer.alloc(2)}),
 deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{}})});
 try {
   await host.command({action:'start'});
   onText({responseId:'reply',text:'桌宠的上一句'});
   handlers.onInterim({text:'临时转写'});
   assert.equal((await host.state()).inputPreview.text,'临时转写');
   assert.deepEqual(petPresentation.inputPreview,{text:'临时转写',final:false});
   assert.equal(petPresentation.text,'桌宠的上一句');
   handlers.onFinal({text:'确定的语音。'});
   await delay(0);
   assert.equal(received.length,1);
   assert.equal(received[0].text,'确定的语音。');
   assert.equal((await host.state()).inputPreview,null);
   assert.deepEqual(petPresentation.inputPreview,{text:'确定的语音。',final:true,corrected:true});
   await delay(4100);
   assert.equal(petPresentation.inputPreview,null);
   handlers.onInterim({text:'下一句'});
   await host.command({action:'pause'});
   assert.equal(petPresentation.inputPreview,null);
   await host.command({action:'resume'});
   handlers.onInterim({text:'停止前未提交'});
   assert.equal(petPresentation.inputPreview.text,'停止前未提交');
   await host.command({action:'stop'});
   assert.equal(petPresentation.inputPreview,null);
   assert.equal(received.length,1);
 } finally {await host.dispose()}
});

test('a cold local fallback keeps the wake session busy until recognition finishes', async () => {
  const config = {...initialAssistantSettings(), electronExecutable:process.execPath,
    asrMode:'volcengine', asrModel:'bigmodel', ttsModel:'fixture', ttsVoice:'fixture',
    sampleMs:10, silenceDurationMs:30};
  const entered = Promise.withResolvers(), result = Promise.withResolvers(), submitted = Promise.withResolvers();
  const activity = [];
  let frames = 0;
  const host = createResidentHost({
    settings:()=>config, saveSettings:async()=>{}, credentials:{describe:async()=>({configured:true})},
    conversation:()=>({open:async()=>{},getSessionId:()=>null,close(){},
      async submit(text){submitted.resolve(text);return {accepted:true};}}),
    observeOutput:()=>()=>{}, onCaptureActivity:hasText=>activity.push(hasText),
    createProviders:()=>({createAsr:()=>({createRound:()=>({}),start(){throw Error('REALTIME_DID_NOT_CONNECT');},stop(){}}),
      synthesize:async()=>new Uint8Array(44)}),
    deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{}}),
  });
  try {
    await host.startWithRecording(()=>{throw Error('UNEXPECTED_PRIMARY_CAPTURE');}, {fallback:{
      createRecording:()=>({start:async()=>{}, amplitude:()=>++frames<3?.5:0,
        take:async()=>new Uint8Array(44), dispose:async()=>{}}),
      recognize:async()=>{entered.resolve();return result.promise;},
    }});
    await Promise.race([entered.promise, delay(1000).then(()=>{throw Error('NO_FALLBACK_RECOGNITION');})]);
    assert.deepEqual(activity,[false]);
    assert.equal(host.captureHasWork(),true);
    result.resolve({text:'冷启动后完整转写'});
    assert.equal(await submitted.promise,'冷启动后完整转写');
    assert.deepEqual(activity,[false,true]);
    assert.equal(host.captureHasWork(),false);
  } finally {
    result.resolve(null);
    await host.dispose();
  }
});

test('historical invalid endpoint stays readable and repairable while actual start still rejects it',async()=>{
 let config={...initialAssistantSettings(),electronExecutable:process.execPath,asrMode:'compatible',asrEndpoint:'https://example.test/asr',asrModel:'fixture',ttsEndpoint:'broken',ttsModel:'fixture',ttsVoice:'fixture'};
 let devices=0;
 const host=createResidentHost({settings:()=>config,saveSettings:async patch=>{config={...config,...patch}},
   credentials:{describe:async(_kind,url)=>{new URL(url);return {configured:true}}},
   conversation:()=>({open:async()=>{},getSessionId:()=>null,close(){}}),observeOutput:()=>()=>{},
   deviceFactory:async()=>{devices++;return {close:async()=>{},configurePresenter:async()=>{},present:async()=>{},createRecording:()=>({start:async()=>{},amplitude:()=>0,dispose:async()=>{}})}}});
 try{
   const historical=await host.state();assert.equal(historical.settings.ttsEndpoint,'broken');assert.equal(historical.asrFeedback,'utterance');assert.equal(devices,0);
   await assert.rejects(host.command({action:'start'}),{code:'ERR_INVALID_URL'});assert.equal(devices,0);assert.equal((await host.state()).voice.phase,'failed');
   const repaired=await host.command({action:'settings',patch:{ttsEndpoint:'https://example.test/tts'}});assert.equal(repaired.settings.ttsEndpoint,'https://example.test/tts');
   await host.command({action:'start'});assert.equal((await host.state()).voice.capture,'listening');assert.equal(devices,1);await host.command({action:'stop'});
 }finally{await host.dispose()}
});

test('desktop playback never submits its own words and a distinct utterance can interrupt it', async () => {
  const config = {...initialAssistantSettings(), electronExecutable:process.execPath,
    asrMode:'volcengine', asrModel:'fixture', ttsModel:'fixture', ttsVoice:'fixture'};
  const submissions = [], players = [];
  const playing = [Promise.withResolvers(), Promise.withResolvers()];
  let handlers, voice;
  const host = createResidentHost({
    settings:()=>config, saveSettings:async()=>{}, credentials:{describe:async()=>({configured:true})},
    conversation:()=>({open:async()=>{}, getSessionId:()=>null, close(){},
      async submit(text){submissions.push(text);return {accepted:true};}}),
    observeOutput:options=>{voice=options.voice;return ()=>{};},
    createProviders:()=>({
      createAsr:()=>({createRound(value){handlers=value;return {};},start(){handlers.onStart();},stop(){}}),
      synthesize:async()=>new Uint8Array(44),
    }),
    deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{},
      async createPlayer(){
        const index = players.length;
        const player = {events:new EventTarget(), stops:0, async play(){playing[index].resolve();},
          async stop(){player.stops++;},async destroy(){}};
        players.push(player);
        return player;
      },
    }),
  });
  try {
    await host.startWithRecording(()=>{throw Error('UNEXPECTED_DIRECT_CAPTURE');});
    const output = voice.beginResponse({id:'reply'});
    output.append('听得到喵，很清楚。凳子旁边有一本书。');
    output.finish();
    await playing[0].promise;
    handlers.onSpeechStart();
    handlers.onInterim({text:'听'});
    assert.equal(players[0].stops,0);
    assert.equal((await host.state()).inputPreview?.text || '','');
    players[0].events.dispatchEvent(new Event('ended'));
    await playing[1].promise;
    handlers.onFinal({text:'听得到喵很清楚，凳子旁边有'});
    assert.deepEqual(submissions,[]);
    assert.equal(players[1].stops,0);
    handlers.onSpeechStart();
    handlers.onInterim({text:'等等'});
    assert.equal(players[1].stops,1);
    handlers.onFinal({text:'等等，我有个新问题。'});
    assert.deepEqual(submissions,['等等，我有个新问题。']);
  } finally {await host.dispose();}
});

test('echo matching tracks audible updates, short repeats and playback expiry', () => {
  let time = 0;
  const filter = createPlaybackEchoFilter(() => time);
  const reply = {id:1, responseId:'reply', textOffset:10};
  filter.observe({...reply, type:'synthesizing', text:'好的。'});
  assert.equal(filter.acceptTranscript('好的', 'final'),true);
  filter.observe({...reply, type:'play-requested', text:''});
  filter.observe({...reply, type:'cue', text:'好的。没有播完的尾巴', cue:{charIndex:10,charLength:2}});
  assert.equal(filter.acceptTranscript('好的', 'final'),false);
  assert.equal(filter.acceptTranscript('停', 'final'),true);
  assert.equal(filter.acceptTranscript('没有播完的尾巴', 'final'),true);
  filter.observe({...reply, type:'cancelled', text:'好的。没有播完的尾巴'});
  assert.equal(filter.acceptTranscript('好的', 'final'),false);
  time = 3000;
  assert.equal(filter.acceptTranscript('好的', 'final'),true);
});
