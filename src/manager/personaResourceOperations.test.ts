import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createPersonaResourceOperations } from './personaResourceOperations.js';
import { createPersonaAvatarOwner } from './personaAvatarRoutes.js';
import { createPersonaDocumentOwner } from './personaDocumentRoutes.js';
import { createPersonaReferenceOwner } from './remotePersonaRoutes.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { PERSONA_AVATAR_MAX_BYTES } from '../shared/personaAvatarContract.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';

const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
async function fixture(t:test.TestContext,remote=false) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-resource-contract-')),roleDir=path.join(directory,'Example');fs.mkdirSync(roleDir);
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-resource-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  fs.writeFileSync(path.join(roleDir,'persona.md'),'# Example\nOriginal document','utf8');fs.writeFileSync(path.join(roleDir,'personaConfig.json'),JSON.stringify({description:'Original config'}));
  const identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'};
  const events:unknown[]=[], roots={current:directory};
  const definitions=createPersonaResourceOperations({get rolesRoot(){return roots.current;},roleDirectory:()=>path.join(roots.current,'Example'),identity:()=>identity,onAvatarChanged:change=>events.push(change),
    validate:async input=>({passed:true,status:'passed',styleSkillUrl:String(input.styleSkillUrl),scope:'outbound_message',violations:[],checkedRuleIds:[],skippedRuleIds:[]})});
  const registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('fixture-resources',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((req,res)=>{
    if(remote){if(evaluateLanAgentRequest(req,authority,true).kind!=='agent'){res.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(req);registerLanAgentBodyGuard(req,body=>assertLanAgentBodyAuthority(new URL(req.url!,'http://fixture.invalid').pathname,body,undefined));}
    if(!registry.handle(req,new URL(req.url!,'http://fixture.invalid'),res))res.writeHead(404).end('{}');
  });
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,method='GET',bytes?:Buffer,headers:Record<string,string>={})=>new Promise<{status:number;headers:http.IncomingHttpHeaders;bytes:Buffer;json():any}>((resolve,reject)=>{
    const req=http.request(base+'/api/roles/Example/'+suffix,{method,headers:{...(remote?{authorization:'Bearer '+credential.token}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode!,headers:res.headers,bytes,json:()=>JSON.parse(bytes.toString())});});});req.on('error',reject);req.end(bytes);
  });
  return {directory,roleDir,roots,identity,definitions,registration,events,call,authority,credential};
}

test('six exact persona resource operations preserve avatar bytes/config and public empty-node access',async t=>{
  const f=await fixture(t,true);assert.equal(f.definitions.length,6);
  const saved=await f.call('avatar','PUT',png,{'content-type':'image/png'});assert.equal(saved.status,200);assert.equal(saved.json().data.configured,true);
  assert.equal(f.events.length,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.roleDir,'personaConfig.json'),'utf8')).description,'Original config');
  const read=await f.call('avatar');assert.equal(read.status,200);assert.equal(read.headers['content-type'],'image/png');assert.equal(read.headers['content-length'],String(png.length));assert.equal(read.headers['cache-control'],'private, max-age=3600');assert.deepEqual(read.bytes,png);
  const invalid=await f.call('avatar','PUT',Buffer.from('not a PNG'),{'content-type':'image/png'});assert.equal(invalid.status,400);
  const missing=await f.call('avatar','DELETE');assert.equal(missing.status,200);assert.equal(missing.json().data.configured,false);assert.equal((await f.call('avatar')).status,404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.roleDir,'personaConfig.json'),'utf8')).description,'Original config');
});

test('avatar GET streams existing images beyond the upload bound while PUT retains its original five MiB cap',async t=>{
  const f=await fixture(t),large=Buffer.alloc(PERSONA_AVATAR_MAX_BYTES+1024);png.copy(large);
  fs.writeFileSync(path.join(f.roleDir,'existing.png'),large);fs.writeFileSync(path.join(f.roleDir,'personaConfig.json'),JSON.stringify({avatar:'existing.png'}));
  const read=await f.call('avatar');assert.equal(read.status,200);assert.deepEqual(read.bytes,large);
  const denied=await f.call('avatar','PUT',undefined,{'content-type':'image/png','content-length':String(large.length)});assert.equal(denied.status,413);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.roleDir,'personaConfig.json'),'utf8')).avatar,'existing.png');
});

test('Markdown HTTP replies preserve bytes, MIME, missing/error statuses and complete documents above the old two MiB cap',async t=>{
  const f=await fixture(t),document=await f.call('persona-document');assert.equal(document.status,200);assert.match(String(document.headers['content-type']),/^text\/markdown/);assert.equal(document.bytes.toString(),'# Example\nOriginal document');
  assert.equal((await f.call('persona-document?file=..%2Foutside.md')).status,400);assert.equal((await f.call('persona-document?file=unknown.md')).status,404);
  fs.writeFileSync(path.join(f.roleDir,'large.md'),Buffer.alloc(3*1024*1024));const large=await f.call('persona-document?file=large.md');assert.equal(large.status,200);assert.equal(large.bytes.length,3*1024*1024);
  const reference=await f.call('persona-reference');assert.equal(reference.status,200);assert.equal(reference.json().data.document,document.bytes.toString());assert.match(reference.json().data.revision,/^[a-f0-9]{64}$/);
});

test('a never-started avatar download cancels and closes its original file before returning',async t=>{
  const f=await fixture(t);await f.call('avatar','PUT',png,{'content-type':'image/png'});
  const request=new http.IncomingMessage(new Socket());
  const owner=createPersonaAvatarOwner({rolesRoot:f.directory,identity:()=>f.identity});
  const stream=owner.prepare(request,'Example').read();await stream.cancel();await stream.frames.return(undefined);
  const config=JSON.parse(fs.readFileSync(path.join(f.roleDir,'personaConfig.json'),'utf8'));
  fs.renameSync(path.join(f.roleDir,config.avatar),path.join(f.roleDir,'closed.png'));
  assert.equal(fs.existsSync(path.join(f.roleDir,'closed.png')),true);
});

test('a revoked node cannot disclose the current persona resource',async t=>{
  const f=await fixture(t,true);assert.equal((await f.call('persona-reference')).status,200);
  f.authority.setNodeEnabled(f.credential.nodeId,false,true);
  assert.equal((await f.call('persona-reference')).status,403);assert.equal((await f.call('persona-document')).status,403);
});


test('avatar upload enforces actual chunk bytes and rejects generation changes before the native mutation', async t => {
  const f = await fixture(t);
  const owner = createPersonaAvatarOwner({ rolesRoot: f.directory, identity: () => f.identity, onChanged: change => f.events.push(change) });
  const oversized = new http.IncomingMessage(new Socket());
  const oversizedResult = owner.prepare(oversized, 'Example').save('image/png', oversized);
  oversized.push(Buffer.alloc(PERSONA_AVATAR_MAX_BYTES + 1));
  oversized.push(null);
  await assert.rejects(oversizedResult, (error: any) => error.statusCode === 413);
  const changed = new http.IncomingMessage(new Socket());
  const changedResult = owner.prepare(changed, 'Example').save('image/png', changed);
  f.identity.applicationGenerationId = 'replacement-generation';
  changed.push(png);
  changed.push(null);
  await assert.rejects(changedResult, (error: any) => error.statusCode === 409);
  assert.equal(f.events.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.roleDir, 'personaConfig.json'), 'utf8')).avatar, undefined);
});


test('new resource requests use the current persona root while original in-flight reads, streams and uploads cannot cross roots', async t => {
  const f = await fixture(t);
  await f.call('avatar', 'PUT', png, { 'content-type': 'image/png' });
  const replacementRoot = path.join(f.directory, 'replacement'), replacementRole = path.join(replacementRoot, 'Example');
  fs.mkdirSync(replacementRole, { recursive: true });
  fs.writeFileSync(path.join(replacementRole, 'persona.md'), '# Replacement');
  const nextImage = Buffer.concat([png, Buffer.from('replacement')]);
  fs.writeFileSync(path.join(replacementRole, 'next.png'), nextImage);
  fs.writeFileSync(path.join(replacementRole, 'personaConfig.json'), JSON.stringify({ avatar: 'next.png' }));
  const options = { get rolesRoot() { return f.roots.current; }, roleDirectory: () => path.join(f.roots.current, 'Example'), identity: () => f.identity };
  const request = () => new http.IncomingMessage(new Socket());
  const avatar = createPersonaAvatarOwner(options);
  const stream = avatar.prepare(request(), 'Example').read();
  const document = createPersonaDocumentOwner(options).prepare(request(), 'Example');
  const reference = createPersonaReferenceOwner({ ...options, validate: async () => { throw new Error('unused'); } }).prepare(request(), 'Example');
  const referenceRead = reference.read(null);
  const upload = request(), uploadRead = avatar.prepare(upload, 'Example').save('image/png', upload);
  f.roots.current = replacementRoot;
  upload.push(png); upload.push(null);
  await assert.rejects(uploadRead, (error: any) => error.statusCode === 409);
  await assert.rejects(referenceRead, (error: any) => error.statusCode === 409);
  assert.throws(() => document.read(null), (error: any) => error.statusCode === 409);
  await assert.rejects(stream.frames.next(), (error: any) => error.statusCode === 409);
  await stream.cancel();
  assert.equal(f.events.length, 1);
  assert.deepEqual((await f.call('avatar')).bytes, nextImage);
  assert.equal((await f.call('persona-document')).bytes.toString(), '# Replacement');
  assert.equal((await f.call('persona-reference')).json().data.document, '# Replacement');
  assert.equal(JSON.parse(fs.readFileSync(path.join(replacementRole, 'personaConfig.json'), 'utf8')).avatar, 'next.png');
});
