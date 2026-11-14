import assert from "node:assert/strict";
import test from "node:test";
import { createComputerControlState } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlState";
import { filterComputers, stableComputerRows, computerDeepLink, writeField, type ComputerTarget } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlPresentation";
const row = (id: string, status: ComputerTarget["status"] = "online"): ComputerTarget => ({id,instanceId:id,name:id,kind:"host",local:false,status});
const snapshot = (enabled: boolean, etag = "v1") => ({settings:{enabled,features:{input:true}},etag,schema:{}});
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (reason:unknown)=>void; const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
test("flat computer refresh preserves stable order and reliable identity",()=>{
 assert.deepEqual(stableComputerRows([row("a"),row("b")],[row("b","offline"),row("c"),row("a")]).map(v=>v.id),["a","b","c"]);
 assert.equal(filterComputers([row("a"),row("b","unknown")],"", "all","unknown")[0]?.id,"b");
 assert.equal(computerDeepLink({instanceId:"a"},[row("a")]),"a");
 assert.equal(computerDeepLink({deviceId:"wrong",instanceId:"a"},[row("a")]),undefined);
});
test("old directory success or error never replaces a later refresh",async()=>{
 const editor=createComputerControlState(); const old=deferred<ComputerTarget[]>(); const latest=deferred<ComputerTarget[]>();
 const first=editor.refresh(()=>old.promise); const second=editor.refresh(()=>latest.promise); latest.resolve([row("new")]);await second;old.reject(new Error("old"));await first;
 assert.equal(editor.state.rows[0]?.id,"new"); assert.equal(editor.state.error,"");
});
test("refresh failure retains previous information and expanded rows",async()=>{
 const editor=createComputerControlState();await editor.refresh(async()=>[row("a")]); editor.state.expanded.add("a");
 await editor.refresh(async()=>{throw new Error("source failed");});assert.equal(editor.state.rows[0]?.status,"unknown");assert.equal(editor.state.expanded.has("a"),true);assert.equal(editor.state.error,"source failed");
});
test("settings readback retains dirty fields, CAS conflict retains draft and confirmed revision",async()=>{
 const editor=createComputerControlState();editor.acceptSettings("a",snapshot(true));const draft=editor.state.drafts.get("a")!;draft.value.enabled=false;draft.changes.set("enabled",false);draft.revision++;
 editor.acceptSettings("a",snapshot(true,"v2"));assert.equal(draft.value.enabled,false);
 await editor.save("a",{enabled:false},async(body,etag)=>{assert.deepEqual(body,{enabled:false});assert.equal(etag,"v2");throw Object.assign(new Error("conflict"),{status:409});});
 assert.equal(draft.conflict,true);assert.equal(draft.value.enabled,false);assert.equal(draft.changes.size,1);
});
test("new editing while saving stays dirty after original save confirmation",async()=>{
 const editor=createComputerControlState();editor.acceptSettings("a",snapshot(true));const draft=editor.state.drafts.get("a")!;draft.value.enabled=false;draft.changes.set("enabled",false);draft.revision++;
 const result=deferred<ReturnType<typeof snapshot>>();const saving=editor.save("a",{enabled:false},()=>result.promise);draft.value.enabled=true;draft.changes.set("enabled",true);draft.revision++;result.resolve(snapshot(false,"v2"));await saving;
 assert.equal(draft.value.enabled,true);assert.equal(draft.changes.get("enabled"),true);assert.equal(draft.saved.etag,"v2");
});
test("dispose ignores late list and settings responses without creating work",async()=>{
 const editor=createComputerControlState();const result=deferred<ComputerTarget[]>();const reading=editor.refresh(()=>result.promise);editor.dispose();result.resolve([row("late")]);await reading;editor.acceptSettings("a",snapshot(true));assert.deepEqual(editor.state.rows,[]);assert.equal(editor.state.drafts.size,0);
});
test("partial setting patch only includes submitted nested field",()=>{assert.deepEqual(writeField({},["features","input"],false),{features:{input:false}});});

test("failed owner retains cached node as unknown while healthy source refreshes",async()=>{const editor=createComputerControlState();await editor.refresh(async()=>[{...row("a"),ownerDeviceId:"failed"},row("b")]);await editor.refresh(async()=>({computers:[row("b","offline")],sourceErrors:[{ownerDeviceId:"failed",message:"not reachable"}]}));assert.equal(editor.state.rows[0]?.id,"a");assert.equal(editor.state.rows[0]?.status,"unknown");assert.equal(editor.state.rows[1]?.status,"offline");});

test("ordinary stored-settings refresh never erases an unconfirmed application receipt",async()=>{const editor=createComputerControlState();editor.acceptSettings("a",snapshot(true));const draft=editor.state.drafts.get("a")!;draft.changes.set("enabled",false);await editor.save("a",{enabled:false},async()=>({...snapshot(false,"v2"),execution:"unconfirmed",executionIssue:"cleanup pending"}));editor.acceptSettings("a",snapshot(false,"v2"));assert.equal(draft.application?.state,"unconfirmed");assert.equal(draft.application?.issue,"cleanup pending");assert.equal(draft.changes.size,0);});
