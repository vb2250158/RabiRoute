import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import { registeredWebCommands } from '../src/pluginCommands';
import { retainMountedTrustedWebPage } from '../src/pluginPages';
register(new URL('./fixtures/web-module-lifecycle-loader.mjs', import.meta.url));
const {refreshWebPluginModules: refresh, disposeWebPluginModules: dispose, webPluginModulesPending: pending} = await import('../src/pluginModules');
type Api = {instanceIds: readonly string[];forInstance(id:string):{registerCommand(input:unknown):()=>void;registerPage(input:unknown):()=>void}};
type Activate = (id:string, revision:string, api:Api)=>unknown;
function gate() { let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release}; }
const descriptor=(id:string,rev='a')=>({id,pluginId:`fixture.${id}`,version:'1',rev:rev.repeat(64),entryPath:'entry.mjs',instances:[{instanceId:id}]});
const keys=()=>registeredWebCommands().filter(x=>x.handlerId.startsWith('lifecycle.')).map(x=>x.handlerId).sort();
function command(api:Api,id:string) { return api.forInstance(api.instanceIds[0]!).registerCommand({handlerId:`lifecycle.${id}`,allowedSlots:[],allowedIcons:[],execute(){}}); }
async function until(check:()=>boolean) { const deadline=performance.now()+3000;while(!check()){assert.ok(performance.now()<deadline,'controlled lifecycle observation did not settle');await turn();} }
async function fixture(run:(f:{catalog:ReturnType<typeof descriptor>[];activate:Activate;reads:number})=>Promise<void>) {
  const previousFetch=globalThis.fetch;
  const f={catalog:[] as ReturnType<typeof descriptor>[],activate:((_id,_rev,_api)=>{}) as Activate,reads:0};
  const globals=globalThis as unknown as {__webModuleLifecycleTest?:typeof f};globals.__webModuleLifecycleTest=f;
  globalThis.fetch=async(input)=>{assert.ok(String(input).startsWith('/api/plugins/modules'));f.reads++;return new Response(JSON.stringify({code:0,data:{modules:f.catalog}}),{status:200});};
  try {await run(f);} finally {await dispose();globalThis.fetch=previousFetch;delete globals.__webModuleLifecycleTest;assert.deepEqual(keys(),[]);}
}

test('background catalog intents do not join hung activation; default refresh still awaits its original work',async()=>fixture(async f=>{
  const a=gate();let entered=false,finished=false;
  f.activate=async(id,_rev,api)=>{if(id==='a'){entered=true;await a.promise;}return command(api,id);};
  f.catalog=[descriptor('a'),descriptor('b')];
  const original=refresh().then(()=>{finished=true;});
  try {
    await until(()=>entered&&keys().includes('lifecycle.b'));assert.equal(finished,false);assert.equal(pending(),true);
    f.catalog=[descriptor('b'),descriptor('c')];await refresh({initialization:'background'});
    await until(()=>keys().includes('lifecycle.c'));assert.equal(finished,false);assert.equal(f.reads,2);
    assert.equal(keys().includes('lifecycle.a'),false);assert.equal(pending(),false);
  } finally {a.release();await original;}
}));

test('rejected activation is local, observed, and retried only by a later explicit catalog intent',async()=>fixture(async f=>{
  let attempts=0;const originalWarn=console.warn;const warnings:unknown[][]=[];console.warn=(...args)=>warnings.push(args);
  f.activate=(id,_rev,api)=>{if(id==='a'){attempts++;throw new Error('controlled activation failure');}return command(api,id);};
  f.catalog=[descriptor('a'),descriptor('b')];
  try {await assert.rejects(refresh(),AggregateError);assert.deepEqual(keys(),['lifecycle.b']);assert.equal(attempts,1);await turn();assert.equal(attempts,1);assert.equal(pending(),false);assert.ok(warnings.length);
    await assert.rejects(refresh(),AggregateError);assert.equal(attempts,2);
  } finally {console.warn=originalWarn;}
}));

test('removal immediately revokes registrations but joins late activation and its real cleanup',async()=>fixture(async f=>{
  const activation=gate(),cleanup=gate();let entered=false,cleanupEntered=false,closed=false;
  f.activate=async(_id,_rev,api)=>{command(api,'early');entered=true;await activation.promise;command(api,'late');return async()=>{cleanupEntered=true;await cleanup.promise;};};
  f.catalog=[descriptor('a')];await refresh({initialization:'background'});await until(()=>entered);
  const closing=dispose().then(()=>{closed=true;});assert.deepEqual(keys(),[]);
  try {assert.equal(closed,false);activation.release();await until(()=>cleanupEntered);assert.deepEqual(keys(),[]);assert.equal(closed,false);}
  finally {activation.release();cleanup.release();await closing;}
}));

test('slow retirement waits only for its own id; independent catalog modules remain available',async()=>fixture(async f=>{
  const cleanup=gate();let cleanupEntered=false,newA=0;
  f.activate=(id,rev,api)=>{command(api,id);if(id==='a'&&rev.startsWith('a'))return async()=>{cleanupEntered=true;await cleanup.promise;};if(id==='a')newA++;return ()=>{};};
  f.catalog=[descriptor('a'),descriptor('b')];await refresh();
  f.catalog=[descriptor('a','b'),descriptor('b'),descriptor('c')];await refresh({initialization:'background'});
  try {await until(()=>cleanupEntered&&keys().includes('lifecycle.c'));assert.equal(newA,0);assert.equal(pending(),true);assert.deepEqual(keys(),['lifecycle.b','lifecycle.c']);}
  finally {cleanup.release();await refresh();}assert.equal(newA,1);assert.equal(pending(),false);
}));

test('failed update restores previous confirmed code while retaining the current instance membership',async()=>fixture(async f=>{
  const memberships:string[][]=[];const originalWarn=console.warn;console.warn=()=>{};
  f.activate=(id,rev,api)=>{if(rev.startsWith('b'))throw new Error('controlled update failure');memberships.push([...api.instanceIds]);const releases=api.instanceIds.map(instance=>command({instanceIds:[instance],forInstance:api.forInstance},instance));return ()=>releases.forEach(release=>release());};
  try {f.catalog=[{...descriptor('a'),instances:[{instanceId:'a'},{instanceId:'revoked'}]}];await refresh();f.catalog=[descriptor('a','b')];await assert.rejects(refresh(),AggregateError);assert.deepEqual(memberships,[['a','revoked'],['a']]);assert.deepEqual(keys(),['lifecycle.a']);assert.equal(pending(),false);}
  finally {console.warn=originalWarn;}
}));

test('snapshot disposal does not own a later healthy authenticated catalog while another old owner stops',async()=>fixture(async f=>{
  const cleanupA=gate();let aClosing=false,bActivations=0,oldClosed=false;
  f.activate=(id,_rev,api)=>{command(api,id);if(id==='a')return async()=>{aClosing=true;await cleanupA.promise;};bActivations++;return ()=>{};};
  f.catalog=[descriptor('a'),descriptor('b')];await refresh();
  const old=dispose().then(()=>{oldClosed=true;});assert.deepEqual(keys(),[]);
  try {await until(()=>aClosing);f.catalog=[descriptor('b')];await refresh({initialization:'background'});await until(()=>bActivations===2&&keys().includes('lifecycle.b'));
    assert.equal(oldClosed,false);assert.equal(pending(),false);cleanupA.release();await old;assert.deepEqual(keys(),['lifecycle.b']);
  } finally {cleanupA.release();await old;}
}));

test('snapshot disposal aborts an old catalog read and cannot publish its late descriptors',async()=>fixture(async f=>{
  const response=gate();let reading=false,aborted=false;
  globalThis.fetch=async(_input,options)=>{reading=true;options?.signal?.addEventListener('abort',()=>{aborted=true;});await response.promise;return new Response(JSON.stringify({code:0,data:{modules:[descriptor('a')]}}));};
  let activated=0;f.activate=()=>{activated++;};
  const stale=refresh();await until(()=>reading);const closing=dispose();assert.equal(aborted,true);
  response.release();await assert.rejects(stale,/revoked/);await closing;assert.equal(activated,0);
}));


test('failed retirement remains owned and does not block an unrelated module or silently retry',async()=>fixture(async f=>{
  let stops=0;const originalWarn=console.warn;console.warn=()=>{};
  f.activate=(id,_rev,api)=>{const release=command(api,id);if(id==='a')return ()=>{stops++;if(stops===1)throw new Error('controlled retirement failure');release();};return release;};
  try {f.catalog=[descriptor('a')];await refresh();f.catalog=[descriptor('b')];await assert.rejects(refresh(),AggregateError);assert.deepEqual(keys(),['lifecycle.b']);assert.equal(stops,1);await turn();assert.equal(stops,1);await refresh();assert.equal(stops,2);}
  finally {console.warn=originalWarn;}
}));


test('a mounted page cannot retain an already revoked owner across a later catalog intent',async()=>fixture(async f=>{
  const cleanup=gate();let replacements=0;let releaseMount=()=>{};
  f.activate=(id,rev,api)=>{command(api,id);api.forInstance(id).registerPage({routeId:'lifecycle.page',rendererId:'lifecycle.renderer',paths:[{path:'/lifecycle-page',title:'Fixture'}],loader:async()=>({})});
    if(rev.startsWith('a'))return ()=>cleanup.promise;replacements++;return ()=>{};};
  f.catalog=[descriptor('a')];await refresh();releaseMount=retainMountedTrustedWebPage('lifecycle.page');const old=dispose();
  try {f.catalog=[descriptor('a','b')];await refresh({initialization:'background'});assert.equal(pending(),true);cleanup.release();await old;await until(()=>replacements===1);assert.deepEqual(keys(),['lifecycle.a']);}
  finally {cleanup.release();releaseMount();await old;}
}));
