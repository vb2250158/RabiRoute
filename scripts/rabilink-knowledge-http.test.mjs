import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
test('real Relay knowledge grant owner and device gate',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-http-'));const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:dir},stdio:'ignore'});
 async function req(p,method='GET',body,headers={}){const r=await fetch(base+p,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try {let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
 const account=await req('/manage/api/accounts','POST',{username:'knowledge-owner',password:'test-only-safe-password'});const created=await req('/manage/api/apps','POST',{name:'fixture'},{cookie:account.cookie});const app=created.data.app;const file=path.join(dir,'apps.json');const store=JSON.parse(fs.readFileSync(file));store.apps[0].deviceBindings=[{id:'glass',serialHash:'fixture',credentialHash:createHash('sha256').update('rbd_fixture').digest('hex')}];fs.writeFileSync(file,JSON.stringify(store));
 const other=await req('/manage/api/accounts','POST',{username:'knowledge-other',password:'test-only-safe-password'});
 const operation=`/manage/api/apps/${app.id}/devices/glass/agent-profile/operations/missing`;
 assert.equal((await req(operation,'GET',null,{cookie:other.cookie})).status,404);
 assert.equal((await req(operation,'GET',null,{cookie:account.cookie})).data.data.receipt,null);
 const endpoint=`/manage/api/apps/${app.id}/devices/glass/knowledge-grant`;assert.equal((await req(endpoint)).status,401);const headers={cookie:account.cookie,'x-rabilink-profile-write':'1',origin:base};assert.equal((await req(endpoint,'GET',null,headers)).data.data.revision,0);
 const input={expectedRevision:0,idempotencyKey:'grant-one',grant:{allowedRoles:['example'],allowedTools:['plan_list'],allowWrites:false}};assert.equal((await req(endpoint,'PUT',input,headers)).status,200);assert.equal((await req(endpoint,'PUT',input,headers)).status,200);assert.equal((await req(endpoint,'PUT',{...input,idempotencyKey:'two'},headers)).status,412);
 const history=endpoint+'/operations/grant-one';
  assert.equal((await req(history,'GET',null,{cookie:other.cookie})).status,404);
  assert.deepEqual((await req(history,'GET',null,headers)).data.data.receipt,{idempotencyKey:'grant-one',revision:1,grant:input.grant});
  assert.equal((await req(endpoint+'/operations/missing','GET',null,headers)).data.data.receipt,null);
  const own='/api/rabilink/device/knowledge';assert.equal((await req(own,'POST',{operation:'list'},{'x-rabilink-token':app.token})).status,403);assert.equal((await req(own,'POST',{operation:'list'},{'x-rabilink-token':'rbd_fixture'})).status,409);
 } finally {const exited=once(child,'exit');child.kill();await exited;fs.rmSync(dir,{recursive:true,force:true});}
});
