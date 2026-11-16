import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandaloneConversation } from '../src/conversation.mjs';
import { createChatModel } from '@rabilink/desktop-voice-service/chat-model';
import {initialAssistantSettings} from '@rabilink/desktop-voice-service/settings';

test('an uncertain native tool receipt remains visible as an unresolved operation after the model finishes',async()=>{
 const errors=[];let step=0;
 const native=createStandaloneConversation({settings:()=>({...initialAssistantSettings(),llmModel:'fixture'}),credentials:{resolve:async()=>undefined},onError:error=>errors.push(error.message),discoverTools:async()=>({tools:[{type:'function',function:{name:'native_write',description:'fixture',parameters:{type:'object'}}}],executeTool:async()=>({ok:false,mutation:true,uncertain:true,error:'ORIGINAL_UNKNOWN'}),toolPolicy:{classify:()=>({mutation:true}),inspectOutcome:()=>({uncertain:true,failed:true,terminal:false})},dispose:async()=>{}}),createModel:options=>createChatModel({...options,fetcher:async(_url,request)=>{
  const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content),content=step++===0?JSON.stringify({protocol:'assistant-agent/v1',requestId:input.requestId,kind:'tool',name:'native_write',arguments:{}}):'结果未确认，没有重发。';
  return new Response('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n');
 }})});try{await native.submit('fixture','uncertain-receipt');await native.drain();assert.equal(native.activity().status,'failed');assert.equal(native.activity().error,'ASSISTANT_TOOL_OUTCOME_UNCONFIRMED');assert.deepEqual(errors,['ASSISTANT_TOOL_OUTCOME_UNCONFIRMED']);assert.equal(step,2);}finally{native.close();await native.drain()}
});

test('caption changes preserve multi-turn model context and accepted request IDs do not resend', async () => {
  let settings = { persona: '测试助手', llmEndpoint: 'https://example.com/chat/completions', llmModel: 'fixture', captionFontSize: 24 };
  const requests = []; let modelCount = 0;
  const native = createStandaloneConversation({ settings: () => settings, credentials: { resolve: async () => undefined }, onError: error => { throw error; },
    createModel: options => { modelCount++; return createChatModel({ ...options, fetcher: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '已收到。' } }] }) + '\n\ndata: [DONE]\n\n');
    } }); },
  });
  try {
    await native.submit('第一句话', 'first'); await native.drain();
    await native.submit('第二句话', 'second'); await native.drain();
    settings = { ...settings, captionFontSize: 32 };
    assert.deepEqual(native.configure(), { applied: false, deferred: false });
    await native.submit('第三句话', 'third'); await native.drain();
    await native.submit('第三句话', 'third'); await native.drain();
    assert.equal(modelCount, 1); assert.equal(requests.length, 3);
    assert.ok(JSON.stringify(requests[2].messages).includes('第一句话'));
    assert.ok(JSON.stringify(requests[2].messages).includes('第二句话'));
    assert.equal(native.messages().filter(item => item.role === 'assistant').length, 3);
  } finally { native.close(); await native.drain(); }
});

test('one model generation carries expression and prose separately without rebuilding chat for voice preferences',async()=>{
 let settings={...initialAssistantSettings(),persona:'活泼开朗的助手',llmModel:'fixture',ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral',ttsDynamicExpression:true};
 const requests=[],speech=[],prose=[];let modelCount=0;
 const native=createStandaloneConversation({settings:()=>settings,credentials:{resolve:async()=>undefined},onError:error=>{throw error},
   createModel:options=>{modelCount++;return createChatModel({...options,fetcher:async(_url,request)=>{
     requests.push(JSON.parse(request.body));const deltas=['<voice style="轻快自然" rate="1.1"/>','你好','，我在。'];return new Response(deltas.map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n').join('')+'data: [DONE]\n\n');
   }})}});
 native.observe({voice:{getState:()=>({phase:'running'}),beginResponse:()=>({setSpeech:value=>speech.push(value),append:value=>prose.push(value),finish(){}})},onText(){}});
 try{
   await native.submit('你好','expression-one');await native.drain();
   assert.equal(requests.length,1);assert.deepEqual(speech[0],{expression:{style:'轻快自然',rate:1.1}});assert.equal(prose.join(''),'你好，我在。');
   assert.equal(native.messages().at(-1).text,'你好，我在。');assert.ok(!native.messages().at(-1).text.includes('<voice'));
   assert.equal(JSON.parse(requests[0].messages.at(-1).content).speechCapabilities.enabled,true);
   settings={...settings,ttsVoice:'marin',ttsSpeed:1.25};assert.deepEqual(native.configure(),{applied:false,deferred:false});
   await native.submit('第二句','expression-two');await native.drain();assert.equal(modelCount,1);assert.equal(requests.length,2);assert.ok(JSON.stringify(requests[1].messages).includes('你好'));
 }finally{native.close();await native.drain()}
});
import {asrMessageDetails} from '@rabilink/desktop-voice-service/speech-details';
test('semantic ASR results reach model context while transport details stay out of prompts and normal polling',async()=>{
 let settings={...initialAssistantSettings(),llmModel:'fixture',asrMode:'volcengine',asrEnableEmotionDetection:true};const requests=[];
 const native=createStandaloneConversation({settings:()=>settings,credentials:{resolve:async()=>undefined},onError:error=>{throw error},createModel:options=>createChatModel({...options,fetcher:async(_url,request)=>{requests.push(JSON.parse(request.body));return new Response('data: '+JSON.stringify({choices:[{delta:{content:'收到。'}}]})+'\n\ndata: [DONE]\n\n')}})});
 try{
  const details=asrMessageDetails(settings,{providerDetails:{request:{enable_emotion_detection:true},result:{text:'你好',additions:{emotion:'happy',emotion_score:'0.88'}}}});
  await native.submit('你好','voice-msg',{source:'speech',details});await native.drain();
  assert.equal(native.messages()[0].hasDetails,true);assert.equal(native.messages()[0].details,undefined);
  assert.equal(native.messageDetails('voice-msg').result.additions.emotion,'happy');const input=JSON.parse(requests[0].messages.at(-1).content);assert.equal(input.text,'你好');assert.equal(input.speechObservation.estimates.emotion,'happy');assert.equal(input.speechObservation.estimates.emotion_score,'0.88');assert.ok(!JSON.stringify(requests).includes('enable_emotion_detection'));assert.ok(!JSON.stringify(native.messages()).includes('emotion_score'));
  const reply='reply-voice-msg';for(const stage of ['sent','accepted'])native.recordSpeechDetails(reply,{type:'request',requestId:'1:1',stage,provider:'volcengine',model:'seed-tts-2.0',parameters:{speaker:'voice',headers:{authorization:'private'},audio_params:{speech_rate:-5}}});
  native.recordSpeechDetails(reply,{type:'playback',status:'cancelled'});
  const sent=native.messageDetails(reply);assert.equal(sent.requestCount,1);assert.equal(sent.requests[0].stage,'accepted');assert.equal(sent.playback.status,'cancelled');assert.ok(!JSON.stringify(sent).includes('private'));assert.ok(!JSON.stringify(native.messages()).includes('speech_rate'));
  assert.throws(()=>native.messageDetails('missing'),/ASSISTANT_MESSAGE_DETAILS_UNAVAILABLE/);
 }finally{native.close();await native.drain()}
});
