import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {testNapcatHealth} from '../plugins/io.rabiroute.endpoint.napcat/src/messageEndpoints/napcatManager.js';
import {NapcatState} from '../shared/napcatStateContract.js';

for(const [error,expected] of [['二维码已过期，请刷新',NapcatState.QuickLoginAvailable],['请扫码登录',NapcatState.QrLoginRequired]] as const)test(`bound quick-login identity and current login signal: ${error}`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'napcat-qr-expiry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let mutations=0;
  const server=http.createServer(async(request,response)=>{
    for await(const _ of request){};
    response.setHeader('content-type','application/json');response.setHeader('connection','close');
    let data:unknown={};
    if(request.url==='/api/auth/login')data={Credential:'test-credential'};
    if(request.url==='/api/QQLogin/CheckLoginStatus')data={isLogin:false,loginError:error};
    if(request.url==='/api/QQLogin/GetQuickLoginListNew')data=[{uin:'10000',isQuickLogin:true,nickName:'Test'}];
    if(request.url?.includes('SetQuickLogin'))mutations++;
    response.end(JSON.stringify({code:0,data}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  const instance={id:'test',name:'Test',gatewayPort:12345,httpUrl:`http://127.0.0.1:${port}`,webuiUrl:`http://127.0.0.1:${port}/webui`,webuiToken:'test-token',botUserId:'10000',launchCommand:'unused',workingDir:root};
  const runtime={definition:{id:'route',gatewayPort:12345,napcatInstances:[instance]}};
  const result=await testNapcatHealth({rootDir:root,getRuntimes:()=>[runtime],normalizeNapCatInstances:()=>[instance],appendLog:()=>undefined,checkHttpEndpoint:async(url:string)=>url===instance.webuiUrl},{gatewayId:'route',instanceId:'test',inspectProcesses:false,readWebuiLoginInfo:true});
  assert.equal(result.webui?.loginInfo?.status,expected);assert.equal(mutations,0);
});
