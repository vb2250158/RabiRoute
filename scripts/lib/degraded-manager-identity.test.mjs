import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverManagerIdentity} from './discover-manager-url.mjs';
import {discoverWindowsHostIdentity} from './windows-host-discovery.mjs';
const identity={managerBaseUrl:'http://127.0.0.1:51234',applicationGenerationId:'fixture-generation',managerInstanceId:'fixture-manager'};
const meta={...identity,health:{live:true,requiredReady:false,state:'degraded'}};
for(const [name,discover]of [['manager',discoverManagerIdentity],['windows-host',discoverWindowsHostIdentity]]){
 test(name+': a live degraded required-capability failure preserves discovery without another Host query',async()=>{
  let calls=0;
  const result=await discover({platform:'win32',env:{RABIROUTE_HOST_EXE:'C:/fixture/Host.exe',RABIROUTE_MANAGER_ENDPOINT_FILE:'C:/fixture/endpoint.json'},
   readFile:async()=>JSON.stringify({schemaVersion:1,...identity}),
   fetch:async(url,options)=>{calls++;assert.equal(url,identity.managerBaseUrl+'/meta');assert.equal(options.redirect,'error');assert.ok(options.signal);return{ok:true,json:async()=>meta}},
   execFile:async()=>{throw Error('Healthy selected identity must not be rediscovered')}});
  assert.deepEqual(result,identity);assert.equal(calls,1);assert.equal(meta.health.requiredReady,false);
 });
 test(name+': stopped or failed Manager remains unavailable',async()=>{
  for(const health of [{live:false,requiredReady:true,state:'healthy'},{live:true,requiredReady:false,state:'failed'}]){
   await assert.rejects(discover({explicit:identity.managerBaseUrl,env:{},fetch:async()=>({ok:true,json:async()=>({...identity,health})})}),/not ready/);
  }
 });
 test(name+': current identity and selected owner still fence a degraded Manager',async()=>{
  await assert.rejects(discover({platform:'win32',env:{RABIROUTE_HOST_EXE:'C:/fixture/Host.exe',RABIROUTE_MANAGER_ENDPOINT_FILE:'C:/fixture/endpoint.json'},
   readFile:async()=>JSON.stringify({schemaVersion:1,...identity,managerInstanceId:'previous-manager'}),
   fetch:async()=>({ok:true,json:async()=>meta}),execFile:async()=>({stdout:JSON.stringify({ok:true,...identity,managerInstanceId:'previous-manager'})})}));
 });
}
