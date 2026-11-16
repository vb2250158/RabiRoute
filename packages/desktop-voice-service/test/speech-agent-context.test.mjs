import test from 'node:test';import assert from 'node:assert/strict';
import {asrAgentContext} from '../src/speech-details.mjs';
import {snapshotSpeechObservation} from '../../assistant-runtime/src/speech-observation.js';
import {createAssistantConversation} from '../../assistant-runtime/src/conversation-runtime.js';

test('ASR model context contains received semantic values only, without credentials, request bodies or log identifiers',()=>{
 const value=asrAgentContext({kind:'asr',provider:'volcengine',model:'bigmodel',request:{headers:{authorization:'private-value'}},result:{text:'utterance',additions:{emotion:'happy',emotion_score:'0.88',gender:'female',age:'23.3',speaker_id:'1',lid_lang:'speech_mand',speech_rate:'3.5',volume:'75',log_id:'private-log',api_key:'private-key'}}});
 assert.deepEqual(value.estimates,{emotion:'happy',emotion_score:'0.88',gender:'female',age:'23.3',speaker_id:'1',lid_lang:'speech_mand',speech_rate:'3.5',volume:'75'});assert.ok(!JSON.stringify(value).includes('private'));assert.ok(!JSON.stringify(value).includes('utterance'));
 assert.equal(asrAgentContext({kind:'asr',result:{text:'only text'}}),undefined);assert.equal(asrAgentContext({kind:'tts',result:{emotion:'happy'}}),undefined);
});

test('speech observations snapshot primitive estimates, reject instructions/invalid numbers and do not add missing attributes',()=>{
 const value={source:'speech-recognition',estimates:{emotion:'sad'}};const copy=snapshotSpeechObservation(value);value.estimates.emotion='happy';assert.equal(copy.estimates.emotion,'sad');assert.equal(copy.estimates.age,undefined);
 for(const invalid of [{...value,instructions:'private'}, {...value,estimates:{emotion:{text:'nested'}}},{...value,estimates:{age:NaN}},{...value,estimates:{emotion:'x'.repeat(257)}}])assert.throws(()=>snapshotSpeechObservation(invalid),/SPEECH_OBSERVATION_INVALID/);
});

test('queued utterances keep their own observation and later text turns receive no stale observation',async()=>{
 const calls=[];let release;const session={supportsTurnGuard:true,observe:async()=>({}),guide:()=>({accepted:false}),run:async(text,options)=>{calls.push({text,...options});if(text==='first')await new Promise(resolve=>release=resolve);return{state:'completed',text:'ok'}},dispose(){}};
 const conversation=createAssistantConversation({session,scope:'fixture',receipts:{has:async()=>false,acknowledge:async()=>true}});
 try{const first=conversation.run('first',{speechObservation:{source:'speech-recognition',estimates:{emotion:'happy'}}});for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setTimeout(resolve,0));const metadata={source:'speech-recognition',estimates:{emotion:'sad',age:'23'}};const second=conversation.run('second',{speechObservation:metadata});metadata.estimates.emotion='angry';const third=conversation.run('text');release();await Promise.all([first,second,third]);assert.equal(calls[0].speechObservation.estimates.emotion,'happy');assert.equal(calls[1].speechObservation.estimates.emotion,'sad');assert.equal(calls[2].speechObservation,undefined)}finally{conversation.dispose()}
});
