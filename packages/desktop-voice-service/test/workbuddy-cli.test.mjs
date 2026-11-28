import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWorkBuddyModel, runWorkBuddyCli } from '../src/workbuddy-cli.mjs';

async function collect(model, text) {
  const stream = await model.promptStreaming([{role:'user',content:text}]);
  let value='';
  for (;;) {const item=await stream.read();if(item.done)return value;value+=item.value;}
}

test('official model retains prior conversation, passes system prompt, and cancels its owned turn', async()=>{
  const requests=[];
  const model=createWorkBuddyModel({model:'fixture',initialPrompts:[{role:'system',content:'global persona'}],
    runner:async request=>{requests.push(request);request.onText('ok');return 'ok';}});
  assert.equal(await collect(model,'first'),'ok');
  assert.equal(await collect(model,'second'),'ok');
  assert.equal(requests[0].systemPrompt,'global persona');
  assert.deepEqual(JSON.parse(requests[1].prompt).messages.map(item=>item.content),['first','ok','second']);
  model.destroy();assert.equal(requests[1].signal.aborted,true);
});

test('catalog projects model fields and discards account secrets; nonzero CLI exit is a failure',async()=>{
  for(const exitCode of [0,1]) {
    const spawnProcess=(_node,args,options)=>{
      assert.equal(args[args.indexOf('--tools')+1],'');
      assert.equal(options.env.CODEBUDDY_INTERNET_ENVIRONMENT,'internal');
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin.once('data',()=>queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[{value:'m',displayName:'Model'}],account:{token:'private-fixture'}}}})+'\n')));
      child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('close',exitCode,null)));
      return child;
    };
    const operation=runWorkBuddyCli({spawnProcess,executable:{node:process.execPath,entry:'fixture'}});
    if(exitCode)await assert.rejects(operation,/WORKBUDDY_CLI_FAILED/);
    else assert.deepEqual(await operation,[{id:'m',label:'Model'}]);
  }
});

test('an incomplete official CLI installation fails before starting a conversation',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {resolveWorkBuddyCli}=await import('../src/workbuddy-cli.mjs');const directory=await mkdtemp(join(tmpdir(),'workbuddy-incomplete-'));
 try{const entry=join(directory,'bin','codebuddy');await mkdir(join(directory,'bin'));await writeFile(entry,'');await assert.rejects(resolveWorkBuddyCli({node:process.execPath,entry}),/WORKBUDDY_CLI_INSTALL_INVALID/)}finally{await rm(directory,{recursive:true,force:true})}
});

test('official template failure is classified as installation failure rather than login or quota',async()=>{
 const spawnProcess=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({type:'error',error:"Agent template is unavailable for get:default (desired default='unresolved' registered=0)"})+'\n');child.emit('close',0,null)}));return child};
 await assert.rejects(runWorkBuddyCli({prompt:'test',model:'fixture',spawnProcess,executable:{node:process.execPath,entry:'fixture'}}),/WORKBUDDY_CLI_INSTALL_INVALID/);
});

test('cancelling an owned text-only CLI stops it and waits for observed exit',{timeout:5000},async()=>{
 const controller=new AbortController();let killed=false,child;const spawnProcess=()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true};queueMicrotask(()=>controller.abort());return child};
 const work=runWorkBuddyCli({prompt:'test',model:'fixture',signal:controller.signal,spawnProcess,executable:{node:process.execPath,entry:'fixture'}});
 await assert.rejects(work,/WORKBUDDY_REQUEST_CANCELLED/);assert.equal(killed,true);
});

test('the configured official CLI is retained by the model port',async()=>{
 const cli={node:'configured-node',entry:'configured-cli'};let request;const model=createWorkBuddyModel({model:'fixture',cli,runner:async value=>{request=value;value.onText('ok');return 'ok'}});assert.equal(await collect(model,'test'),'ok');assert.deepEqual(request.cli,cli);model.destroy();
});

for(const cancelQueued of [false,true])test('a model request '+(cancelQueued?'can cancel while queued behind':'waits for')+' an active catalog without confusing it with an unconfirmed exit',{timeout:5000},async()=>{
 let ready,child,spawns=0;const catalogReady=new Promise(resolve=>{ready=resolve});
 const spawnProcess=()=>{const current=new EventEmitter();current.stdin=new PassThrough();current.stdout=new PassThrough();current.stderr=new PassThrough();spawns++;
  if(spawns===1){child=current;current.stdin.once('data',()=>{current.stdout.write(JSON.stringify({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[{value:'fixture'}]}}})+'\n');ready()});}
  else current.stdin.on('finish',()=>queueMicrotask(()=>{current.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'})+'\n');current.emit('close',0,null)}));
  return current;
 };
 const options={spawnProcess,executable:{node:process.execPath,entry:'fixture'}},catalog=runWorkBuddyCli(options);await catalogReady;
 const abort=new AbortController(),model=runWorkBuddyCli({...options,model:'fixture',prompt:'hello',signal:abort.signal});
 try{assert.equal(spawns,1);if(cancelQueued){abort.abort();await assert.rejects(model,/WORKBUDDY_REQUEST_CANCELLED/);}child.emit('close',0,null);await catalog;if(!cancelQueued)assert.equal(await model,'ok');await new Promise(resolve=>setImmediate(resolve));assert.equal(spawns,cancelQueued?1:2);}
 finally{child.emit('close',0,null);await catalog.catch(()=>{});await model.catch(()=>{});}
});

test('a catalog waits for the actual chat child close after its terminal result',{timeout:5000},async()=>{
 let ready,child,spawns=0;const chatReady=new Promise(resolve=>{ready=resolve});
 const spawnProcess=()=>{const current=new EventEmitter();current.stdin=new PassThrough();current.stdout=new PassThrough();current.stderr=new PassThrough();spawns++;
  if(spawns===1){child=current;current.stdin.on('finish',()=>{current.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'})+'\n');ready()});}
  else{current.stdin.once('data',()=>current.stdout.write(JSON.stringify({type:'control_response',response:{request_id:'models',subtype:'success',response:{models:[{value:'fixture'}]}}})+'\n'));current.stdin.on('finish',()=>queueMicrotask(()=>current.emit('close',0,null)));}return current;
 };
 const options={spawnProcess,executable:{node:process.execPath,entry:'fixture'}},chat=runWorkBuddyCli({...options,model:'fixture',prompt:'hello'});await chatReady;const catalog=runWorkBuddyCli(options);
 try{assert.equal(spawns,1);child.emit('close',0,null);assert.equal(await chat,'ok');assert.deepEqual(await catalog,[{id:'fixture',label:'fixture'}]);assert.equal(spawns,2);}finally{child.emit('close',0,null);await chat.catch(()=>{});await catalog.catch(()=>{});}
});

test('an unconfirmed cancelled CLI child still fences new work until the original close is observed',{timeout:5000},async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let ready,child,spawns=0;const spawned=new Promise(resolve=>{ready=resolve});const abort=new AbortController();
 const spawnProcess=()=>{spawns++;child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;queueMicrotask(ready);return child;};
 const options={spawnProcess,executable:{node:process.execPath,entry:'fixture'}},operation=runWorkBuddyCli({...options,model:'fixture',prompt:'hello',signal:abort.signal});await spawned;
 try{abort.abort();t.mock.timers.tick(10000);await assert.rejects(operation,/WORKBUDDY_CLI_EXIT_UNCONFIRMED/);await assert.rejects(runWorkBuddyCli(options),/WORKBUDDY_CLI_EXIT_UNCONFIRMED/);assert.equal(spawns,1);}
 finally{child.emit('close',null,'SIGTERM');await operation.catch(()=>{});t.mock.timers.reset();}
});

test('terminal WorkBuddy usage retains numeric receipts and does not double-count progress',async()=>{
  const receipts=[];
  const usage={input_tokens:10,output_tokens:3,cache_read_input_tokens:30,cache_creation_input_tokens:5};
  const snapshot={version:1,scope:'turn',kind:'snapshot',stages:[{source:'model',model:'fixture'}],
    total:{usage,credits:1.5,creditStatus:'known'}};
  const spawnProcess=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('finish',()=>queueMicrotask(()=>{
      const meta={'codebuddy.ai/turnUsage':snapshot};
      const frames=[{type:'system',subtype:'init',model:'fixture'},
        {type:'system',subtype:'usage_update',_meta:meta},
        {type:'result',subtype:'success',is_error:false,result:'response',usage,total_cost_usd:99,_meta:meta}];
      child.stdout.write(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n');child.emit('close',0,null);
    }));
    return child;
  };
  assert.equal(await runWorkBuddyCli({prompt:'fixture',model:'fixture',spawnProcess,executable:{node:process.execPath,entry:'fixture'},onUsage:value=>receipts.push(value)}),'response');
  assert.deepEqual(receipts,[{inputTokens:45,outputTokens:3,cachedTokens:30,uncachedTokens:15,measuredCacheInput:45,credits:1.5}]);
});

test('WorkBuddy appends tools and follow-ups to the stable wire prefix until bounded history prunes it',async()=>{
  const captured=[];
  const runner=async request=>{captured.push({system:request.systemPrompt,messages:JSON.parse(request.prompt).messages});request.onText('ok');return 'ok';};
  const model=createWorkBuddyModel({model:'fixture',initialPrompts:[{role:'system',content:'fixed instructions'}],runner});
  await collect(model,'first request');
  await collect(model,JSON.stringify({type:'tool_result',content:'result A'}));
  await collect(model,JSON.stringify({type:'tool_result',content:'result B'}));
  await collect(model,'follow-up');
  for(let i=1;i<captured.length;i++){
    assert.equal(captured[i].system,captured[i-1].system);
    assert.deepEqual(captured[i].messages.slice(0,captured[i-1].messages.length),captured[i-1].messages);
  }
  for(let i=0;i<16;i++)await collect(model,'input '+i);
  assert.ok(captured.at(-1).messages.length<=25);
  assert.ok(!captured.at(-1).messages.some(message=>message.content==='first request'));
  model.destroy();
});
