import test from 'node:test';import assert from 'node:assert/strict';
import {initialAssistantSettings,patchAssistantSettings} from '../src/assistant-settings.mjs';
import {speechExpressionPolicy,resolveSpeechExpression} from '../src/tts-expression.mjs';
import {encodeVolcanoTtsParams,volcanoCatalog} from '../src/speech-catalog.mjs';
import {createSpeechProviders} from '../src/speech-providers.mjs';
import {openOpenAiTts} from '../src/openai-tts.mjs';
const config=()=>patchAssistantSettings(initialAssistantSettings(),{ttsProvider:'volcengine',ttsModel:'seed-tts-2.0',ttsVoice:'zh_female_vv_uranus_bigtts',ttsDynamicExpression:true});
test('per-reply expression follows voice capability and leaves persisted preferences untouched',()=>{
 const source=config(),snapshot=structuredClone(source),policy=speechExpressionPolicy(source);assert.ok(policy.fields.some(f=>f.id==='style'));
 const next=resolveSpeechExpression(source,{style:'轻声安慰',rate:1.2,pitch:2,voice:'other',endpoint:'https://bad.test'}),request=encodeVolcanoTtsParams(next);
 assert.deepEqual(JSON.parse(request.additions).context_texts,['轻声安慰']);assert.equal(request.audio_params.speech_rate,20);assert.equal(request.speaker,source.ttsVoice);assert.deepEqual(source,snapshot);
 const off=resolveSpeechExpression({...source,ttsDynamicExpression:false},{style:'other',rate:1.3});assert.equal(off.ttsContextText,source.ttsContextText);
 const emotional=volcanoCatalog.tts.voices.find(v=>v.model==='seed-tts-1.0'&&v.bidirectional&&v.emotions.length);
 assert.ok(emotional);const c=patchAssistantSettings(source,{ttsModel:emotional.model,ttsVoice:emotional.id});
 const p=speechExpressionPolicy(c);assert.ok(p.fields.some(f=>f.id==='emotion'));assert.ok(p.fields.some(f=>f.id==='intensity'));assert.ok(!p.fields.some(f=>f.id==='style'));
});
test('OpenAI capability distinguishes mini TTS from legacy models and custom endpoints',()=>{
 const base={...initialAssistantSettings(),ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral',ttsDynamicExpression:true};
 assert.ok(speechExpressionPolicy(base).fields.some(f=>f.id==='style'));
 assert.ok(!speechExpressionPolicy({...base,ttsModel:'tts-1'}).fields.some(f=>f.id==='style'));
 assert.equal(speechExpressionPolicy({...base,ttsEndpoint:'https://custom.test/v1/audio/speech'}).enabled,false);
});
test('OpenAI sentence PCM streams before text finish and cancellation discards pending sentences',async()=>{
 const requests=[],audio=[];let release;const waiting=new Promise(resolve=>release=resolve);
 const stream=openOpenAiTts({endpoint:'https://api.openai.com/v1/audio/speech',model:'gpt-4o-mini-tts',voice:'coral',instructions:'温柔',onAudio:bytes=>audio.push([...bytes]),fetcher:async(_url,request)=>{requests.push(JSON.parse(request.body));return new Response(new ReadableStream({async start(c){c.enqueue(new Uint8Array([1,0,2]));await waiting;c.enqueue(new Uint8Array([0]));c.close()}}))}});
 await stream.append('第一句。');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(audio,[[1,0]]);assert.equal(requests[0].instructions,'温柔');assert.equal(requests[0].response_format,'pcm');
 await stream.append('第二句。');const rejected=assert.rejects(stream.finished,/CANCELLED/);const closing=stream.close();release();await closing;await rejected;assert.equal(requests.length,1);assert.deepEqual(audio,[[1,0]]);
});
test('OpenAI transcription sends user settings and retains returned metadata',async()=>{
 const base={...initialAssistantSettings(),asrMode:'compatible',asrModel:'whisper-1',asrLanguage:'zh',asrPrompt:'Rabi',asrUseContext:false,asrWordTimestamps:true};let sent;
 const providers=createSpeechProviders({config:base,credentials:{resolve:async()=>undefined},fetcher:async(_url,request)=>{sent=request.body;return Response.json({text:'你好',words:[{word:'你好',start:0,end:.5}]})}});
 const result=await providers.recognize(new Uint8Array([1,2]),new AbortController().signal);assert.equal(sent.get('language'),'zh');assert.equal(sent.get('prompt'),'Rabi');assert.equal(sent.get('response_format'),'verbose_json');assert.equal(sent.get('timestamp_granularities[]'),'word');assert.equal(result.words.length,1);
});
test('CodeBuddy access tokens are rejected before sending either OpenAI speech request',async()=>{
 let calls=0;const config={...initialAssistantSettings(),asrMode:'compatible',asrModel:'whisper-1',ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral'};
 const providers=createSpeechProviders({config,credentials:{resolve:async()=> 'ck_test_invalid_provider'},fetcher:async()=>{calls++;throw Error('SHOULD_NOT_SEND')}});
 await assert.rejects(providers.recognize(new Uint8Array([1,2]),new AbortController().signal),/MODEL_CREDENTIAL_PROVIDER_MISMATCH/);
 await assert.rejects(providers.openSpeechStream({signal:new AbortController().signal,onAudio(){}}),/MODEL_CREDENTIAL_PROVIDER_MISMATCH/);
 assert.equal(calls,0);
});
test('OpenAI models restore independent voice, expression opt-in and ASR preferences',()=>{
 let config=patchAssistantSettings(initialAssistantSettings(),{ttsModel:'gpt-4o-mini-tts',ttsVoice:'coral',ttsSpeed:1.2,ttsDynamicExpression:true,asrModel:'whisper-1',asrLanguage:'zh',asrPrompt:'Rabi'});
 config=patchAssistantSettings(config,{ttsModel:'tts-1',ttsVoice:'alloy',ttsSpeed:.8,ttsDynamicExpression:false,asrModel:'gpt-4o-mini-transcribe',asrLanguage:'ja',asrPrompt:'other'});
 config=patchAssistantSettings(config,{ttsModel:'gpt-4o-mini-tts',asrModel:'whisper-1'});
 assert.equal(config.ttsVoice,'coral');assert.equal(config.ttsSpeed,1.2);assert.equal(config.ttsDynamicExpression,true);
 assert.equal(config.asrLanguage,'zh');assert.equal(config.asrPrompt,'Rabi');
});
