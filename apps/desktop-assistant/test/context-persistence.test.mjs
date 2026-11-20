import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,utimes} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openConversationStore} from '../src/conversation-store.mjs';
import {createStandaloneConversation} from '../src/conversation.mjs';
import {createChatModel} from '@rabilink/desktop-voice-service/chat-model';
const crypto={protect:value=>'test:'+value,unprotect:value=>value.slice(5)};
const settings={persona:'测试助手',llmEndpoint:'https://example.test/v1/chat/completions',llmModel:'fixture'};
const fixture=(store,requests,errors=[])=>createStandaloneConversation({settings:()=>settings,store,credentials:{resolve:async()=>undefined},onError:e=>errors.push(e.message),createModel:options=>createChatModel({...options,fetcher:async(_url,request)=>{requests.push(JSON.parse(request.body));return new Response('data: '+JSON.stringify({choices:[{delta:{content:'已经记住。'}}]})+'\n\ndata: [DONE]\n\n')}})});

test('restart restores both display history and provider context; explicit clearing fences stale requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-context-'));const requests=[];let store,native;
 try{
  store=await openConversationStore(dir,crypto);native=fixture(store,requests);const id=native.getSessionId();
  await native.submit('记住口令：蓝色月亮739。','first',{source:'speech',details:{kind:'asr',result:{additions:{emotion:'happy'}}}});await native.drain();native.close();await store.close();
  const bytes=await readFile(join(dir,'conversation.sqlite'));assert.ok(!bytes.includes(Buffer.from('蓝色月亮739')));assert.ok(!bytes.includes(Buffer.from('已经记住')));
  store=await openConversationStore(dir,crypto);native=fixture(store,requests);assert.equal(native.getSessionId(),id);assert.equal(native.messages().length,2);assert.equal(native.messageDetails('first').result.additions.emotion,'happy');
  await native.submit('记住口令：蓝色月亮739。','first');await native.drain();assert.equal(requests.length,1);
  await native.submit('口令是什么？','second');await native.drain();assert.ok(JSON.stringify(requests[1].messages).includes('蓝色月亮739'));assert.equal(native.contextState().contextMessageCount,4);assert.ok(requests[1].messages.some(m=>{try{return JSON.parse(m.content).speechObservation?.estimates?.emotion==='happy'}catch{return false}}));
  const result=native.clearContext(id);assert.notEqual(result.sessionId,id);assert.equal(native.messages().length,0);assert.equal(native.contextState().contextMessageCount,0);assert.equal(store.count(),0);
  await assert.rejects(native.submit('旧页面迟到','stale',{conversationId:id}),/CONTEXT_CHANGED/);
  await native.submit('新的对话','third');await native.drain();assert.ok(!JSON.stringify(requests[2].messages).includes('蓝色月亮739'));assert.ok(!requests[2].messages.some(m=>{try{return JSON.parse(m.content).speechObservation}catch{return false}}));
 }finally{native?.close();await native?.drain();await store?.close();await rm(dir,{recursive:true,force:true})}
});

test('large display history pages independently from bounded model context and unfinished turns are not replayed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-context-'));let store,native;const requests=[];
 try{store=await openConversationStore(dir,crypto);const {id}=store.read();const messages=Array.from({length:250},(_,i)=>({id:'m-'+i,role:i%2?'assistant':'user',text:'第'+i+'条',status:i===248?'queued':i===249?'generating':'completed'}));
  store.commit({id,messages,context:[{role:'user',content:'已完成的旧问题'},{role:'assistant',content:'旧回答'}]});await store.close();
  store=await openConversationStore(dir,crypto);native=fixture(store,requests);assert.equal(native.messages().length,100);assert.equal(native.messages()[0].id,'m-150');assert.equal(native.contextState().messageCount,250);assert.equal(native.contextState().interruptedCount,1);assert.equal(native.messages().at(-1).status,'interrupted');
  const older=native.messageHistory('m-150');assert.equal(older.messages[0].id,'m-50');assert.equal(older.hasMore,true);assert.equal(native.messageHistory('m-50').messages.length,50);await native.drain();assert.equal(requests.length,0);
 }finally{native?.close();await store?.close();await rm(dir,{recursive:true,force:true})}
});

test('storage has one owner, rejects unreadable data without resetting it and releases its lease',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-context-'));let store;
 try{store=await openConversationStore(dir,crypto);await assert.rejects(openConversationStore(dir,crypto),/CONTEXT_IN_USE/);store.commit({id:store.read().id,messages:[{id:'private',role:'user',text:'private example'}]});await store.close();
  const path=join(dir,'conversation.sqlite'),before=await readFile(path);await assert.rejects(openConversationStore(dir,{...crypto,unprotect:()=>{throw Error('WRONG_USER')}}),/CONTEXT_LOAD_FAILED/);assert.deepEqual(await readFile(path),before);
  store=await openConversationStore(dir,crypto);assert.equal(store.find('private').text,'private example');
 }finally{await store?.close();await rm(dir,{recursive:true,force:true})}
});

test('Windows reclaims a conversation lease from a reused PID and keeps one active owner', {
 skip:process.platform!=='win32'||process.arch!=='x64'
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-context-'));
 const lockPath=join(dir,'conversation.lock');
 let store;
 try{
  store=await openConversationStore(dir,crypto);
  const {id}=store.read();
  store.commit({id,messages:[{id:'kept',role:'user',text:'保留对话'}]});
  await store.close();

  await writeFile(lockPath,JSON.stringify({pid:process.pid,token:'legacy-owner'}));
  const past=new Date(Date.now()-86400000);
  await utimes(lockPath,past,past);
  const opens=await Promise.allSettled([openConversationStore(dir,crypto),openConversationStore(dir,crypto)]);
  const owners=opens.filter(result=>result.status==='fulfilled').map(result=>result.value);
  store=owners[0];
  try{assert.equal(owners.length,1)}finally{await Promise.all(owners.slice(1).map(owner=>owner.close()))}
  assert.equal(store.read().id,id);
  assert.equal(store.find('kept').text,'保留对话');
  const lease=JSON.parse(await readFile(lockPath,'utf8'));
  assert.match(lease.processStart,/^\d+$/);
  await assert.rejects(openConversationStore(dir,crypto),{code:'ASSISTANT_CONTEXT_IN_USE'});
  await store.close();

  await writeFile(lockPath,JSON.stringify({...lease,processStart:'1'}));
  store=await openConversationStore(dir,crypto);
  assert.equal(store.read().id,id);
  assert.equal(store.count(),1);
 }finally{await store?.close();await rm(dir,{recursive:true,force:true})}
});

test('full storage leaves encrypted history untouched and reports a recoverable storage error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-context-'));
  let store;
  try {
    store = await openConversationStore(dir, crypto);
    store.commit({id:store.read().id, messages:[{id:'kept',role:'user',text:'保留这条消息'}]});
    await store.close();
    const database = join(dir, 'conversation.sqlite');
    const before = await readFile(database);
    const diskFull = Object.assign(new Error('no space'), {code:'ENOSPC'});
    await assert.rejects(openConversationStore(dir,{...crypto,unprotect:()=>{throw diskFull}}),
      {code:'ASSISTANT_CONTEXT_STORAGE_FULL'});
    assert.deepEqual(await readFile(database), before);
    store = await openConversationStore(dir, crypto);
    assert.equal(store.count(),1);
    assert.equal(store.find('kept').text,'保留这条消息');
  } finally { await store?.close(); await rm(dir,{recursive:true,force:true}); }
});

test('failed admission save never dispatches a model request and can be retried visibly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'assistant-context-'));let store,native,fail=true;const requests=[],errors=[];
 try{store=await openConversationStore(dir,crypto);native=fixture({...store,commit:value=>{if(fail)throw Error('DISK_FULL');return store.commit(value)}},requests,errors);
  await assert.rejects(native.submit('未保存不能派发','failure'),/DISK_FULL/);assert.equal(requests.length,0);assert.equal(native.messages().length,0);assert.equal(native.contextState().status,'failed');
  fail=false;native.retryContextSave();assert.equal(native.contextState().status,'ready');await native.submit('现在可以保存','success');await native.drain();assert.equal(requests.length,1);assert.ok(errors.includes('ASSISTANT_CONTEXT_SAVE_FAILED'));
 }finally{native?.close();await store?.close();await rm(dir,{recursive:true,force:true})}
});
