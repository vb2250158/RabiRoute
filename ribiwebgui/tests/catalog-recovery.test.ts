import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as presentation from '../src/qqMessagePresentation';

function fixture(t:test.TestContext,name:'NapcatConversationHistory'|'RoleSourcePicker',fetch:(url:string,init?:any)=>any,store:any={}) {
 const file=new URL(name==='RoleSourcePicker'?'../src/components/RoleSourcePicker.vue':'../../src/plugins/io.rabiroute.manager.persona/web/components/NapcatConversationHistory.vue',import.meta.url);
 const descriptor=parse(fs.readFileSync(file,'utf8')).descriptor,script=compileScript(descriptor,{id:'catalog-recovery'}),require=createRequire(file),module={exports:{} as any},unmount:Array<()=>void>=[];
 class RemoteBrowser {devices=[];devicesLoading=false;devicesError='';async refreshDevices(){} invalidate(){}}
 const runtimeVue={...vue,onMounted:()=>{},onBeforeUnmount:(fn:()=>void)=>unmount.push(fn)};
 const customRequire=(name:string):any=>name==='vue'?runtimeVue:name==='vuetify'?{useDisplay:()=>({width:vue.ref(1200)})}:name.endsWith('personaServiceClient')?{usePersonaService:()=>({fetch})}:name.endsWith('roleStore')?{useRoleStore:()=>store,roleRequest:fetch}:name.endsWith('remotePersonaReference')?{RemotePersonaReferenceBrowser:RemoteBrowser,bootstrapRemotePersonaService:async()=>{},remotePersonaServicePath:(source:string,url:string)=>`/peer/${source}${url}`}:name.endsWith('personaSourcePresentation')?{personaSourceKey:(_meta:any,id:string)=>id,personaSourceOptions:()=>[]}:name.endsWith('i18n/index')?{useI18n:()=>({t:(s:string)=>s,locale:vue.ref('en')})}:name.endsWith('userFacingError')?{userFacingError:(e:any)=>e.message??String(e)}:name.endsWith('qqMessagePresentation')?presentation:name.endsWith('qqPreviewQueue')?{qqNavigationRead:(signal:AbortSignal,run:()=>any)=>{signal.throwIfAborted();return run();}}:name.endsWith('.vue')?{}:require(name);
 vm.runInNewContext(transformSync(script.content,{loader:'ts',format:'cjs',target:'es2022'}).code,{module,exports:module.exports,require:customRequire,AbortController,URLSearchParams,console,window:{scrollY:0}});
 const props=vue.reactive({roleId:'fixture',version:0,active:false,routes:[{routeId:'one',name:'one'}]}),scope=vue.effectScope();
 const model=scope.run(()=>module.exports.default.setup(props,{expose:()=>{},emit:()=>{}}));
 t.after(()=>{for(const fn of unmount)fn();scope.stop();});
 return {model,props,flush:async()=>{await new Promise(resolve=>setImmediate(resolve));await vue.nextTick();}};
}
const response=(route:string,name=route)=>({ok:true,json:async()=>({code:0,data:{instanceId:'napcat',account:{userId:'account-'+route},warnings:[],entries:[{kind:'group',target:route,name}]}})});

test('actual QQ directory releases its request after a route aggregation failure and retains normal/previous routes',async t=>{
 let malformed=false,calls=0;
 const f=fixture(t,'NapcatConversationHistory',async(url)=>{calls++;const route=new URL(url,'http://fixture').searchParams.get('routeId')!;if(malformed&&route==='two')return {ok:true,json:async()=>({code:0,data:{instanceId:'napcat',account:{userId:'account-two'},entries:[null]}})};return response(route,malformed?'updated':'initial');});
 f.props.routes=[{routeId:'one',name:'one'},{routeId:'two',name:'two'}];await f.flush();await f.model.loadContacts();assert.equal(f.model.contacts.value.size,2);
 malformed=true;await f.model.loadContacts();assert.equal(calls,4);assert.equal(f.model.contacts.value.size,2);assert.match(f.model.directoryWarning.value,/部分/);
 assert.equal([...f.model.contacts.value.values()].find((x:any)=>x.target==='two').name,'initial');assert.equal([...f.model.contacts.value.values()].find((x:any)=>x.target==='one').name,'updated');
 await f.model.loadContacts();assert.equal(calls,6,'the failed aggregation must release its own pending token');
});

test('an old QQ directory finally cannot release or overwrite a newer source request',async t=>{
 const calls:Array<{url:string,signal:AbortSignal,resolve:(v:any)=>void}>=[];
 const f=fixture(t,'NapcatConversationHistory',(url,init)=>new Promise(resolve=>calls.push({url,signal:init.signal,resolve})));
 const old=f.model.loadContacts();assert.equal(calls.length,1);f.props.routes=[{routeId:'two',name:'two'}];await f.flush();assert.equal(calls[0].signal.aborted,true);
 const current=f.model.loadContacts();assert.equal(calls.length,2);calls[0].resolve(response('one'));await old;
 await f.model.loadContacts();assert.equal(calls.length,2,'old finally must not release the newer pending request');calls[1].resolve(response('two'));await current;
 assert.equal(f.model.contacts.value.size,1);assert.equal([...f.model.contacts.value.values()][0].target,'two');
});

test('actual role picker keeps same-source tail with a warning, drops it on auth/source change, and prunes on complete',async t=>{
 const row=(roleId:string)=>({roleId,title:roleId,archivedAt:null});let mode='partial',calls=0;
 const store=vue.reactive({catalog:[row('a'),row('b'),row('c')],sourceDeviceId:'',selectedRoleId:'b',meta:{}});
 const f=fixture(t,'RoleSourcePicker',async()=>{calls++;if(mode==='forbidden')throw Object.assign(Error('forbidden'),{status:403});if(mode==='complete')return {roles:[row('a')],nextCursor:null};if(calls%2===1)return {roles:[row('a')],nextCursor:'next'};throw Object.assign(Error('unavailable'),{status:503});},store);
 await f.model.browse('');assert.deepEqual(Array.from(f.model.items.value,(x:any)=>x.roleId),['a','b','c']);assert.equal(f.model.partial.value,true);assert.match(f.model.error.value,/unavailable/);
 mode='complete';await f.model.browse('');assert.deepEqual(Array.from(f.model.items.value,(x:any)=>x.roleId),['a']);assert.equal(f.model.partial.value,false);
 mode='forbidden';await f.model.browse('');assert.equal(f.model.items.value.length,0);assert.equal(f.model.partial.value,false);
 await f.model.browse('other-source');assert.equal(f.model.items.value.length,0);assert.equal(f.model.source.value,'other-source');
});
