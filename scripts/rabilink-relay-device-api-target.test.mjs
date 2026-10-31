import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

test('generic HTTP defaults only to explicit connection metadata and never to the old task target', {timeout:20000}, async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-default-target-'));
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:directory,RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS:'3000'},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}fs.rmSync(directory,{recursive:true,force:true});});
  for(let retry=0;retry<60;retry++){try{if((await fetch(base+'/health')).ok)break;}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
  async function json(url,method='GET',body,headers={}) {
    const response=await fetch(base+url,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json(),headers:response.headers};
  }
  const account=await json('/manage/api/accounts','POST',{username:'target-fixture',password:randomUUID()});assert.equal(account.status,200);
  const cookie=account.headers.get('set-cookie').split(';')[0];
  const created=await json('/manage/api/apps','POST',{name:'Target fixture',targetDeviceId:'pc-task'},{cookie});assert.equal(created.status,200);
  const app=created.value.app, auth={'x-rabilink-token':app.token};
  const poll=(id,waitMs=0)=>json('/worker/webgui-requests?'+new URLSearchParams({deviceId:id,deviceGuid:'guid-'+id,deviceName:'Fixture PC',capabilities:'webgui,tasks',waitMs:String(waitMs)}),'GET',undefined,auth);
  for(const id of ['pc-task','pc-owner','pc-device','pc-explicit'])assert.equal((await poll(id)).status,200);
  const missing=await json('/api/rabilink/device/api','POST',{request:{method:'GET',path:'/api/future'}},auth);
  assert.equal(missing.status,409);assert.equal(missing.value.code,'API_CONNECTION_TARGET_REQUIRED');
  assert.equal((await poll('pc-task')).value.requests.length,0);
  assert.equal((await json('/api/rabilink/mobile/connection','PATCH',{connectionOwnerDeviceId:'pc-owner'},auth)).status,200);
  async function forwarded(headers,targetDeviceId,body={}) {
    const pending=json('/api/rabilink/device/api','POST',{request:{method:'GET',path:'/api/future'},...body},headers);
    const claimed=await poll(targetDeviceId,1000), request=claimed.value.requests[0];assert.ok(request);
    assert.equal(request.targetDeviceId,targetDeviceId);assert.equal(request.path,'/api/future');
    if(headers['x-rabi-timeout-ms']) assert.equal(request.expiresAt-request.createdAt,Number(headers['x-rabi-timeout-ms']));
    const done=await json('/worker/webgui-requests/'+encodeURIComponent(request.id)+'/response','POST',{
      deviceId:targetDeviceId,deviceGuid:'guid-'+targetDeviceId,ok:true,statusCode:200,headers:{'content-type':'application/json'},bodyBase64:Buffer.from('{"code":0,"data":{"value":1}}').toString('base64')
    },auth);assert.equal(done.status,200);
    const result=await pending;assert.equal(result.status,200);assert.equal(result.value.data.structuredContent.ok,true);
  }
  await forwarded({...auth,'x-rabi-timeout-ms':'91000'},'pc-owner');
  await forwarded(auth,'pc-owner');
  const binding=await json('/manage/api/apps/'+encodeURIComponent(app.id)+'/devices','POST',{serialNumber:'SN-DEFAULT-TARGET',connectionTargetDeviceId:'pc-device'},{cookie});assert.equal(binding.status,200);
  const credential=await json('/api/rabilink/devices/token','POST',{serialNumber:'SN-DEFAULT-TARGET'});assert.equal(credential.status,200);
  await forwarded({'x-rabilink-token':credential.value.token},'pc-device');
  await forwarded(auth,'pc-explicit',{targetDeviceId:'pc-explicit'});
  assert.equal((await poll('pc-task')).value.requests.length,0);
  const raw=JSON.parse(fs.readFileSync(path.join(directory,'apps.json'),'utf8'));
  assert.equal(raw.apps.find(row=>row.id===app.id).targetDeviceId,'pc-task');
});
