import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Socket } from 'node:net';
import { createPersonaIdentityOperations } from './personaIdentityOperations.js';
import { createPersonaIdentityOwner,type PersonaIdentityContext } from './personaIdentityOwner.js';
import { identityRelationsPath } from '../identityRelations.js';
import { personaVoiceIdentitiesPath } from '../personaVoiceIdentities.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';

async function fixture(t:test.TestContext){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-identity-contract-')),roleDir=path.join(directory,'Example');fs.mkdirSync(roleDir);fs.writeFileSync(path.join(roleDir,'persona.md'),'# Example');
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-identity-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const root={current:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'},events:Array<{name:string;payload:Record<string,unknown>}>=[],behavior:{event?:()=>void}={};
  const context:PersonaIdentityContext={roleDirectory:()=>path.join(root.current,'Example'),identity:()=>identity,onEvent:(name,payload)=>{events.push({name,payload});behavior.event?.();}};
  const definitions=createPersonaIdentityOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('identity-fixture',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}markAuthenticatedConnectionRequest(request);registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,method='GET',body?:unknown,prefix='/api/roles')=>new Promise<{status:number;body:any}>((resolve,reject)=>{const request=http.request(base+prefix+'/Example/'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});
  return {directory,roleDir,root,identity,events,behavior,context,definitions,call};
}
const participant=(id:string,status='confirmed')=>({kind:'participant',participantId:id,participantKind:'person',displayName:'Original person',aliases:[],status});
const endpoint={kind:'endpoint_account',platform:'synthetic',endpointIdentityNamespace:'endpoint:example',senderStableId:'original-sender',participantLinks:[{participantId:'candidate-one',status:'candidate',evidenceRefs:[]}]};
const observation={platform:'synthetic',endpointIdentityNamespace:'endpoint:example',senderStableId:'original-sender',participantId:'candidate-one',participantDisplayName:'Candidate display',evidenceRefs:[{messageId:'original-message',conversationKey:'original-conversation'}],relations:[{targetKind:'project',targetId:'example-project',relationship:'candidate contributor'}]};
const voice={sourceHostId:'original-host',voiceprintId:'original-voice',participantId:'confirmed-one',displayName:'Original speaker',aliases:[]};

test('all ten identity routes permit an authenticated empty node and preserve native candidate, participant and voice replay',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,10);
  assert.equal((await f.call('identity-relations','PUT',participant('candidate-one','candidate'))).status,201);
  assert.equal((await f.call('identity-relations','PUT',participant('confirmed-one'))).status,201);
  assert.equal((await f.call('identity-relations','PUT',endpoint)).status,201);
  for(const prefix of ['/api/roles','/roles']){
    const list=await f.call('identity-relations','GET',undefined,prefix);assert.equal(list.status,200);assert.equal(list.body.data.path,'identity-relations/events.jsonl');assert.equal(list.body.data.participants.length,2);
    assert.equal((await f.call('identity-relations','PUT',participant('confirmed-one'),prefix)).status,200);
    const observed=await f.call('identity-relations/observations','POST',observation,prefix);assert.equal(observed.status,prefix==='/api/roles'?201:200);assert.equal(observed.body.data.participant.status,'candidate');
    const saved=await f.call('voice-identities','PUT',voice,prefix);assert.equal(saved.status,prefix==='/api/roles'?201:200);assert.equal(saved.body.data.identity.participantId,'confirmed-one');
    const identities=await f.call('voice-identities','GET',undefined,prefix);assert.equal(identities.status,200);assert.equal(identities.body.data.identities[0].sourceHostId,'original-host');
  }
  const lookup=await f.call('identity-relations?platform=synthetic&endpointIdentityNamespace=endpoint%3Aexample&senderStableId=original-sender');assert.equal(lookup.status,200);assert.equal(lookup.body.data.context.candidateParticipants[0].participant.id,'candidate-one');
  assert.ok(f.events.some(event=>event.name==='identity_relation_changed'&&event.payload.kind==='candidate_observation'));assert.ok(f.events.some(event=>event.name==='persona_voice_identity_changed'));
});

test('voice participant association retains same-role confirmation, omission, explicit null retirement and delete replay',async t=>{
  const f=await fixture(t);await f.call('identity-relations','PUT',participant('confirmed-one'));await f.call('identity-relations','PUT',participant('candidate-one','candidate'));
  for(const participantId of [55,'missing','candidate-one'])assert.equal((await f.call('voice-identities','PUT',{...voice,participantId})).status,400);
  assert.equal((await f.call('voice-identities','PUT',voice)).status,201);
  assert.equal((await f.call('voice-identities','PUT',{sourceHostId:voice.sourceHostId,voiceprintId:voice.voiceprintId,displayName:'Renamed'})).body.data.identity.participantId,'confirmed-one');
  const detached=await f.call('voice-identities','PUT',{sourceHostId:voice.sourceHostId,voiceprintId:voice.voiceprintId,participantId:null});assert.equal(detached.status,201);assert.equal(detached.body.data.identity.participantId,undefined);
  const relations=(await f.call('identity-relations')).body.data.endpointAccounts;const account=relations.find((item:any)=>item.platform==='voice');assert.ok(account.participantLinks.every((link:any)=>link.status==='retired'));
  const removed=await f.call('voice-identities','PUT',{sourceHostId:voice.sourceHostId,voiceprintId:voice.voiceprintId,deleted:true});assert.equal(removed.status,201);assert.equal(removed.body.data.deleted,true);
  const replay=await f.call('voice-identities','PUT',{sourceHostId:voice.sourceHostId,voiceprintId:voice.voiceprintId,deleted:true});assert.equal(replay.status,200);assert.equal(replay.body.data.appended,false);
  assert.equal((await f.call('voice-identities?sourceHostId=original-host&voiceprintId=original-voice')).status,404);
});

test('native candidate observations require original endpoint linkage and source-message evidence',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('identity-relations/observations','POST',observation)).status,400);
  await f.call('identity-relations','PUT',participant('candidate-one','candidate'));await f.call('identity-relations','PUT',endpoint);
  assert.equal((await f.call('identity-relations/observations','POST',{...observation,evidenceRefs:[{note:'No source message'}]})).status,400);
  assert.equal((await f.call('identity-relations/observations','POST',observation)).status,201);
  await f.call('identity-relations','PUT',participant('candidate-one'));
  assert.equal((await f.call('identity-relations/observations','POST',observation)).status,400);
  assert.equal((await f.call('identity-relations?platform=synthetic')).status,400);
  assert.equal((await f.call('voice-identities?sourceHostId=original-host')).status,400);
});

test('native relation and voice conflict heads remain explicit in executable HTTP responses',async t=>{
  const f=await fixture(t);await f.call('identity-relations','PUT',participant('confirmed-one'));await f.call('voice-identities','PUT',{sourceHostId:'original-host',voiceprintId:'original-voice',displayName:'First',aliases:[]});
  const relationFile=identityRelationsPath(f.roleDir),first=JSON.parse(fs.readFileSync(relationFile,'utf8').trim());fs.appendFileSync(relationFile,JSON.stringify({...first,id:'fork-participant',supersedes:[],record:{...first.record,displayName:'Other'}})+'\n');
  const voiceFile=personaVoiceIdentitiesPath(f.roleDir),voiceFirst=JSON.parse(fs.readFileSync(voiceFile,'utf8').trim());fs.appendFileSync(voiceFile,JSON.stringify({...voiceFirst,id:'fork-voice',supersedes:[],displayName:'Other'})+'\n');
  const relations=await f.call('identity-relations');assert.equal(relations.status,200);assert.equal(relations.body.data.participants[0].conflicted,true);assert.equal(relations.body.data.participants[0].conflictCandidates.length,2);
  const voices=await f.call('voice-identities');assert.equal(voices.status,200);assert.equal(voices.body.data.identities[0].conflicted,true);assert.equal(voices.body.data.identities[0].conflictCandidates.length,2);
  assert.equal((await f.call('voice-identities','PUT',voice)).status,400);
});

test('a failed second voice ledger write preserves original committed relation history and reports uncertainty',async t=>{
  const f=await fixture(t);await f.call('identity-relations','PUT',participant('confirmed-one'));
  const response=await f.call('voice-identities','PUT',{...voice,aliases:'invalid aliases'});assert.equal(response.status,400);assert.equal(response.body.uncertain,true);
  const endpoints=(await f.call('identity-relations')).body.data.endpointAccounts;assert.equal(endpoints.find((item:any)=>item.platform==='voice').participantLinks[0].participantId,'confirmed-one');
  assert.equal((await f.call('voice-identities?sourceHostId=original-host&voiceprintId=original-voice')).status,404);
});

test('post-commit event/generation failures retain native records without disclosing a stale result',async t=>{
  const f=await fixture(t);f.behavior.event=()=>{f.identity.applicationGenerationId='replacement-generation';};
  const response=await f.call('identity-relations','PUT',participant('committed-one'));assert.equal(response.status,409);assert.equal(response.body.uncertain,true);assert.equal(response.body.data,undefined);
  f.behavior.event=undefined;const read=await f.call('identity-relations');assert.equal(read.status,200);assert.equal(read.body.data.participants[0].id,'committed-one');
});

test('prepared identity owners reject replaced directories and cancelled requests before native mutation',async t=>{
  const f=await fixture(t),owner=createPersonaIdentityOwner(f.context),request=()=>new http.IncomingMessage(new Socket());
  const bound=owner.prepare(request(),'Example');f.root.current=path.join(f.directory,'replacement');
  assert.throws(()=>bound.patch(participant('no-write')),(error:any)=>error.statusCode===409);assert.equal(bound.mutationOutcome(),'not_started');assert.equal(fs.existsSync(identityRelationsPath(f.roleDir)),false);
  f.root.current=f.directory;const controller=new AbortController(),cancelled=owner.prepare(request(),'Example',controller.signal);controller.abort(new Error('Controlled cancellation'));
  assert.throws(()=>cancelled.patch(participant('no-write')),/Controlled cancellation/);assert.equal(fs.existsSync(identityRelationsPath(f.roleDir)),false);
});
