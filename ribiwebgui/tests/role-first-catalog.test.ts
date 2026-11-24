import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";


test("a catalog refresh does not cancel the first-role lookup", async () => {
  Object.defineProperty(globalThis, "window", { value: Object.assign(new EventTarget(), { location: { pathname: "/", hash: "" }, navigator: { language: "zh-CN" } }), configurable: true });
  const { findFirstAvailableRole, useRoleStore } = await import("../src/stores/roleStore");
  setActivePinia(createPinia());
  const original = globalThis.fetch;
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => { releaseFirst = resolve; });
  const page = (roleId: string) => Response.json({ code: 0, data: {
    roles: [{ roleId, title: roleId, archivedAt: null }], nextCursor: null
  } });
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1 ? firstResponse : page("Refreshed");
  try {
    const first = findFirstAvailableRole("");
    const store = useRoleStore();
    await store.loadCatalog();
    releaseFirst(page("First"));
    assert.equal((await first)?.roleId, "First");
    assert.equal(store.catalog[0]?.roleId, "Refreshed");
  } finally { globalThis.fetch = original; }
});

test('partial same-source catalog keeps its old tail until a complete refresh, but auth failure clears it',async()=>{
 Object.defineProperty(globalThis,'window',{value:Object.assign(new EventTarget(),{location:{pathname:'/',hash:''},navigator:{language:'zh-CN'}}),configurable:true});
 const {useRoleStore}=await import('../src/stores/roleStore');setActivePinia(createPinia());const store=useRoleStore();
 const row=(roleId:string)=>({roleId,title:roleId,archivedAt:null});store.selectedRoleId='b';
 const original=globalThis.fetch;let calls=0;
 const page=(...ids:string[])=>Response.json({code:0,data:{roles:ids.map(row),nextCursor:null}});
 try{
  globalThis.fetch=async()=>page('a','b','c');await store.loadCatalog();
  globalThis.fetch=async()=>++calls===1?Response.json({code:0,data:{roles:[row('a')],nextCursor:'page2'}}):Response.json({code:-1,message:'fixture unavailable'},{status:503});
  await assert.rejects(store.loadCatalog(),/unavailable/);assert.deepEqual(store.catalog.map(x=>x.roleId),['a','b','c']);assert.equal(store.selectedRoleId,'b');assert.equal(store.catalogPartial,true);assert.match(store.catalogError,/unavailable/);
  globalThis.fetch=async()=>Response.json({code:0,data:{roles:[row('a')],nextCursor:null}});await store.loadCatalog();assert.deepEqual(store.catalog.map(x=>x.roleId),['a']);assert.equal(store.catalogPartial,false);assert.equal(store.catalogError,'');
  globalThis.fetch=async()=>page('a','b');await store.loadCatalog();
  globalThis.fetch=async()=>Response.json({code:-1,message:'fixture forbidden'},{status:403});await assert.rejects(store.loadCatalog(),/forbidden/);assert.equal(store.catalog.length,0);assert.equal(store.catalogPartial,false);
  globalThis.fetch=async()=>page('private-old');await store.loadCatalog();
  store.sourceDeviceId='other-source';globalThis.fetch=async()=>Response.json({code:-1,message:'new source unavailable'},{status:503});await assert.rejects(store.loadCatalog('other-source',{connect:false}));assert.equal(store.catalog.length,0,'a different source never inherits the old tail');
 }finally{globalThis.fetch=original;}
});

test('obsolete catalog pages and failures cannot replace a newer refresh',async()=>{
 Object.defineProperty(globalThis,'window',{value:Object.assign(new EventTarget(),{location:{pathname:'/',hash:''},navigator:{language:'zh-CN'}}),configurable:true});const {useRoleStore}=await import('../src/stores/roleStore');setActivePinia(createPinia());const store=useRoleStore();
 const original=globalThis.fetch;let release!:(value:Response)=>void,calls=0;const old=new Promise<Response>(resolve=>release=resolve);
 globalThis.fetch=async()=>++calls===1?old:Response.json({code:0,data:{roles:[{roleId:'new',title:'new',archivedAt:null}],nextCursor:null}});
 try{const pending=store.loadCatalog();await store.loadCatalog();release(Response.json({code:-1,message:'old forbidden'},{status:403}));await pending;assert.equal(store.catalog[0]?.roleId,'new');assert.equal(store.catalogError,'');}finally{globalThis.fetch=original;}
});
