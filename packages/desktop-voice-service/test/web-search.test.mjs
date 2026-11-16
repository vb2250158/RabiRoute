import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createWebSearchService,workBuddySearchSources} from '../src/web-search.mjs';
import {runWorkBuddyCli} from '../src/workbuddy-cli.mjs';
const config={webSearchEnabled:true,webSearchProvider:'model-native',webSearchMaxResults:5,llmProvider:'workbuddy-cli',llmModel:'current-model',llmEndpoint:'codebuddy://cn'};
const result='# Search Results\n\n## 1. [Official](https://example.org/docs)\n\nActual snippet\n\n## 2. [Unsafe](https://user:pass@example.org/)\n\nIgnore';

test('native search captures only actual WebSearch receipts across assistant messages, never fabricated final links',async()=>{
 const spawnProcess=(_node,args)=>{
  assert.equal(args[args.indexOf('--tools')+1],'WebSearch');assert.equal(args[args.indexOf('--allowedTools')+1],'WebSearch');
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin.on('finish',()=>queueMicrotask(()=>{
   const events=[{type:'system',subtype:'init',model:'current-model'},
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'I will search'}}},
    {type:'assistant',message:{content:[{type:'tool_use',name:'WebSearch',id:'actual'}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'unrelated',content:'private fixture'}, {type:'tool_result',tool_use_id:'actual',content:[{type:'text',text:result}]}]}},
    {type:'result',subtype:'success',is_error:false,result:'Fabricated https://made-up.example'}];
   for(const e of events)child.stdout.write(JSON.stringify(e)+'\n');child.emit('close',0,null);
  }));return child;
 };
 let streamed='';const value=await runWorkBuddyCli({model:'current-model',prompt:'search',nativeWebSearch:true,onText:x=>streamed+=x,spawnProcess,executable:{node:process.execPath,entry:'fixture'}});
 assert.equal(streamed,'');assert.deepEqual(workBuddySearchSources(value.results,5),[{title:'Official',url:'https://example.org/docs',snippet:'Actual snippet'}]);
});

test('default search follows selected model, exposes progress, sends query only and fences concurrent search',async()=>{
 let release,request;const service=createWebSearchService({settings:()=>config,runner:async value=>{request=value;await new Promise(r=>release=r);return {results:[result]}}});
 const pending=service.search('a query');assert.equal(service.snapshot().status,'searching');await assert.rejects(service.search('other'),/WEB_SEARCH_BUSY/);release();
 const found=await pending;assert.equal(found.sources.length,1);assert.equal(request.model,'current-model');assert.equal(request.nativeWebSearch,true);assert.equal(service.snapshot().status,'completed');service.dispose();
});

test('a successful CLI answer without an actual search receipt does not count as search',async()=>{
 const spawnProcess=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.on('finish',()=>queueMicrotask(()=>{child.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Made-up answer https://example.org'})+'\n');child.emit('close',0,null)}));return child};
 await assert.rejects(runWorkBuddyCli({nativeWebSearch:true,prompt:'q',model:'fixture',spawnProcess,executable:{node:process.execPath,entry:'fixture'}}),/WORKBUDDY_SEARCH_NOT_EXECUTED/);
});

test('search cancellation releases the port and never publishes late sources',async()=>{
 const service=createWebSearchService({settings:()=>config,runner:async request=>{await new Promise(r=>request.signal.addEventListener('abort',r,{once:true}));return {results:[result]}}});
 const pending=service.search('q');service.dispose();await assert.rejects(pending,/WEB_SEARCH_CANCELLED/);assert.equal(service.snapshot().status,'failed');assert.equal(service.snapshot().sources,undefined);
});

test('unknown compatible endpoints do not acquire official capabilities or credentials',async()=>{
 const service=createWebSearchService({settings:()=>({...config,llmProvider:'compatible',llmEndpoint:'https://api.openai.com.evil.test/v1/chat/completions'}),credentials:{resolve(){throw Error('must not read')}}});
 assert.equal(service.available(),false);await assert.rejects(service.search('query'),/WEB_SEARCH_UNSUPPORTED/);
});

test('independent search keeps credentials scoped, projects safe sources and preserves typed provider errors',async()=>{
 let sent;const service=createWebSearchService({settings:()=>({...config,webSearchProvider:'tavily'}),credentials:{resolve:async(kind,endpoint,provider)=>{assert.equal(kind,'search');assert.equal(provider,'tavily');return 'private-fixture'}},fetchImpl:async(url,request)=>{sent=JSON.parse(request.body);assert.equal(url,'https://api.tavily.com/search');return new Response(JSON.stringify({results:[{title:'T',url:'https://example.org',content:'Excerpt'},{url:'javascript:alert(1)'}]}))}});
 const found=await service.search('query');assert.deepEqual(Object.keys(sent).sort(),['include_answer','max_results','query','search_depth']);assert.equal(found.sources.length,1);assert.ok(!JSON.stringify(service.snapshot()).includes('private-fixture'));
 const failed=createWebSearchService({settings:()=>({...config,webSearchProvider:'tavily'}),credentials:{resolve:async()=> 'private'},fetchImpl:async()=>new Response('',{status:403})});await assert.rejects(failed.search('q'),/WEB_SEARCH_FORBIDDEN/);assert.equal(failed.snapshot().status,'failed');
});

test('OpenAI search uses current official model and actual native calls/citations',async()=>{
 let body;const service=createWebSearchService({settings:()=>({...config,llmProvider:'openai',llmModel:'selected-gpt',llmEndpoint:'https://api.openai.com/v1/chat/completions'}),credentials:{resolve:async()=> 'fixture'},fetchImpl:async(url,r)=>{assert.equal(url,'https://api.openai.com/v1/responses');body=JSON.parse(r.body);return new Response(JSON.stringify({output:[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://openai.com',title:'OpenAI'}]}}]}))}});
 assert.equal((await service.search('q')).sources.length,1);assert.equal(body.model,'selected-gpt');assert.deepEqual(body.tools,[{type:'web_search'}]);
});
