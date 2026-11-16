import test from 'node:test';import assert from 'node:assert/strict';
import {initialAssistantSettings,patchAssistantSettings} from '../src/assistant-settings.mjs';
import {encodeVolcanoAsrRequest,volcanoAsrParameters} from '../src/speech-catalog.mjs';
import {recognitionContextMessages,recognitionContextPrompt} from '../src/recognition-context.mjs';
import {createVolcanoAsr} from '../src/volcano-asr.mjs';import {decodeFrame} from '../src/volcano-codec.mjs';
import {createSpeechProviders} from '../src/speech-providers.mjs';import {createResidentHost} from '../src/assistant-host.mjs';

test('compatible recognition capabilities start enabled while sensitive filtering stays off',()=>{
 const config=initialAssistantSettings();for(const spec of volcanoAsrParameters.filter(p=>p.type==='boolean'&&p.key!=='asrSystemReservedFilter'))assert.equal(config[spec.key],true,spec.key);assert.equal(config.asrSystemReservedFilter,false);assert.equal(config.asrRecognitionMode,'twopass');assert.equal(volcanoAsrParameters.find(p=>p.key==='asrContext').owner,'system');assert.equal(volcanoAsrParameters.find(p=>p.key==='asrResultType').owner,'system');
 const request=encodeVolcanoAsrRequest(config);for(const key of ['enable_emotion_detection','enable_gender_detection','enable_age_detection','enable_lid','enable_speaker_info','show_speech_rate','show_volume'])assert.equal(request[key],true,key);assert.equal('sensitive_words_filter' in request,false);
});

test('automatic context selects only the latest assistant reply and overrides legacy manual context',()=>{
 const values=[{role:'assistant',text:'old'},{role:'user',text:'question'},{role:'assistant',text:'current'}];assert.deepEqual(recognitionContextMessages(values),[{speaker:'bot',text:'current'}]);assert.deepEqual(recognitionContextMessages([{role:'user',text:'not context'}]),[]);assert.equal(recognitionContextMessages([{role:'assistant',text:'x'.repeat(5000)}])[0].text.length,2048);
 const config={...initialAssistantSettings(),asrContext:'legacy',asrHotwords:'Rabi'};let result=encodeVolcanoAsrRequest(config,{context:values});assert.deepEqual(JSON.parse(result.corpus.context).context_data,[{speaker:'bot',text:'current'}]);result=encodeVolcanoAsrRequest(config,{context:[]});assert.equal(JSON.parse(result.corpus.context).context_data,undefined);assert.equal(recognitionContextPrompt(config,values),'Rabi\ncurrent');
});

test('Volcano sends current conversation context and enabled metadata at each new recognition connection',async()=>{
 let text='first';const requests=[];const asr=createVolcanoAsr({settings:()=>({...initialAssistantSettings(),asrModel:'bigmodel'}),recognitionContext:()=>[{role:'assistant',text}],connection:async()=>({}),connect:async()=>({send:async bytes=>requests.push(decodeFrame(bytes).data),close:async()=>{}}),createRecording:()=>({start:async()=>{},dispose:async()=>{},amplitude:()=>0})});
 for(const current of ['first','second']){text=current;const round=asr.createRound({});try{await asr.start(round)}finally{await asr.stop(round)}}assert.deepEqual(requests.map(value=>JSON.parse(value.request.corpus.context).context_data[0].text),['first','second']);assert.ok(requests.every(value=>value.request.enable_emotion_detection===true));
});

test('OpenAI utterance requests refresh automatic context without rewriting persisted preferences',async()=>{
 let text='first';const prompts=[];const config={...initialAssistantSettings(),asrMode:'compatible',asrModel:'gpt-4o-mini-transcribe'};const providers=createSpeechProviders({config,recognitionContext:()=>[{role:'assistant',text}],credentials:{resolve:async()=>undefined},fetcher:async(_url,request)=>{prompts.push(request.body.get('prompt'));assert.equal(request.body.get('include[]'),'logprobs');return new Response(JSON.stringify({text:'recognized',logprobs:[{token:'recognized',logprob:-.1}]}),{status:200})}});
 await providers.recognize(Buffer.alloc(44),new AbortController().signal);text='second';await providers.recognize(Buffer.alloc(44),new AbortController().signal);assert.deepEqual(prompts,['first','second']);assert.equal(config.asrPrompt,'');
});

test('shared host fences automatic recognition context to its current conversation',async()=>{
 let observer,context,id='first';const config={...initialAssistantSettings(),asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture',electronExecutable:process.execPath};const host=createResidentHost({settings:()=>config,saveSettings:async()=>{},credentials:{describe:async()=>({configured:true})},conversation:()=>({open:async()=>{},close(){},getSessionId:()=>id}),observeOutput:value=>{observer=value;return()=>{}},createProviders:(_config,options)=>{context=options.recognitionContext;return{createAsr:()=>({createRound:handlers=>({handlers}),start:round=>round.handlers.onStart?.(),stop(){}})}},deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{}})});
 try{await host.command({action:'start'});observer.onText({responseId:'reply',text:'current reply'});assert.deepEqual(context(),[{role:'assistant',text:'current reply'}]);id='second';assert.deepEqual(context(),[]);observer.onText({responseId:'',text:''});assert.deepEqual(context(),[])}finally{await host.dispose()}
});



test('an intentional empty context from the host never falls back to streamed assistant text',async()=>{
 let observer,context;const config={...initialAssistantSettings(),asrMode:'volcengine',asrModel:'bigmodel',ttsModel:'fixture',ttsVoice:'fixture',electronExecutable:process.execPath};const host=createResidentHost({settings:()=>config,saveSettings:async()=>{},credentials:{describe:async()=>({configured:true})},conversation:()=>({open:async()=>{},close(){},getSessionId:()=> 'session',recognitionContext:()=>[]}),observeOutput:value=>{observer=value;return()=>{}},createProviders:(_config,options)=>{context=options.recognitionContext;return{createAsr:()=>({createRound:handlers=>({handlers}),start:round=>round.handlers.onStart?.(),stop(){}})}},deviceFactory:async()=>({close:async()=>{},configurePresenter:async()=>{},present:async()=>{}})});
 try{await host.command({action:'start'});observer.onText({responseId:'reply',text:'private-fixture-value'});assert.deepEqual(context(),[])}finally{await host.dispose()}
});
