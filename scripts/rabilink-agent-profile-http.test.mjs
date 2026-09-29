import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
const sha = s => createHash('sha256').update(s).digest('hex');
test('real Relay profile HTTP enforces identity, CSRF, CAS, replay and durable reload', async () => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'profile-http-'));
 const listener=net.createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening'); const port=listener.address().port; await new Promise(r=>listener.close(r));
 const base=`http://127.0.0.1:${port}`;
 let child;
 async function start(){child=spawn(process.execPath,[path.resolve('scripts/rabilink-relay-server.mjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RABILINK_RELAY_DATA_DIR:directory},stdio:'ignore'}); for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,50));}throw new Error('Startup failed');}
 async function stop(){const exited=once(child,'exit');child.kill();await exited;}
 async function request(route,method='GET',body,headers={}){const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 try {
 await start();
 const a=await request('/manage/api/accounts','POST',{username:'profile-owner',password:'test-only-strong-password'});assert.equal(a.status,200);
 const created=await request('/manage/api/apps','POST',{name:'fixture'}, {cookie:a.cookie});assert.equal(created.status,200);
 const appId=created.body.app.id, appToken=created.body.app.token;
 const file=path.join(directory,'apps.json'); const store=JSON.parse(fs.readFileSync(file));
 store.apps[0].deviceBindings=[{id:'glass',serialHash:sha('serial-fixture'),credentialHash:sha('rbd_fixture'),enabled:true}];fs.writeFileSync(file,JSON.stringify(store));
 const route=`/manage/api/apps/${appId}/devices/glass/agent-profile`;
 assert.equal((await request(route)).status,401);
 const other=await request('/manage/api/accounts','POST',{username:'profile-other',password:'test-only-strong-password'});
 assert.equal((await request(route,'GET',undefined,{cookie:other.cookie})).status,404);
 const profile={revision:1,id:'assistant',name:'Assistant',systemPrompt:'Be clear',skills:[],mcp:[]};
 const input={expectedRevision:0,idempotencyKey:'save-1',profile};
 assert.equal((await request(route,'PUT',input,{cookie:a.cookie})).status,403);
 const headers={cookie:a.cookie,'x-rabilink-profile-write':'1',origin:base};
 assert.equal((await request(route,'PUT',input,{...headers,origin:'https://attacker.invalid'})).status,403);
 assert.equal((await request(route,'PUT',input,headers)).status,200);
 assert.equal((await request(route,'PUT',input,headers)).status,200);
 assert.equal((await request(route,'PUT',{...input,profile:{...profile,name:'Changed'}},headers)).status,409);
 assert.equal((await request(route,'PUT',{...input,idempotencyKey:'save-2',profile:{...profile,revision:2}},headers)).status,412);
 const own='/api/rabilink/device/agent-profile';
 assert.equal((await request(own,'GET',undefined,{'x-rabilink-token':appToken})).status,403);
 const deviceHeaders={'x-rabilink-token':'rbd_fixture'};
 assert.equal((await request(own,'GET',undefined,deviceHeaders)).body.data.savedRevision,1);
 const ack={idempotencyKey:'ack-1',appliedRevision:1,status:'applied'};
 assert.equal((await request(own+'/applied','POST',ack,deviceHeaders)).status,200);
 await stop(); await start();
 const restored=await request(own,'GET',undefined,deviceHeaders);assert.equal(restored.body.data.profile.name,'Assistant');assert.equal(restored.body.data.applied.appliedRevision,1);
 // Corrupt data must fail closed and remain intact, never become a new empty store.
 fs.writeFileSync(file,'invalid-json');assert.equal((await request(own,'GET',undefined,deviceHeaders)).status,500);assert.equal(fs.readFileSync(file,'utf8'),'invalid-json');
 } finally {if(child && child.exitCode===null)await stop();fs.rmSync(directory,{recursive:true,force:true});}
});
