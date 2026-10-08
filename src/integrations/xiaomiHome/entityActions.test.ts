import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverHomeEntityActions, HOME_ENTITY_ACTION_CAPABILITY, validateHomeActionValue, type HomeServiceDomain } from "./entityActions.js";
import { XiaomiHomeManagerApiClient } from "./managerApi.js";
import { authorizeAgentApiOperation } from "../../manager/agentApiPolicy.js";

const services: HomeServiceDomain[] = [
  {domain:"button", services:{press:{target:{entity:[{domain:["button"]}]},fields:{}}}},
  {domain:"number", services:{set_value:{target:{entity:[{domain:["number"]}]},fields:{value:{required:true,selector:{number:{min:0,max:100}}}}}}},
  {domain:"select", services:{select_option:{target:{entity:[{domain:["select"]}]},fields:{option:{required:true,selector:{state:{}}}}}}},
  {domain:"notify", services:{send_message:{target:{entity:[{domain:["notify"]}]},fields:{message:{required:true,selector:{text:{}}}}}, global:{fields:{}}}},
  {domain:"vacuum", services:{pause:{target:{entity:[{domain:["vacuum"],supported_features:[4]}]},fields:{}}, start:{target:{entity:[{supported_features:[8192]}]},fields:{}}}},
  {domain:"fan", services:{turn_on:{target:{entity:[{domain:["fan"]}]},fields:{extra:{fields:{percentage:{filter:{supported_features:[1]},selector:{number:{min:0,max:100}}}}}}}}}
];
const state = (entity_id:string, attributes:Record<string,unknown>={}) => ({entity_id,state:entity_id.startsWith("button.")||entity_id.startsWith("notify.")?"unknown":"on",attributes,last_updated:"2026-10-04T00:00:00Z"});
const args = (action:ReturnType<typeof discoverHomeEntityActions>[number], parameters:Record<string,unknown>) => ({action:action.action,actionRevision:action.revision,parameters});

test("discovery follows live service targets, OR feature filters, nested fields and entity-owned bounds/options",()=>{
  const number = discoverHomeEntityActions({entityId:"number.level",attributes:{min:20,max:40}},services)[0];
  assert.doesNotThrow(()=>validateHomeActionValue(args(number,{value:30}),number.argumentsSchema));
  for(const value of [10,50,"30"]) assert.throws(()=>validateHomeActionValue(args(number,{value}),number.argumentsSchema));
  const select = discoverHomeEntityActions({entityId:"select.mode",attributes:{options:["quiet","fast"]}},services)[0];
  assert.throws(()=>validateHomeActionValue(args(select,{option:"invented"}),select.argumentsSchema));
  assert.deepEqual(discoverHomeEntityActions({entityId:"sensor.temperature",attributes:{}},services),[]);
  assert.deepEqual(discoverHomeEntityActions({entityId:"vacuum.robot",attributes:{supported_features:4}},services).map(a=>a.action),["pause"]);
  assert.equal(discoverHomeEntityActions({entityId:"fan.example",attributes:{supported_features:0}},services)[0].argumentsSchema.properties?.parameters.properties?.percentage,undefined);
});

test("MIoT actions publish positional parameter schemas; unknown action types are rejected",()=>{
  const notify = discoverHomeEntityActions({entityId:"notify.robot_remote",attributes:{"action params":"[Direction(int), Enabled(bool), Payload(str)]"}},services);
  assert.equal(notify.length,1); // The global notify service has no bound entity target.
  assert.doesNotThrow(()=>validateHomeActionValue(args(notify[0],{values:[1,true,'{"region":[]}']}),notify[0].argumentsSchema));
  for(const values of [[1,"true","x"],[1.5,true,"x"],[1,true],[1,true,"x",4]]) assert.throws(()=>validateHomeActionValue(args(notify[0],{values}),notify[0].argumentsSchema));
  assert.throws(()=>discoverHomeEntityActions({entityId:"notify.example",attributes:{"action params":"[Value(unknown)]"}},services));
});

test("constant selectors keep their type and untranslated selectors accept bounded provider JSON",()=>{
  const action = discoverHomeEntityActions({entityId:"light.example",attributes:{}},[{domain:"light",services:{turn_on:{
    target:{entity:[{domain:["light"]}]}, fields:{white:{selector:{constant:{value:true}}},
      media:{selector:{media:{}}}, future:{selector:{future_selector:{}}}, label:{selector:{text:{}}}}
  }}}])[0];
  assert.doesNotThrow(()=>validateHomeActionValue(args(action,{white:true,media:{media_content_id:"example",media_content_type:"music"},future:[1,true],label:"name"}),action.argumentsSchema));
  for(const white of [false,"true",1]) assert.throws(()=>validateHomeActionValue(args(action,{white}),action.argumentsSchema));
  assert.throws(()=>validateHomeActionValue(args(action,{label:12}),action.argumentsSchema));
  assert.throws(()=>validateHomeActionValue(args(action,{future:[...Array(257).fill(1)]}),action.argumentsSchema));
  assert.throws(()=>validateHomeActionValue(args(action,{media:{value:Infinity}}),action.argumentsSchema));
});

test("unknown button state is callable; provider POST happens once, receipt survives restart without storing action data",async()=>{
  const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-entity-action-")); let posts=0;
  const fake:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith("/api/services"))return new Response(JSON.stringify(services));
    if(init?.method==="POST"){posts++;assert.ok(url.endsWith("/button/press"));assert.deepEqual(JSON.parse(String(init.body)),{entity_id:"button.robot_locate"});return new Response("[]");}
    return new Response(JSON.stringify(state("button.robot_locate")));
  };
  try{
    const client=new XiaomiHomeManagerApiClient({runtimeDir},fake,"token");
    const resource=await client.getResourceActions("home:ha:button.robot_locate");
    assert.ok(resource.capabilities.includes(HOME_ENTITY_ACTION_CAPABILITY));
    const request={resourceId:resource.resourceId,capability:HOME_ENTITY_ACTION_CAPABILITY,expectedStateVersion:resource.stateVersion,arguments:args(resource.actions![0],{})};
    const [first,second]=await Promise.all([client.executeAction(request,"entity-once"),client.executeAction(request,"entity-once")]);
    assert.equal(first.status,"accepted");assert.deepEqual(first,second);assert.equal(posts,1);
    const offline=new XiaomiHomeManagerApiClient({runtimeDir},async()=>{throw Error("offline");},"token");
    assert.deepEqual(await offline.executeAction(request,"entity-once"),first);
    await assert.rejects(()=>offline.executeAction({...request,arguments:{...request.arguments,parameters:{value:1}}},"entity-once"),/another action payload/);
  }finally{fs.rmSync(runtimeDir,{recursive:true,force:true});}
});

test("advertised setting actions can initialize an unknown reading without treating it as offline",async()=>{
  const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-unknown-setting-"));let posts=0;
  const fake:typeof fetch=async(input,init)=>{
    if(String(input).endsWith("/api/services"))return new Response(JSON.stringify(services));
    if(init?.method==="POST"){posts++;assert.deepEqual(JSON.parse(String(init.body)),{value:25,entity_id:"number.setting"});return new Response("[]");}
    return new Response(JSON.stringify({...state("number.setting",{min:0,max:40}),state:"unknown"}));
  };
  try{
    const client=new XiaomiHomeManagerApiClient({runtimeDir},fake,"token"),r=await client.getResourceActions("home:ha:number.setting");
    const receipt=await client.executeAction({resourceId:r.resourceId,capability:HOME_ENTITY_ACTION_CAPABILITY,expectedStateVersion:r.stateVersion,arguments:args(r.actions![0],{value:25})},"initialize-setting");
    assert.equal(receipt.status,"accepted");assert.equal(receipt.confirmation,"provider_acceptance");assert.equal(posts,1);
  }finally{fs.rmSync(runtimeDir,{recursive:true,force:true});}
});

test("live schema changes, offline resources, wrong target fields and rehearsal cannot publish a device action",async()=>{
  for(const mode of ["bounds","option","schema","target","offline","dryRun"]){
    const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-entity-rejection-"));let posts=0;
    const entityId=mode==="option"?"select.mode":"number.level";
    const fake:typeof fetch=async(input,init)=>{
      if(String(input).endsWith("/api/services"))return new Response(JSON.stringify(services));
      if(init?.method==="POST"){posts++;return new Response("[]");}
      return new Response(JSON.stringify({...state(entityId,{min:0,max:40,options:["quiet"]}),state:mode==="offline"?"unavailable":"on"}));
    };
    try{
      const client=new XiaomiHomeManagerApiClient({runtimeDir},fake,"token");const r=await client.getResourceActions("home:ha:"+entityId);
      const parameters:Record<string,unknown>=mode==="option"?{option:"invalid"}:{value:mode==="bounds"?50:30};
      if(mode==="target")parameters.entity_id="number.other";
      const actionArgs=args(r.actions![0],parameters);if(mode==="schema")actionArgs.actionRevision="ha-action:"+"0".repeat(24);
      const request={resourceId:r.resourceId,capability:HOME_ENTITY_ACTION_CAPABILITY,expectedStateVersion:r.stateVersion,arguments:actionArgs,dryRun:mode==="dryRun"};
      if(mode==="target")await assert.rejects(()=>client.executeAction(request,"reject-"+mode),/target/);
      else assert.equal((await client.executeAction(request,"reject-"+mode)).status,mode==="dryRun"?"planned":"failed");
      assert.equal(posts,0);
    }finally{fs.rmSync(runtimeDir,{recursive:true,force:true});}
  }
});

test("lost parameterized notify response stays uncertain and is never resent",async()=>{
  const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-entity-lost-"));let posts=0;
  const fake:typeof fetch=async(input,init)=>{
    if(String(input).endsWith("/api/services"))return new Response(JSON.stringify(services));
    if(init?.method==="POST"){posts++;assert.deepEqual(JSON.parse(String(init.body)),{entity_id:"notify.robot_room",message:'["private-room-input"]'});throw Error("lost response");}
    return new Response(JSON.stringify(state("notify.robot_room",{"action params":"[Room(str)]"})));
  };
  try{
    const client=new XiaomiHomeManagerApiClient({runtimeDir},fake,"token");const r=await client.getResourceActions("home:ha:notify.robot_room");
    const request={resourceId:r.resourceId,capability:HOME_ENTITY_ACTION_CAPABILITY,arguments:args(r.actions![0],{values:["private-room-input"]}),expectedStateVersion:r.stateVersion};
    await assert.rejects(()=>client.executeAction(request,"notify-lost"),/uncertain/);
    await assert.rejects(()=>new XiaomiHomeManagerApiClient({runtimeDir},fake,"token").executeAction(request,"notify-lost"),/uncertain/);
    assert.equal(posts,1);assert.equal(client.getActionReceipt("notify-lost").state,"uncertain");
    const files=fs.readdirSync(path.join(runtimeDir,"data/xiaomi-home-actions")).filter(file=>file.endsWith(".json"));
    assert.ok(files.length);for(const file of files)assert.doesNotMatch(fs.readFileSync(path.join(runtimeDir,"data/xiaomi-home-actions",file),"utf8"),/private-room-input/);
  }finally{fs.rmSync(runtimeDir,{recursive:true,force:true});}
});

test("Agent catalog exposes all-device discovery and single-resource actions without another permission",()=>{
  assert.equal(authorizeAgentApiOperation("GET","/api/agent/xiaomi-home/resources?includeActions=1").allowed,true);
  assert.equal(authorizeAgentApiOperation("GET","/api/agent/xiaomi-home/entity-actions?resourceId=home%3Aha%3Anotify.robot").allowed,true);
  assert.equal(authorizeAgentApiOperation("GET","/api/agent/xiaomi-home/entity-actions?token=secret").allowed,false);
});
