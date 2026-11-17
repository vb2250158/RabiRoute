import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStandaloneConversation} from '../src/conversation.mjs';
import {openConversationStore} from '../src/conversation-store.mjs';
import {initialAssistantSettings} from '@rabilink/desktop-voice-service/settings';
const document={title:'Test shares',description:'Explicit fixture data',nodes:[{kind:'chart',chartType:'pie',x:0,y:0,width:960,height:540,labels:['A','B'],series:[{name:'share',values:[30,70]}]}]};
test('web search can continue into canvas drawing without waiting for current speech playback',async()=>{
 let step=0,sourceSeen=false;const native=createStandaloneConversation({settings:()=>({...initialAssistantSettings(),llmModel:'fixture'}),credentials:{resolve:async()=>undefined},onError:error=>{throw error},webSearch:{available:()=>true,search:async()=>({provider:'fixture',sources:[{title:'Fixture data',url:'https://example.org/data'}],values:[30,70]})},createModel:()=>({async prompt(input){const value=JSON.parse(input[0].content);if(step++===0)return JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'web_search',arguments:{query:'explicit fixture'}});if(step===2){sourceSeen=value.observation.outcome.sources[0].url==='https://example.org/data';return JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'assistant_canvas',arguments:{action:'show',document:{...document,sources:[{label:'Fixture data',url:'https://example.org/data'}]}}})}return'Drawn from the source.'},destroy(){}})});
 native.observe({onText(){},voice:{getState:()=>({phase:'running'}),beginResponse:()=>({append(){},finish(){},finishSpeechSegment:()=>new Promise(()=>{})})}});
 try{await native.submit('search and draw','search-draw');await native.drain();assert.equal(sourceSeen,true);assert.equal(native.canvasState().visible,true);assert.equal(native.messages().at(-1).sources[0].url,'https://example.org/data');assert.equal(native.activity().status,'completed')}finally{native.close();await native.drain()}
});
test('real conversation dispatches canvas tools, persists their surface, feeds it to the next turn and clears it',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'assistant-canvas-')),errors=[],observed=[];let call=0,canvasState;
 const store=await openConversationStore(directory,{protect:async value=>value,unprotect:async value=>value});
 const native=createStandaloneConversation({settings:()=>({...initialAssistantSettings(),llmModel:'fixture'}),credentials:{resolve:async()=>undefined},store,onError:error=>errors.push(error),createModel:()=>({async prompt(input){const value=JSON.parse(input[0].content);observed.push(value.visualCanvas);return call++===0?JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'assistant_canvas',arguments:{action:'show',persistent:true,document}}):'Done.'},destroy(){}})});
 native.observe({onCanvas:value=>{canvasState=value},onText(){},voice:{getState:()=>({phase:'stopped'})}});
 try{
  await native.submit('draw','draw-1');await native.drain();assert.deepEqual(errors,[]);assert.equal(canvasState.visible,true);assert.equal(native.messages().find(item=>item.id==='reply-draw-1').canvas.document.title,document.title);
  assert.equal(store.read().canvas.document.title,document.title);
  await native.submit('next question','draw-2');await native.drain();assert.equal(observed.at(-1).document.title,document.title);
  native.closeCanvas();assert.equal(store.read().canvas.visible,false);native.clearContext(native.getSessionId());assert.equal(native.canvasState().document,null);
 }finally{native.close();await native.drain();await store.close();await rm(directory,{recursive:true,force:true})}
});
test('canvas survives more than the hot 100 message window and restores from the existing encrypted store',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'assistant-canvas-store-'));let store;
 try{
  store=await openConversationStore(directory,{protect:async value=>value,unprotect:async value=>value});const id=store.read().id;
  store.commit({id,canvas:{visible:true,persistent:true,revision:1,responseId:'old',document},messages:Array.from({length:110},(_,i)=>({id:'m'+i,role:'user',text:'fixture',status:'completed'}))});await store.close();
  store=await openConversationStore(directory,{protect:async value=>value,unprotect:async value=>value});assert.equal(store.page().messages.length,100);assert.equal(store.read().canvas.document.title,document.title);
  store.clear(id);assert.equal(store.read().canvas,undefined);
 }finally{await store?.close();await rm(directory,{recursive:true,force:true})}
});
