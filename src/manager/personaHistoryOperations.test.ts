import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPersonaHistoryOperations, type PersonaHistoryContext } from './personaHistoryOperations.js';
import { createPersonaChatHistoryOwner } from './personaChatHistoryRoutes.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { appendPersonaAiuiExchange, readPersonaChatHistory } from '../personaChatHistory.js';
import { queryPersonaVoiceTranscriptViews } from '../personaVoiceTranscriptView.js';
import { recordConversationSituation } from '../conversationSituationStore.js';
import { conversationSituationForIdentity } from '../routing/conversationSituation.js';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest } from './lanAgentRequestAccess.js';
import { markAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';

function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(t:test.TestContext) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'persona-history-contract-')),roleDir=path.join(directory,'Example');fs.mkdirSync(roleDir);
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('persona-history-contract-'));fs.rmSync(directory,{recursive:true,force:true});});
  const root={current:directory},identity={applicationGenerationId:'original-generation',managerInstanceId:'original-manager'};
  const calls:unknown[]=[];
  const context:PersonaHistoryContext={roleDir:()=>path.join(root.current,'Example'),identity:()=>identity,readTasks:()=>[],
    query:async(dir,query)=>queryPersonaVoiceTranscriptViews(dir,query),queryHistory:async(dir,query,options)=>{calls.push({dir,query,options});return [];}};
  const definitions=createPersonaHistoryOperations(context),registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('fixture-history',definitions);
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'empty-node');
  const server=http.createServer((request,response)=>{if(evaluateLanAgentRequest(request,authority,true).kind!=='agent'){response.writeHead(403).end('{}');return;}
    markAuthenticatedConnectionRequest(request);registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,undefined));
    if(!registry.handle(request,new URL(request.url!,'http://fixture.invalid'),response))response.writeHead(404).end('{}');});
  t.after(async()=>{server.closeAllConnections();await registration.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const call=(suffix:string,method='GET',body?:unknown,prefix='/api/roles')=>new Promise<{status:number;body:any}>((resolve,reject)=>{
    const request=http.request(base+prefix+'/Example/'+suffix,{method,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {directory,roleDir,root,identity,context,definitions,calls,call,authority,credential};
}

test('all eleven exact history operations and aliases permit an authenticated empty node and preserve native AIUI replay',async t=>{
  const f=await fixture(t);assert.equal(f.definitions.length,11);
  const situation=recordConversationSituation(f.roleDir,'original-route','group_message',conversationSituationForIdentity(undefined,{conversationId:'original-conversation',messageIds:['original-message']}))!;
  const input={sessionId:'original-session',turnId:'original-turn',userText:'Original question',assistantText:'Original answer'};
  const appendResult = await f.call('chat-history/aiui','POST',input); assert.equal(appendResult.status,200,JSON.stringify(appendResult.body));
  const replay=await f.call('chat-history/aiui','POST',input,'/roles');assert.equal(replay.status,200);assert.equal(replay.body.data.receipt.deduplicated,true);
  for(const prefix of ['/api/roles','/roles']) {
    const chat=await f.call('chat-history','GET',undefined,prefix);assert.equal(chat.status,200,JSON.stringify(chat.body));assert.equal(chat.body.data.entries.length,2);assert.equal(chat.body.data.entries[0].sessionId,'aiui:original-session');
    const summary = await f.call('chat-history?summary=true&limit=1','GET',undefined,prefix);
    assert.equal(summary.status,200); assert.equal(typeof summary.body.data.entries[0].historyCursor,'number');
    const entry = summary.body.data.entries[0];
    const replyDetail = await f.call('chat-history?direction=newer&limit=1&cursor='+entry.historyCursor+'&id='+entry.id,'GET',undefined,prefix);
    assert.equal(replyDetail.status,200,JSON.stringify(replyDetail.body)); assert.equal(replyDetail.body.data.entries[0].id,entry.id);

    const voice = await f.call('voice-transcripts?includeDetails=false','GET',undefined,prefix); assert.equal(voice.status,200,JSON.stringify(voice.body));
    const situations=await f.call('conversation-situations','GET',undefined,prefix);assert.equal(situations.status,200,JSON.stringify(situations.body));assert.equal(situations.body.data[0].id,situation.id);
    const detail=await f.call('conversation-situations/'+situation.id,'GET',undefined,prefix);assert.equal(detail.status,200);assert.equal(detail.body.data.routeId,'original-route');
  }
  const history=await f.call('message-endpoint-history?includeArchives=1&limit=9999&maxChars=999999');assert.equal(history.status,200);assert.equal(history.body.data.coverage.limit,200);assert.equal(history.body.data.coverage.maxChars,200000);assert.equal(history.body.data.coverage.completenessUnknown,true);assert.match(history.body.requestId,/^[a-f0-9-]{36}$/);
  assert.equal((await f.call('chat-history/aiui','POST',{...input,userText:'Changed text'})).status,400);
});

test('late history results cannot disclose a revoked connection or a replaced persona directory',async t=>{
  const f=await fixture(t),wait=gate(),entered=gate();
  f.context.read=async(dir,cursor,limit)=>{entered.release();await wait.promise;return readPersonaChatHistory(dir,cursor,limit);};
  const oldChat=f.call('chat-history');t.after(wait.release);await Promise.race([entered.promise,oldChat.then(result=>{throw new Error('Chat did not enter its read owner: '+JSON.stringify(result));})]);f.root.current=path.join(f.directory,'replacement');wait.release();
  const result=await oldChat;assert.equal(result.status,409);assert.equal(result.body.data,undefined);
  f.root.current=f.directory;
  const messageWait=gate(),messageEntered=gate();
  // A fresh definition captures the same original callback; use the mutable read function for the existing chat owner.
  f.context.read=async()=>{messageEntered.release();await messageWait.promise;return {entries:[],nextCursor:null};};
  const revoked=f.call('chat-history');t.after(messageWait.release);await Promise.race([messageEntered.promise,revoked.then(result=>{throw new Error('Chat did not enter its read owner: '+JSON.stringify(result));})]);f.authority.setNodeEnabled(f.credential.nodeId,false,true);messageWait.release();
  assert.equal((await revoked).status,403);
});

test('queued AIUI append rechecks the original directory inside the native write queue before touching the ledger',async t=>{
  const f=await fixture(t),wait=gate(),entered=gate();
  const owner=createPersonaChatHistoryOwner({...f.context,append:async(dir,input,before)=>{entered.release();await wait.promise;return appendPersonaAiuiExchange(dir,input,before);}});
  const request=new http.IncomingMessage(new (await import('node:net')).Socket());
  const pending=owner.prepare(request,'Example').append({sessionId:'original-session',turnId:'original-turn',userText:'Original'});
  await entered.promise;f.root.current=path.join(f.directory,'replacement');wait.release();
  await assert.rejects(pending,(error:any)=>error.statusCode===409);
  assert.equal(fs.existsSync(path.join(f.roleDir,'chat-history','final-replies.jsonl')),false);
});
