import { randomBytes as replacementCredentialBytes } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { isLocalMachineRemoteAddress, isPublicWebguiStaticRequest, isWebguiLanRequestAuthorized } from "./webguiLanAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal, hasTrustedLanAgentPrincipal, isLanNodeMetadataRequest } from "./lanAgentRequestAccess.js";
import { compileApiContract, apiPathParameters } from "./apiOperationContract.js";
import { createLanAgentReadOperations } from "../plugins/io.rabiroute.manager.core/src/manager/lanAgentReadOperations.js";
import { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource, validateLanAgentRequestBody, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

test("explicit invocation source needs no catalog; global ABA and credential replacement fence the original principal", t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"principal-unbound-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const authority=new LanAgentAuthority({statePath:path.join(root,"auth.json")});const config=new RabiGlobalConfigStore(root);config.patch({webguiLan:{enabled:true}});const credential=authority.enroll(authority.issueBootstrapTicket().ticket,"computer");
 const make=()=>({method:"GET",url:"/api/roles/any/plans",headers:{authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-type":"dsh","x-rabiroute-session-id":"any-complete-session"}}) as unknown as IncomingMessage;
 const admit=()=>{const request=make();assert.equal(evaluateLanAgentRequest(request,authority,true,()=>config.getLanAgentAdmissionPolicy()).kind,"agent");return request;};
 const first=admit();assert.equal(assertTrustedLanAgentPrincipal(first)?.source?.sessionId,"any-complete-session");
 Object.assign(credential,authority.enroll(authority.issueBootstrapTicket().ticket,"computer",replacementCredentialBytes(32).toString("base64url")));assert.throws(()=>assertTrustedLanAgentPrincipal(first),/revoked or replaced/);
 const second=admit();config.patch({webguiLan:{enabled:false}});config.patch({webguiLan:{enabled:true}});assert.throws(()=>assertTrustedLanAgentPrincipal(second),/admission/);
 const third=admit();authority.revokeNode("computer");assert.equal(evaluateLanAgentRequest(third,authority,true).kind,"denied");assert.throws(()=>assertTrustedLanAgentPrincipal(third),/unavailable/);
});
test("enabled enrolled computer can use every public target without a browser login; forged metadata never substitutes credentials", t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"access-unbound-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const authority=new LanAgentAuthority({statePath:path.join(root,"auth.json")});const credential=authority.enroll(authority.issueBootstrapTicket().ticket,"computer");
 const make=(url:string,extra:Record<string,string>={})=>({method:"GET",url,headers:{authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-type":"codex","x-rabiroute-session-id":"complete-id",...extra}})as unknown as IncomingMessage;
 for(const url of ["/api/unknown-business","/api/unknown/%252fadmin","/api/roles/any/plans","/api/roles/any/memory","/api/roles/any/skills","/api/lan-agent/instances","/api/lan-agent/nodes","/api/agent/uploads/id"]){assert.equal(evaluateLanAgentRequest(make(url),authority,true).kind,"agent",url);}
 for(const url of ["/api/unknown/../admin","/api/unknown/%2e%2e/admin","/api/unknown?access_token=fixture","/api/unknown?query=%00"]){assert.equal(evaluateLanAgentRequest(make(url),authority,true).kind,"denied",url);}
 assert.equal(evaluateLanAgentRequest(make("/meta",{authorization:"Bearer lan1:invalid"}),authority,true).kind,"denied");
 assert.equal(evaluateLanAgentRequest(make("/meta",{"x-rabiroute-webgui-token":"copied"}),authority,true).kind,"denied");
 authority.setNodeEnabled("computer",false);assert.equal(evaluateLanAgentRequest(make("/meta"),authority,true).kind,"agent","computer-work switch keeps diagnostics and independent APIs available");authority.setNodeEnabled("computer",true);assert.equal(evaluateLanAgentRequest(make("/meta"),authority,true).kind,"agent");
});


test("authenticated encoded asset tails retain one decode and the original signed release boundary", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "access-release-tail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-computer");
  const agentRoot = path.join(root, "agent"); fs.mkdirSync(path.join(agentRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(agentRoot, "package.json"), JSON.stringify({ name: "rabi-agent", version: "0.3.2" }));
  fs.writeFileSync(path.join(agentRoot, "rabi-agent.mjs"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(agentRoot, "lib", "worker.mjs"), "nested-file");
  fs.writeFileSync(path.join(agentRoot, "lib%2Fworker.mjs"), "literal-percent-file");
  const releases = new LanAgentReleaseStore({ rootDir: root, agentRoot });
  const definition = createLanAgentReadOperations({ authority, enabled: () => true, releases,
    isReleaseRequestAuthorized: () => false, isManagementRequestAuthorized: () => false })
    .find(value => value.contract.operationId === "manager.lan-agent.releases.asset")!;
  const compiled = compileApiContract(definition);
  const read = async (tail: string) => {
    const target = `/api/lan-agent/releases/0.3.2/node/${tail}`;
    const request = { method: "GET", url: target, headers: { authorization: `Bearer ${credential.token}` } } as IncomingMessage;
    assert.equal(evaluateLanAgentRequest(request, authority, true).kind, "agent", tail);
    const parsed = apiPathParameters(compiled, target)!;
    return definition.handler({ request, url: new URL(target, "http://manager.invalid"), path: parsed, query: {}, headers: {} } as never);
  };
  const nested = await read("lib%2Fworker.mjs"); assert.equal(nested.status, 200); assert.equal((nested.body as Buffer).toString(), "nested-file");
  const literal = await read("lib%252Fworker.mjs"); assert.equal(literal.status, 200); assert.equal((literal.body as Buffer).toString(), "literal-percent-file");
  const unlisted = await read("lib%2Fabsent.mjs"); assert.equal(unlisted.status, 404);
  for (const tail of ["lib%2F..%2Frabi-agent.mjs", "%2Frabi-agent.mjs", "lib%2F%2Fworker.mjs"])
    assert.throws(() => apiPathParameters(compiled, `/api/lan-agent/releases/0.3.2/node/${tail}`), /API_PATH_PARAMETER_INVALID|path/);
  assert.equal((await read("%252e%252e%2Frabi-agent.mjs")).status, 404, "percent literals are not decoded a second time");
  const revoked = { method: "GET", url: "/api/unknown/%252Fvalue", headers: { authorization: `Bearer ${credential.token}` } } as IncomingMessage;
  authority.revokeNode("fixture-computer"); assert.equal(evaluateLanAgentRequest(revoked, authority, true).kind, "denied");
});

test('caller metadata is optional and accepts new unregistered types under the same authenticated connection',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'access-caller-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const authority=new LanAgentAuthority({statePath:path.join(root,'auth.json')}),credential=authority.enroll(authority.issueBootstrapTicket().ticket,'computer');
 for(const metadata of [{},{'x-rabiroute-agent-type':'new-type'},{'x-rabiroute-session-id':'new-id'},{'x-rabiroute-agent-type':'new-type','x-rabiroute-session-id':'new-id'},{'x-rabiroute-agent-type':' ','x-rabiroute-session-id':' '}]){
   const request={method:'GET',url:'/api/search',headers:{authorization:'Bearer '+credential.token,...metadata}} as unknown as IncomingMessage;
   assert.equal(evaluateLanAgentRequest(request,authority,true).kind,'agent');assert.ok(assertTrustedLanAgentPrincipal(request));
   assert.equal(evaluateLanAgentRequest(request,authority,true).kind,'agent');
 }
});

test('admission rejects changed source headers and revoked credentials on revalidation', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'access-header-tamper-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const authority=new LanAgentAuthority({statePath:path.join(root,'auth.json')});const credential=authority.enroll(authority.issueBootstrapTicket().ticket,'computer');
 const request={method:'GET',url:'/api/search',headers:{authorization:`Bearer ${credential.token}`,'x-rabiroute-agent-type':'codex','x-rabiroute-session-id':'original'}} as unknown as IncomingMessage;
 assert.equal(evaluateLanAgentRequest(request,authority,true).kind,'agent');
 request.headers['x-rabiroute-session-id']='tampered';
 assert.equal(evaluateLanAgentRequest(request,authority,true).kind,'denied');
 const second={method:'GET',url:'/api/search',headers:{authorization:`Bearer ${credential.token}`}} as unknown as IncomingMessage;
 assert.equal(evaluateLanAgentRequest(second,authority,true).kind,'agent');authority.revokeNode('computer');
 assert.equal(evaluateLanAgentRequest(second,authority,true).kind,'denied');assert.throws(()=>assertTrustedLanAgentPrincipal(second));
});

test('remote metadata cannot grant agent or WebGUI authority to the unified search route', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'access-search-remote-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const authority=new LanAgentAuthority({statePath:path.join(root,'auth.json')});
 for(const headers of [{},{'x-rabiroute-agent-type':'codex','x-rabiroute-session-id':'forged'}, {'x-rabiroute-agent-type':'codex'}, {'x-rabiroute-session-id':'forged'}]) {
  const request={method:'GET',url:'/api/search?q=sample',headers,socket:{remoteAddress:'192.0.2.10',localAddress:'192.0.2.20'}} as unknown as IncomingMessage;
  const url=new URL(request.url!,'http://manager.invalid');
  assert.equal(evaluateLanAgentRequest(request,authority,true).kind,'unrelated');
  assert.equal(isLanNodeMetadataRequest(request,authority),false);
  assert.equal(isLocalMachineRemoteAddress(request.socket.remoteAddress,[request.socket.localAddress!]),false);
  assert.equal(isPublicWebguiStaticRequest(request.method,url.pathname),false);
  assert.equal(isWebguiLanRequestAuthorized(request,url,{enabled:true,accessToken:'fixture-webgui-secret'}),false);
 }
});
