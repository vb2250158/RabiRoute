import test from 'node:test';
import assert from 'node:assert/strict';
import {createStandaloneConversation} from '../src/conversation.mjs';
import {initialAssistantSettings} from '@rabilink/desktop-voice-service/settings';
import {createWorkBuddyModel} from '@rabilink/desktop-voice-service/workbuddy-cli';

test('standalone model uses search tool results and persists sources on the correct reply while queued input stays accepted',async()=>{
 let count=0,release,sealed=0;const captured=[],sources=[{title:'Actual source',url:'https://example.org/docs',snippet:'Actual fact'}];
 const native=createStandaloneConversation({settings:()=>({...initialAssistantSettings(),llmModel:'fixture'}),credentials:{resolve:async()=>undefined},onError:e=>{throw e},
  webSearch:{available:()=>true,search:async()=>{assert.equal(sealed,1);await new Promise(r=>release=r);return {query:'q',provider:'fixture',sources}}},
  createModel:()=>({prompt:async input=>{const envelope=JSON.parse(input[0].content);captured.push(envelope);if(++count===1)return JSON.stringify({protocol:envelope.protocol,requestId:envelope.requestId,kind:'tool',name:'web_search',arguments:{query:'q'},say:'Searching now.'});return '<voice style="自然"/>Found actual fact.'},destroy(){}})});
 native.observe({voice:{getState:()=>({phase:'running'}),beginResponse:()=>({append(){},setSpeech(){},finish(){},finishSpeechSegment(){sealed++}})},onText(){}});
 try{
  await native.submit('search now','first');for(let n=0;n<20&&!release;n++)await new Promise(r=>setImmediate(r));
  assert.equal(native.activity().status,'searching');assert.equal(native.messages().at(-1).search.status,'searching');await native.submit('next question','next');release();await native.drain();
  assert.equal(captured[1].observation.outcome.sources[0].url,sources[0].url);assert.deepEqual(native.messages().find(m=>m.id==='reply-first').sources,sources);assert.equal(native.messages().find(m=>m.id==='reply-next').sources,undefined);assert.equal(native.activity().pending,0);
  assert.equal(native.messages().find(m=>m.id==='reply-first').text,'Searching now.\nFound actual fact.');assert.ok(!native.messages().some(m=>m.text.includes('<voice')));
 }finally{native.close();await native.drain()}
});

test('real WorkBuddy model port normalizes native search, keeps final text streaming and stores only canonical action history',async()=>{
 let count=0;const prompts=[],updates=[],nativeMarkup='<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">q</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
 const app=createStandaloneConversation({settings:()=>({...initialAssistantSettings(),llmProvider:'workbuddy-cli',llmEndpoint:'codebuddy://cn',llmModel:'fixture'}),credentials:{resolve:async()=>undefined},onError:e=>{throw e},webSearch:{available:()=>true,search:async()=>({provider:'fixture',sources:[{title:'actual',url:'https://example.org'}]})},createModel:options=>createWorkBuddyModel({...options,runner:async request=>{prompts.push(JSON.parse(request.prompt));const text=++count===1?'I will search.\n'+nativeMarkup:'<voice style="自然"/>Actual result.';for(const char of text)request.onText(char);return text}})});
 app.subscribe(values=>updates.push(values.at(-1)?.text||''));
 try{await app.submit('find','native-search');await app.drain();assert.equal(app.messages().at(-1).text,'I will search.\nActual result.');assert.equal(app.messages().at(-1).sources.length,1);assert.ok(!updates.some(text=>text.includes('DSML')));assert.ok(!JSON.stringify(prompts[1]).includes('DSML'));assert.equal(JSON.parse(prompts[1].messages.at(-2).content).name,'web_search');}finally{app.close();await app.drain()}
});
