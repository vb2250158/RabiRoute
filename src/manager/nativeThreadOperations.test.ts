import test from 'node:test';import assert from 'node:assert/strict';
import {handleAgentThreadRequest,readAgentEndpointSummary} from '../agentThreads.js';
import {installAgentAdapterManifestReader} from '../shared/agentAdapterCapabilities.js';
test('a published native thread owner handles its own list/read while retirement never falls back to Codex',async()=>{
 let enabled=true;const requests:unknown[]=[];
 const remove=installAgentAdapterManifestReader(()=>enabled?[{type:'owned-fixture',label:'Owned',maturity:'experimental',transport:{protocol:'in-process',mode:'owned-session'},capabilities:{nativeThreadOperations:true,managedTasks:{agentThreads:true}}}]:[]);
 const options={allowedWorkspaces:[],invokeAgentOperation:async <T>(type:string,operation:string,payload:unknown)=>{
   assert.equal(type,'owned-fixture');assert.equal(operation,'threads.request');requests.push(payload);const request=(payload as {request:{action:string;threadId?:string}}).request;
   return {statusCode:200,data:request.action==='list'?{threads:[{id:'session',title:'Owned',cwd:process.cwd()}]}:{thread:{id:'session',title:'Owned',cwd:process.cwd()}}} as T;
 }};
 try{const list=await handleAgentThreadRequest({action:'list',agentAdapter:'owned-fixture'},options);assert.equal(list.statusCode,200);
  const read=await readAgentEndpointSummary('owned-fixture','session',options);assert.equal(read.id,'session');assert.equal(requests.length,2);
  enabled=false;await assert.rejects(handleAgentThreadRequest({action:'read',threadId:'session',agentAdapter:'owned-fixture'},options));assert.equal(requests.length,2);
 }finally{remove()}
});
