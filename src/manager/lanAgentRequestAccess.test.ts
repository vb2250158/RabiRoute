import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal, hasTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { getTrustedLanAgentSource, setTrustedLanAgentSource, validateLanAgentRequestBody, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";

test("explicit invocation source needs no catalog; global and instance switch ABA fence the original principal", t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"principal-unbound-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const authority=new LanAgentAuthority({statePath:path.join(root,"auth.json")});const config=new RabiGlobalConfigStore(root);config.patch({webguiLan:{enabled:true}});const credential=authority.enroll(authority.issueBootstrapTicket().ticket,"computer");
 const make=()=>({method:"GET",url:"/api/roles/any/plans",headers:{authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-type":"dsh","x-rabiroute-session-id":"any-complete-session"}}) as unknown as IncomingMessage;
 const admit=()=>{const request=make();assert.equal(evaluateLanAgentRequest(request,authority,true,()=>config.getLanAgentAdmissionPolicy()).kind,"agent");return request;};
 const first=admit();assert.equal(assertTrustedLanAgentPrincipal(first)?.source?.sessionId,"any-complete-session");
 authority.setNodeEnabled("computer",false);authority.setNodeEnabled("computer",true);assert.throws(()=>assertTrustedLanAgentPrincipal(first),/revoked or replaced/);
 const second=admit();config.patch({webguiLan:{enabled:false}});config.patch({webguiLan:{enabled:true}});assert.throws(()=>assertTrustedLanAgentPrincipal(second),/admission/);
 const third=admit();authority.revokeNode("computer");assert.equal(evaluateLanAgentRequest(third,authority,true).kind,"denied");assert.throws(()=>assertTrustedLanAgentPrincipal(third),/unavailable/);
});
test("enabled enrolled computer can use every public target without a browser login; forged metadata never substitutes credentials", t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"access-unbound-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const authority=new LanAgentAuthority({statePath:path.join(root,"auth.json")});const credential=authority.enroll(authority.issueBootstrapTicket().ticket,"computer");
 const make=(url:string,extra:Record<string,string>={})=>({method:"GET",url,headers:{authorization:`Bearer ${credential.token}`,"x-rabiroute-agent-type":"codex","x-rabiroute-session-id":"complete-id",...extra}})as unknown as IncomingMessage;
 for(const url of ["/api/unknown-business","/api/roles/any/plans","/api/roles/any/memory","/api/roles/any/skills","/api/lan-agent/instances","/api/lan-agent/nodes","/api/agent/uploads/id"]){assert.equal(evaluateLanAgentRequest(make(url),authority,true).kind,"agent",url);}
 for(const url of ["/api/unknown/../admin","/api/unknown/%2e%2e/admin","/api/unknown/%252fadmin","/api/unknown?access_token=fixture","/api/unknown?query=%00"]){assert.equal(evaluateLanAgentRequest(make(url),authority,true).kind,"denied",url);}
 assert.equal(evaluateLanAgentRequest(make("/meta",{authorization:"Bearer lan1:invalid"}),authority,true).kind,"denied");
 assert.equal(evaluateLanAgentRequest(make("/meta",{"x-rabiroute-webgui-token":"copied"}),authority,true).kind,"denied");
 authority.setNodeEnabled("computer",false);assert.equal(evaluateLanAgentRequest(make("/meta"),authority,true).kind,"denied");authority.setNodeEnabled("computer",true);assert.equal(evaluateLanAgentRequest(make("/meta"),authority,true).kind,"agent");
});
