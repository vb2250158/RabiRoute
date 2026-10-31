import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createHash,randomBytes } from 'node:crypto';
import { createPersonaSkillOperations,type PersonaSkillContext } from './personaSkillOperations.js';
import { createRoleSkillDownloadOwner,RoleSkillDownloadAdmission } from './roleSkillDownloadRoutes.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { buildRoleSkillArchive } from './roleSkillArchive.js';
import { listRoleSkills,getRoleSkill } from '../roleKnowledge.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';

async function fixture(t:test.TestContext) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-skill-contract-')),roleDir=path.join(directory,'Example'),temporaryRoot=path.join(directory,'private');
  fs.mkdirSync(path.join(roleDir,'skills','bundle'),{recursive:true});fs.mkdirSync(temporaryRoot);
  fs.writeFileSync(path.join(roleDir,'persona.md'),'# Example');
  fs.writeFileSync(path.join(roleDir,'skills','bundle','SKILL.md'),'---\nid: selected\ntitle: Original skill\nsummary: Original summary\nkeywords: [example]\n---\n# Original skill\nOriginal content\n');
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-skill-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const root={current:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'},admission=new RoleSkillDownloadAdmission(1);
  const context:PersonaSkillContext={roleDirectory:()=>path.join(root.current,'Example'),identity:()=>identity,temporaryRoot,admission,
    querySkills:async(dir,id)=>id?getRoleSkill(dir,id):listRoleSkills(dir),
    archive:async(dir,id,output)=>({ok:true,...await buildRoleSkillArchive(dir,id,output)}),reportCleanupError:()=>assert.fail('Unexpected cleanup error')};
  const definitions=createPersonaSkillOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('fixture-skill',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,prefix='/api/roles')=>new Promise<{status:number;headers:http.IncomingHttpHeaders;bytes:Buffer;json():any}>((resolve,reject)=>{const request=http.get(base+prefix+'/Example/skills'+suffix,{headers:{authorization:'Bearer '+credential.token}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:response.statusCode!,headers:response.headers,bytes,json:()=>JSON.parse(bytes.toString())});});});request.on('error',reject);});
  return {directory,roleDir,root,identity,context,definitions,temporaryRoot,admission,call};
}

test('all six Skill operations permit an authenticated empty node and preserve native catalog/content/ZIP bytes',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,6);
  for(const prefix of ['/api/roles','/roles']) {
    const list=await f.call('',prefix);assert.equal(list.status,200);assert.equal(list.json().data[0].id,'selected');
    const detail=await f.call('/selected',prefix);assert.equal(detail.status,200);assert.match(detail.json().data.content,/Original content/);
    const zip=await f.call('/selected/download',prefix);assert.equal(zip.status,200);assert.equal(zip.bytes.readUInt32LE(),0x04034b50);assert.equal(zip.headers['content-type'],'application/zip');assert.equal(zip.headers['x-rabiroute-content-sha256'],createHash('sha256').update(zip.bytes).digest('hex'));assert.equal(zip.headers['content-length'],String(zip.bytes.length));
  }
  for(let attempt=0;f.admission.active&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.admission.active,0);assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
});

test('cancelling a never-started ZIP iterator closes the original file and releases its private lease',async t=>{
  const f=await fixture(t),request=new http.IncomingMessage(new Socket());
  const stream=await createRoleSkillDownloadOwner(f.context).prepare(request,'Example','selected').archive(false);
  assert.equal(f.admission.active,1);assert.equal(fs.readdirSync(f.temporaryRoot).length,1);
  await stream.stream.cancel();await stream.stream.frames.return(undefined);
  assert.equal(f.admission.active,0);assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
});

test('replacing the persona directory during ZIP generation cannot disclose the old artifact or leak its lease',async t=>{
  const f=await fixture(t);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const owner=createRoleSkillDownloadOwner({...f.context,archive:async(...args)=>{const result=await f.context.archive(...args);entered();await gate;return result;}});
  const pending=owner.prepare(new http.IncomingMessage(new Socket()),'Example','selected').archive(false);
  await started;f.root.current=path.join(f.directory,'replacement');release();
  await assert.rejects(pending,(error:any)=>error.statusCode===409);
  assert.equal(f.admission.active,0);assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
});

test('ZIP frame admission fences a changed Manager generation and joins cleanup before rejecting',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.roleDir,'skills','bundle','payload.bin'),randomBytes(256*1024));
  const resource=await createRoleSkillDownloadOwner(f.context).prepare(new http.IncomingMessage(new Socket()),'Example','selected').archive(false);
  assert.equal((await resource.stream.frames.next()).done,false);f.identity.applicationGenerationId='replacement-generation';
  await assert.rejects(resource.stream.frames.next(),(error:any)=>error.statusCode===409);
  await resource.stream.cancel();assert.equal(f.admission.active,0);assert.deepEqual(fs.readdirSync(f.temporaryRoot),[]);
});

test('failed private artifact cleanup retains bounded admission and reports the original cleanup failure',async t=>{
  const f=await fixture(t);let reported=0;
  const owner=createRoleSkillDownloadOwner({...f.context,reportCleanupError:()=>{reported++;}});
  const resource=await owner.prepare(new http.IncomingMessage(new Socket()),'Example','selected').archive(false);
  const original=fsp.rm;t.mock.method(fsp,'rm',async(...args:Parameters<typeof fsp.rm>)=>{if(path.dirname(String(args[0]))===f.temporaryRoot)throw new Error('Controlled cleanup failure');return original(...args);});
  await assert.rejects(resource.stream.cancel(),/Controlled cleanup failure/);assert.equal(f.admission.active,1);assert.equal(reported,1);assert.equal(fs.readdirSync(f.temporaryRoot).length,1);
  t.mock.restoreAll();
});
