import assert from "node:assert/strict";
import test from "node:test";
import { homeDeviceClient, vacuumVideoClient, parameterDefaults, deviceIcon, vacuumVideoSwitch, type DeviceDirectory } from "../src/homeDeviceClient.js";
const choice={id:"home.vacuum.start@1",title:"Start",capability:"home.vacuum.start@1",argumentsSchema:{type:"object"}};
function fixture(options:{lost?:boolean;switchIdentity?:boolean;reject?:boolean}={}){
 const original=globalThis.fetch;let metas=0;const requests:Array<{url:string;init:RequestInit}>=[];
 globalThis.fetch=(async(input,init={})=>{const url=String(input);requests.push({url,init});
  if(url==="/meta")return Response.json({applicationGenerationId:options.switchIdentity&&++metas>2?"generation-b":"generation-a",managerInstanceId:"instance-a"});
  if(url.includes("entity-actions"))return Response.json({code:0,data:{resourceId:"home:ha:vacuum.test",stateVersion:"fresh-state",capabilities:[choice.capability]}});
  if(init.method==="POST") {if(options.lost)throw Error("lost response");if(options.reject)return Response.json({code:-1,error:{message:"parameters invalid"}},{status:400});return Response.json({code:0,data:{status:"accepted",confirmation:"provider_acceptance"}});}
  return Response.json({code:0,data:{idempotencyKey:"stable-action-key",state:"completed",receipt:{status:"accepted"}}});
 }) as typeof fetch;
 return{requests,restore(){globalThis.fetch=original;}};
}
test("device action uses fresh state, stable key and exact current identity",async()=>{const f=fixture();try{
 const result=await homeDeviceClient.execute("home:ha:vacuum.test",choice,{},true,"stable-action-key");assert.equal(result.state,"completed");
 const posts=f.requests.filter(r=>r.init.method==="POST");assert.equal(posts.length,1);assert.equal((posts[0]!.init.headers as any)["Idempotency-Key"],"stable-action-key");assert.equal(JSON.parse(String(posts[0]!.init.body)).expectedStateVersion,"fresh-state");assert.equal(JSON.parse(String(posts[0]!.init.body)).dryRun,true);
 }finally{f.restore();}});
test("lost POST response queries the original receipt and never replays",async()=>{const f=fixture({lost:true});try{const result=await homeDeviceClient.execute("home:ha:vacuum.test",choice,{},false,"stable-action-key");assert.equal(result.state,"completed");assert.equal(f.requests.filter(r=>r.init.method==="POST").length,1);assert.ok(f.requests.some(r=>r.url.includes("idempotencyKey=stable-action-key")));}finally{f.restore();}});
test("identity change after write reports uncertain even with accepted receipt",async()=>{const f=fixture({switchIdentity:true});try{const result=await homeDeviceClient.execute("home:ha:vacuum.test",choice,{},false,"stable-action-key");assert.equal(result.state,"uncertain");assert.equal(f.requests.filter(r=>r.init.method==="POST").length,1);}finally{f.restore();}});
test("known parameter rejection reports failure",async()=>{const f=fixture({reject:true});try{const result=await homeDeviceClient.execute("home:ha:vacuum.test",choice,{},false,"stable-action-key");assert.equal(result.state,"failed");assert.match(result.error!,/parameters invalid/);}finally{f.restore();}});
test("parameter form preserves JSON types and vacuum icon takes priority",()=>{assert.deepEqual(parameterDefaults({properties:{volume:{type:"number",minimum:0},muted:{type:"boolean"},values:{type:"array",prefixItems:[{type:"string"},{type:"integer",minimum:1}]}},required:["volume","muted","values"]}),{volume:0,muted:false,values:["",1]});assert.equal(deviceIcon([{kind:"sensor"},{kind:"vacuum"}] as any),"mdi-robot-vacuum");});
test("video status uses only the selected device's verified switch, never a sharing switch or camera",()=>{
 const switchResource={kind:"switch",entityId:"switch.xiaomi_cn_123_pv11cn_on_p_21_6",resourceId:"video-switch"};
 const device={model:"xiaomi.vacuum.pv11cn",resources:[{...switchResource,entityId:"switch.xiaomi_cn_123_pv11cn_visible_to_shared_users_p_21_5"},{kind:"camera",entityId:"camera.other"},switchResource]} as DeviceDirectory["devices"][number];
 assert.equal(vacuumVideoSwitch(device)?.resourceId,"video-switch");
 assert.equal(vacuumVideoSwitch({...device,model:"other.model"}),undefined);
 assert.equal(vacuumVideoSwitch({...device,resources:device.resources.slice(0,2)}),undefined);
});
test("closing video status inspection cancels its bounded read without sending actions",async()=>{
 const original=globalThis.fetch,controller=new AbortController();let signal:AbortSignal|undefined;
 globalThis.fetch=async(_url,init)=>{signal=init?.signal ?? undefined;return new Promise<Response>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")),{once:true}));};
 try {const pending=homeDeviceClient.inspect("home:ha:switch.video",controller.signal);controller.abort();await assert.rejects(pending,{name:"AbortError"});assert.equal(signal?.aborted,true);} finally {globalThis.fetch=original;}
});

test("video PIN goes only in the fenced POST body; lost response queries the same key without resending it",async()=>{
 const f=fixture({lost:true});try {
  await vacuumVideoClient.start("123","video-pin-stable-01","4821");
  const posts=f.requests.filter(r=>r.init.method==="POST");assert.equal(posts.length,1);
  assert.equal(JSON.parse(String(posts[0]!.init.body)).password,"4821");
  assert.ok(f.requests.every(r=>!r.url.includes("4821")));
  assert.ok(f.requests.some(r=>r.url.includes("idempotencyKey=video-pin-stable-01")));
 }finally{f.restore();}
});


test("remember PIN is explicit and forgetting reconciles its original key without replay",async()=>{
 const f=fixture({lost:true});try {
  await vacuumVideoClient.start("123","video-remember-stable-01","4821",true);
  assert.equal(JSON.parse(String(f.requests.find(r=>r.init.method==="POST")!.init.body)).rememberPassword,true);
  await vacuumVideoClient.forgetPassword("123","video-forget-stable-01");
  const posts=f.requests.filter(r=>r.init.method==="POST");assert.equal(posts.length,2);
  assert.ok(f.requests.some(r=>r.url.endsWith("video/password?idempotencyKey=video-forget-stable-01")));
  assert.deepEqual(JSON.parse(String(posts[1]!.init.body)),{deviceId:"123",region:"cn"});
 }finally{f.restore();}
});

test("video network diagnosis reads only the selected device and never starts a camera",async()=>{
 const f=fixture();try {
  await vacuumVideoClient.network("123");
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0]!.url,"/api/agent/xiaomi-home/vacuum-cloud/video/network?deviceId=123&region=cn");
  assert.equal(f.requests[0]!.init.method,undefined);
 }finally{f.restore();}
});
