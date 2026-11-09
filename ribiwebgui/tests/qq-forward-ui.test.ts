import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc';
import {transformSync} from 'esbuild';
import * as vue from 'vue';
import {renderToString} from '@vue/server-renderer';
import * as presentation from '../src/qqMessagePresentation';
import * as forwardPresentation from '../../src/plugins/io.rabiroute.manager.persona/web/persona/qqForwardPresentation';

function fixture(t:import('node:test').TestContext,name:string,initial:Record<string,unknown>,read?:typeof globalThis.fetch){
 const file=new URL(`../../src/plugins/io.rabiroute.manager.persona/web/components/${name}.vue`,import.meta.url);
 const require=createRequire(file),descriptor=parse(fs.readFileSync(file,'utf8')).descriptor;
 const script=compileScript(descriptor,{id:'qq-forward-fixture'});
 const module={exports:{} as any},unmount:Array<()=>void>=[],emitted:unknown[][]=[];
 const props=vue.reactive(structuredClone(initial));
 const noOp=()=>{};
 const ForwardStub=vue.defineComponent({props:['initialPath'],setup:p=>()=>vue.h('div',{'data-forward-dialog':true,'data-path':p.initialPath},'Forward details')});
 const mockedVue={...vue,onBeforeUnmount:(fn:()=>void)=>unmount.push(fn),defineAsyncComponent:()=>ForwardStub};
 const customRequire=(path:string):any=>path==='vue'?mockedVue:path.endsWith('qqMessagePresentation')?presentation:path.endsWith('qqForwardPresentation')?forwardPresentation:path.endsWith('qqPreviewQueue')?{qqPreviewRead:(signal:AbortSignal,run:()=>unknown)=>{signal.throwIfAborted();return Promise.resolve().then(run);}}:path.endsWith('personaServiceClient')?{usePersonaService:()=>({fetch:read??(()=>{throw Error('Unexpected request');})})}:path.endsWith('i18n/index')?{useI18n:()=>({t:(value:string)=>value,locale:vue.ref('en')})}:path.endsWith('userFacingError')?{userFacingError:String}:path.endsWith('.vue')?{}:require(path);
 const code=transformSync(script.content,{loader:'ts',format:'cjs',target:'es2022'}).code;
 vm.runInNewContext(code,{module,exports:module.exports,require:customRequire,AbortController,URL,URLSearchParams,Blob,console,window:{},IntersectionObserver:class{observe(){}disconnect(){}}});
 const scope=vue.effectScope();
 const model=scope.run(()=>module.exports.default.setup(props,{expose:noOp,emit:(...args:unknown[])=>emitted.push(args)}));
 const compiled=compileTemplate({source:descriptor.template!.content,filename:file.pathname,id:'qq-forward-fixture',compilerOptions:{bindingMetadata:script.bindings}});assert.deepEqual(compiled.errors,[]);
 const templateModule={exports:{} as any};vm.runInNewContext(transformSync(compiled.code,{loader:'ts',format:'cjs'}).code,{module:templateModule,exports:templateModule.exports,require:(name:string)=>name==='vue'?{...vue,resolveComponent:(tag:string)=>tag}:require(name)});
 const render=()=>renderToString(vue.h({render:()=>templateModule.exports.render({},[],props,vue.proxyRefs(model),{},{} )}));
 const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await vue.nextTick();};
 t.after(()=>{for(const fn of unmount)fn();scope.stop();});
 return {model,props,emitted,render,flush};
}
const selection={routeId:'main',kind:'group',target:'10001'};
const normal={text:'[CQ:forward,id=opaque]',structuredParts:[{kind:'label',text:'合并转发'}],messageId:'-7',selection,active:true};

test('actual root card click mounts the real template dialog boundary and channel inactivity closes it',async t=>{
 const f=fixture(t,'QqMessageContent',normal);
 assert.match(await f.render(),/qq-forward-card/);assert.doesNotMatch(await f.render(),/data-forward-dialog/);
 f.model.openForward(0);assert.equal(f.model.forwardOpen.value,'0');
 assert.match(await f.render(),/data-forward-dialog="true"/);assert.match(await f.render(),/data-path="0"/);
 f.props.active=false;await f.flush();assert.equal(f.model.forwardOpen.value,undefined);assert.doesNotMatch(await f.render(),/data-forward-dialog/);
});

test('nested cards navigate in the same forward tree and never read a root-conversation quote',async t=>{
 let requests=0;const f=fixture(t,'QqMessageContent',{...normal,forwardReference:{messageId:'-7',path:'0',nodeIndex:3}},(async()=>{requests++;throw Error('No quote read expected');}) as any);
 f.model.openForward(1);assert.deepEqual(JSON.parse(JSON.stringify(f.emitted)),[['forward','0.3.1']]);assert.equal(f.model.forwardOpen.value,undefined);
 await f.model.openQuote('88');assert.equal(requests,0);assert.equal(f.model.canReadQuote('88'),false);
});

test('forwarded images use the original root and exact node scope; clearing releases loaded object URLs',async t=>{
 const urls:string[]=[];const fetch=async(url:string)=>{urls.push(url);return {ok:true,json:async()=>({code:0,data:{attachments:[{index:0,name:'image.png'}]}}),arrayBuffer:async()=>Uint8Array.from([137,80,78,71,13,10,26,10]).buffer};};
 const f=fixture(t,'QqMessageContent',{...normal,text:'[图片]',structuredParts:[{kind:'media',mediaKind:'image',index:0,name:'图片'}],forwardReference:{messageId:'-7',path:'0.4.1',nodeIndex:6}},fetch as any);
 await f.model.openMedia(0);
 assert.equal(urls[0],'/api/agent/qq/messages/-7/forwards/0.4.1/nodes/6?routeId=main&kind=group&target=10001');
 assert.equal(urls[1],'/api/agent/qq/messages/-7/forwards/0.4.1/nodes/6/attachments/0?routeId=main&kind=group&target=10001');
 assert.equal(f.model.media.value.size,1);f.model.clear();assert.equal(f.model.media.value.size,0);
});

function dialogFixture(t:import('node:test').TestContext){
 const calls:Array<{url:string;signal:AbortSignal;resolve:(value:any)=>void}>=[];
 const f=fixture(t,'QqForwardMessages',{selection,messageId:'-7',initialPath:'0',active:true},((url:string,options:{signal:AbortSignal})=>new Promise(resolve=>calls.push({url,signal:options.signal,resolve}))) as any);
 const response=(text:string)=>({ok:true,json:async()=>({code:0,data:{routeId:'main',instanceId:'qq',messageId:'-7',forwardPath:f.model.path.value,total:1,truncated:false,offset:f.model.offset.value,nextOffset:null,skippedCount:0,entries:[{nodeIndex:0,messageId:'',sender:'20001',senderName:'Name',text,parts:[{kind:'text',text}]}]}})});
 t.after(()=>calls.forEach(c=>c.resolve(response('late'))));
 return {...f,calls,response};
}

test('actual forward dialog rejects late nested results after a same-path conversation change',async t=>{
 const f=dialogFixture(t);await f.flush();assert.equal(f.calls.length,1);
 f.props.selection={...selection,target:'10002'};await f.flush();assert.equal(f.calls.length,2);assert.equal(f.calls[0].signal.aborted,true);
 f.calls[1].resolve(f.response('new context'));await f.flush();assert.equal(f.model.page.value.entries[0].text,'new context');
 f.calls[0].resolve(f.response('old context'));await f.flush();assert.equal(f.model.page.value.entries[0].text,'new context');
});

test('actual nested navigation/back controls cancel in-flight reads and never prefetch sibling forwards',async t=>{
 const f=dialogFixture(t);await f.flush();f.calls[0].resolve(f.response('root'));await f.flush();
 f.model.navigate('0.3.1');await f.flush();assert.equal(f.calls.length,2);assert.match(f.calls[1].url,/forwards\/0\.3\.1\?/);
 f.model.back();await f.flush();assert.equal(f.calls.length,3);assert.equal(f.calls[1].signal.aborted,true);assert.match(f.calls[2].url,/forwards\/0\?/);
 f.props.active=false;await f.flush();assert.equal(f.calls[2].signal.aborted,true);assert.equal(f.model.loading.value,false);
 f.calls[2].resolve(f.response('late after hiding'));await f.flush();assert.equal(f.model.page.value,undefined);
});


test('actual forward paging can continue past 100 and nested back restores the parent page',async t=>{
 const f=dialogFixture(t);await f.flush();
 f.calls[0].resolve({ok:true,json:async()=>({code:0,data:{routeId:'main',instanceId:'qq',messageId:'-7',forwardPath:'0',total:205,offset:0,nextOffset:100,skippedCount:100,truncated:true,entries:[]}})});await f.flush();
 assert.equal(f.model.page.value.entries.length,0);assert.equal(f.model.page.value.nextOffset,100);
 assert.match(await f.render(),/下一页/);
 f.model.changePage(100);await f.flush();assert.equal(f.calls.length,2);assert.match(f.calls[1].url,/offset=100&limit=100/);
 f.calls[1].resolve(f.response('page100'));await f.flush();
 f.model.navigate('0.104.1000');await f.flush();assert.match(f.calls[2].url,/forwards\/0\.104\.1000\?/);assert.match(f.calls[2].url,/offset=0&limit=100/);
 f.model.back();await f.flush();assert.equal(f.calls[2].signal.aborted,true);assert.match(f.calls[3].url,/forwards\/0\?/);assert.match(f.calls[3].url,/offset=100&limit=100/);
});
