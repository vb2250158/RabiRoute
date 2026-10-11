import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import http from 'node:http';
import { LanAgentAuthority } from './lanAgentAuthority.js';
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from './lanAgentRequestAccess.js';
import { listAgentApiOperations } from './agentApiPolicy.js';
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard, validateLanAgentRequestBody } from './lanAgentBodyAuthority.js';
function fixture(t: TestContext) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'remote-public-api-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const authority=new LanAgentAuthority({statePath:path.join(directory,'authority.json')});
  const credential=authority.enroll(authority.issueBootstrapTicket().ticket,'node-one');
  authority.registerAgentCatalog(credential.token,[{agentId:'sessionless',provider:'custom-provider'}]);
  function admit(method: string,target: string) {
    const request=new IncomingMessage(new Socket());
    request.method=method;request.url=target;
    request.headers={authorization:'Bearer '+credential.token,'x-rabiroute-agent-id':'sessionless'};
    const access=evaluateLanAgentRequest(request,authority,true);
    assert.equal(access.kind,'agent',method+' '+target+': '+JSON.stringify(access));
    const binding=assertTrustedLanAgentPrincipal(request)!.binding;
    registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(target.split('?')[0],body,binding));
    return request;
  }
  return {admit,authority,credential};
}
test('enabled remote entry admits every current catalog contract without a persona, workspace or Route grant',t=>{
  const f=fixture(t);
  for(const operation of listAgentApiOperations())f.admit(operation.method,operation.pathTemplate.replace(/:[A-Za-z][A-Za-z0-9]*/g,'fixture'));
});
test('future public operations and their resource identifiers use the same authenticated ingress',t=>{
  const f=fixture(t);
  for(const method of ['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'])f.admit(method,'/api/after-client-release/resources/glasses:one?view=all&futureQuery=yes&pageToken=cursor-next&tokenCount=2&secretary=name');
});
test('ordinary management bodies are not source claims; actual source events remain fenced',t=>{
  const f=fixture(t);
  for(const body of [null,'plain text',[{value:1}],{sender:'display-name',worker:{sessionId:'target-session'},sourceThreadId:'configuration-value',messageSource:{type:'system'}}]) {
    const request=f.admit('PUT','/api/after-client-release/settings');
    assert.doesNotThrow(()=>validateLanAgentRequestBody(request,body));
  }
  const source=f.admit('POST','/api/codex-hook/context');
  assert.throws(()=>validateLanAgentRequestBody(source,{session_id:'foreign',agentType:'codex'}),/not owned/);
});
test('real HTTP admission accepts HEAD, OPTIONS and arbitrary future management schemas',async t=>{
  const f=fixture(t);
  const server=http.createServer(async(request,response)=>{
    try {
      const access=evaluateLanAgentRequest(request,f.authority,true);
      assert.equal(access.kind,'agent');
      registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(new URL(request.url!,'http://fixture.invalid').pathname,body,assertTrustedLanAgentPrincipal(request)?.binding));
      const chunks:Buffer[]=[];for await(const part of request)chunks.push(Buffer.from(part));
      const body=chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      validateLanAgentRequestBody(request,body);
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({code:0,body}));
    } catch(error) {response.writeHead(403);response.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  for(const [method,body] of [['HEAD',undefined],['OPTIONS',undefined],['POST',[1,2]],['PUT','plain text'],['PATCH',{sender:'display name',worker:{sessionId:'target'}}],['DELETE',null]] as const) {
    const response=await fetch(base+'/api/after-client-release/resources/glasses:one?filter[type]=all&future_flag&pageToken=cursor-next&tokenCount=2',{method,headers:{authorization:'Bearer '+f.credential.token,'x-rabiroute-agent-id':'sessionless','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,200,method+' '+await response.text());
  }
});
