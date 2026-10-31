import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bootstrap = `
  import assert from 'node:assert/strict';
  import {EventEmitter} from 'node:events';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import http from 'node:http';
  import {Socket} from 'node:net';
  import {createQqMessageOperations} from './src/manager/qqMessageRoutes.ts';
  import {createQqStickerOperations} from './src/manager/qqStickerRoutes.ts';
  import {createAgentQqDiagnosticsOperation} from './src/manager/agentQqDiagnostics.ts';
  import {createPersonaResourceOperations} from './src/manager/personaResourceOperations.ts';
  import {qqReadSettings} from './src/shared/qqReadSettings.ts';
  import {personaReadSettings} from './src/shared/personaReadSettings.ts';
  import {ReadSettingsError} from './src/shared/readSettingsError.ts';
  import {ManagerPluginRouteRegistry} from './src/manager/managerPluginRouteRegistry.ts';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'read-settings-isolation-'));
  const role=path.join(root,'Example');fs.mkdirSync(role);fs.writeFileSync(path.join(role,'persona.md'),'valid document');
  const identity=()=>({applicationGenerationId:'generation',managerInstanceId:'manager'});
  const definition={id:'route',enabled:true,messageAdapters:['napcat'],napcatInstances:[{id:'account',enabled:true,httpUrl:'http://localhost:1234'}]};
  const stickerId='0123456789abcdef0123456789abcdef';
  const context={local:()=>true,route:()=>definition,json:()=>{},transport:async(url)=>{
    if(String(url).includes('fetch_custom_face'))return Response.json({status:'ok',retcode:0,data:[{md5:stickerId,url:'https://cdn.example/image'}]});
    if(String(url).includes('cdn.example'))return new Response('image',{headers:{'content-type':'image/png'}});
    return Response.json({status:'ok',retcode:0,data:{messages:[]}});
  }};
  // Registration must not evaluate any unrelated malformed process preference.
  const messages=createQqMessageOperations(context),stickers=createQqStickerOperations(context);
  const diagnostics=createAgentQqDiagnosticsOperation({route:()=>definition,readStatus:()=>({}),routeRunning:()=>true,routeStartedAt:()=>'',jsonResponse:()=>{}});
  const personas=createPersonaResourceOperations({rolesRoot:root,roleDirectory:()=>role,identity,validate:async()=>({})});
  assert.equal(messages.length,3);assert.equal(stickers.length,2);assert.ok(diagnostics.contract);assert.equal(personas.length,6);
  const request=()=>Object.assign(new http.IncomingMessage(new Socket()),{method:'GET'});
  const call=(operation,url,params={})=>operation.handler({request:request(),response:new EventEmitter(),url:new URL(url),path:params,body:{}});
  try {
    TEST_BODY
  } finally {
    assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('read-settings-isolation-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
`;

function child(body: string, overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^RABIROUTE_(QQ_|PERSONA_(DOCUMENT|CONFIG|RESPONSE)_MAX_BYTES)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", bootstrap.replace("TEST_BODY", body)], {
    cwd: process.cwd(), env: { ...env, ...overrides }, encoding: "utf8", windowsHide: true, timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("malformed settings do not prevent consumer imports or independent operation registration", () => {
  const keys = ["JSON_MAX_BYTES", "MEDIA_MAX_BYTES", "STICKER_PREVIEW_MAX_BYTES", "READ_TIMEOUT_MS", "MEDIA_TIMEOUT_MS", "STICKER_PREVIEW_TIMEOUT_MS", "READ_CONCURRENCY", "STICKER_COUNT"];
  child(`assert.throws(()=>qqReadSettings.jsonBytes,ReadSettingsError);assert.throws(()=>personaReadSettings.documentBytes,ReadSettingsError);`,
    Object.fromEntries([...keys.map(key => [`RABIROUTE_QQ_${key}`, "bad"]), ...["DOCUMENT", "CONFIG", "RESPONSE"].map(key => [`RABIROUTE_PERSONA_${key}_MAX_BYTES`, "bad"])]));
});

test("bad preview/media/config preferences leave history, sticker metadata and persona documents usable", () => {
  child(`
    assert.equal((await call(messages[0],'http://localhost/api/agent/qq/history?routeId=route&kind=group&target=123')).status,200);
    assert.equal((await call(stickers[0],'http://localhost/api/agent/qq/stickers?routeId=route')).status,200);
    const preview=await call(stickers[1],'http://localhost/api/agent/qq/stickers/'+stickerId+'/preview?routeId=route',{stickerId});
    assert.equal(preview.status,503);assert.equal(preview.body.errorCode,'READ_SETTING_INVALID');assert.match(preview.body.message,/RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES/);
    const document=await call(personas[3],'http://localhost/api/roles/Example/persona-document',{roleId:'Example'});
    assert.equal(document.status,200);assert.equal(document.body.toString(),'valid document');
    const reference=await call(personas[4],'http://localhost/api/roles/Example/persona-reference',{roleId:'Example'});
    assert.equal(reference.status,503);assert.equal(reference.body.error,'READ_SETTING_INVALID');assert.match(reference.body.message,/RABIROUTE_PERSONA_CONFIG_MAX_BYTES/);
  `, { RABIROUTE_QQ_MEDIA_MAX_BYTES: "bad", RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES: "bad", RABIROUTE_PERSONA_CONFIG_MAX_BYTES: "bad" });
});

test("bad read scheduling and document preferences return local diagnostics without consuming a read slot", () => {
  child(`
    for(let i=0;i<3;i++){const result=await call(messages[0],'http://localhost/api/agent/qq/history?routeId=route&kind=group&target=123');assert.equal(result.status,503);assert.match(result.body.message,/RABIROUTE_QQ_READ_TIMEOUT_MS/);}
    const document=await call(personas[3],'http://localhost/api/roles/Example/persona-document',{roleId:'Example'});assert.equal(document.status,503);assert.match(document.body,/RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES/);
    process.env.RABIROUTE_QQ_READ_TIMEOUT_MS='1000';
    assert.equal((await call(messages[0],'http://localhost/api/agent/qq/history?routeId=route&kind=group&target=123')).status,200);
  `, { RABIROUTE_QQ_READ_TIMEOUT_MS: "bad", RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES: "bad" });
});

test("style request quota still bounds original wire bytes and an invalid quota rejects before body parsing", () => {
  for (const value of ["128", "bad"]) child(`
    const registry=new ManagerPluginRouteRegistry();const registration=registry.registerOperations('persona-test',personas);
    const server=http.createServer((req,res)=>registry.handle(req,new URL(req.url,'http://localhost'),res));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const result=await new Promise((resolve,reject)=>{
        const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/roles/Example/persona-reference/language-style',method:'POST',headers:{'content-type':'application/json'}},res=>{
          let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{req.end();resolve({status:res.statusCode,body:JSON.parse(text)});});
        });req.on('error',reject);
        if(process.env.RABIROUTE_PERSONA_CONFIG_MAX_BYTES==='bad')req.write('not completed JSON');
        else req.end(' '.repeat(256)+JSON.stringify({text:'x',revision:'a'.repeat(64)}));
      });
      if(process.env.RABIROUTE_PERSONA_CONFIG_MAX_BYTES==='bad'){assert.equal(result.status,503);assert.equal(result.body.error,'READ_SETTING_INVALID');}
      else assert.equal(result.status,413);
    } finally {server.closeAllConnections();await registration.dispose();await new Promise(resolve=>server.close(resolve));}
  `, { RABIROUTE_PERSONA_CONFIG_MAX_BYTES: value });
});
