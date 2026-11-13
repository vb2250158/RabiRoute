import {normalizeComputerSettings as normalizeSettingsForAssertion} from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LanAgentAuthority, inspectLanAgentCredentialState } from "./lanAgentAuthority.js";
import { normalizeComputerSettings } from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { ManagerConfigRepository } from "./configRepository.js";

test("remote settings use original authority CAS and preserve credentials/extensions across restart", t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"computer-settings-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const statePath=path.join(dir,"authority.json"), owner=new LanAgentAuthority({statePath});
 const credential=owner.enroll(owner.issueBootstrapTicket().ticket,"fixture-node"), lease=owner.acquireConnectionLease(credential.token)!;
 const before=JSON.parse(fs.readFileSync(statePath,"utf8")); before.nodes[0].computerSettings={features:{files:false},extension:{a:1}}; fs.writeFileSync(statePath,JSON.stringify(before));
 const first=owner.getComputerSettings("fixture-node"); const changed=owner.patchComputerSettings("fixture-node",{enabled:false,control:{showPointer:false}},first.revision);
 assert.equal(checkedSettings(changed).features.files,false);assert.deepEqual(checkedSettings(changed).extension,{a:1}); assert.equal(checkedSettings(changed).enabled,false);
 assert.throws(()=>owner.patchComputerSettings("fixture-node",{enabled:true},first.revision),{code:"COMPUTER_SETTINGS_CONFLICT"});
 assert.equal(owner.authenticate(credential.token)?.nodeId,"fixture-node"); owner.assertConnectionLease(credential.token,lease);
 const restarted=new LanAgentAuthority({statePath});assert.deepEqual(restarted.getComputerSettings("fixture-node"),changed);
 const after=JSON.parse(fs.readFileSync(statePath,"utf8")); assert.equal(after.nodes[0].secretHash,before.nodes[0].secretHash);assert.equal(after.nodes[0].connectionIncarnation,before.nodes[0].connectionIncarnation);
 assert.deepEqual(inspectLanAgentCredentialState(statePath),{schemaVersion:2,nodeCount:1});assert.deepEqual(restarted.getSnapshot().diagnostics,[]);
 restarted.revokeNode("fixture-node");assert.equal(restarted.authenticate(credential.token),null);
});
test("local settings patch original manager config and retain unrelated user data",t=>{
 const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),"local-computer-settings-"));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
 const owner=new ManagerConfigRepository({rootDir,managerPort:1}); owner.writeManagerConfig({rolesDir:"custom-roles",extension:{preserve:9},computerSettings:{features:{input:false},control:{foreignValue:7}} as any});
 const first=owner.readComputerSettings(),next=owner.patchComputerSettings({features:{files:false}},first.revision);
 assert.equal(checkedSettings(next).features.input,false);assert.equal(checkedSettings(next).features.files,false);assert.equal(checkedSettings(next).control.foreignValue,7);
 assert.deepEqual(owner.readManagerConfig().extension,{preserve:9});assert.equal(owner.readManagerConfig().rolesDir,"custom-roles");
 assert.throws(()=>owner.patchComputerSettings({enabled:false},first.revision),{code:"COMPUTER_SETTINGS_CONFLICT"});
 assert.deepEqual(new ManagerConfigRepository({rootDir,managerPort:1}).readComputerSettings(),next);
});

test("bad saved computer fields stay local and unrelated node saves preserve their raw value",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"partial-computer-settings-"));t.after(()=>{registry.close();fs.rmSync(root,{recursive:true,force:true});});
 const statePath=path.join(root,"authority.json"),authority=new LanAgentAuthority({statePath});
 for(const id of ["bad-node","good-node"])authority.enroll(authority.issueBootstrapTicket().ticket,id);
 const raw=JSON.parse(fs.readFileSync(statePath,"utf8"));raw.nodes[0].computerSettings={features:{input:"broken"},extension:{keep:8}};fs.writeFileSync(statePath,JSON.stringify(raw));
 fs.writeFileSync(path.join(root,"nodes.json"),JSON.stringify({schemaVersion:2,nodes:[{nodeId:"bad-node",connected:false},{nodeId:"good-node",connected:false}],tasks:[]}));
 const registry:LanAgentRegistry=new LanAgentRegistry({statePath:path.join(root,"nodes.json"),computerSettings:id=>id===registry.localInstanceId?new ManagerConfigRepository({rootDir:root,managerPort:1}).readComputerSettings():authority.getComputerSettings(id)});
 const before=fs.readFileSync(statePath);
 const instances=registry.listInstances();assert.match(instances.find(row=>row.instanceId==="bad-node")!.computerSettingsIssue!,/settings/);assert.equal(instances.find(row=>row.instanceId==="good-node")!.enabled,true);assert.deepEqual(fs.readFileSync(statePath),before);
 const good=authority.getComputerSettings("good-node");authority.patchComputerSettings("good-node",{features:{files:false}},good.revision);
 assert.deepEqual(JSON.parse(fs.readFileSync(statePath,"utf8")).nodes[0].computerSettings,raw.nodes[0].computerSettings);
});
test("bad Manager JSON is never replaced by a settings patch",t=>{
 const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),"bad-manager-settings-"));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
 const owner=new ManagerConfigRepository({rootDir,managerPort:1});fs.mkdirSync(path.dirname(owner.managerConfigPath),{recursive:true});fs.writeFileSync(owner.managerConfigPath,'{"rolesDir":"preserve",');const before=fs.readFileSync(owner.managerConfigPath);
 assert.throws(()=>owner.readComputerSettings());assert.throws(()=>owner.patchComputerSettings({enabled:false},'"default"'));assert.deepEqual(fs.readFileSync(owner.managerConfigPath),before);
});
test("execution reads use owner cache and any owner save invalidates it",t=>{
 const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),"computer-settings-cache-"));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));const owner=new ManagerConfigRepository({rootDir,managerPort:1});
 owner.writeManagerConfig({rolesDir:"initial"});const original=fs.readFileSync;let reads=0;
 t.mock.method(fs,"readFileSync",((...args:any[])=>{if(String(args[0])===owner.managerConfigPath)reads++;return (original as any)(...args);}) as typeof fs.readFileSync);
 owner.readComputerSettings();const warm=reads;for(let i=0;i<1000;i++)owner.readComputerSettings();assert.equal(reads,warm);
 const settings=owner.readComputerSettings();owner.patchComputerSettings({features:{input:false}},settings.revision);assert.equal(checkedSettings(owner.readComputerSettings()).features.input,false);
 owner.writeManagerConfig({rolesDir:"changed"});assert.equal(checkedSettings(owner.readComputerSettings()).features.input,false,"unrelated Manager path save retains original computer settings");assert.equal(owner.readManagerConfig().rolesDir,"changed");
});

test("local cleanup failure reports saved settings separately from unconfirmed runtime application",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"computer-settings-apply-"));t.after(()=>{registry.close();fs.rmSync(root,{recursive:true,force:true});});
 const owner=new ManagerConfigRepository({rootDir:root,managerPort:1});let writes=0;const original=owner.writeManagerConfig.bind(owner);t.mock.method(owner,"writeManagerConfig",(value:Parameters<ManagerConfigRepository["writeManagerConfig"]>[0])=>{writes++;original(value);});
 const registry:LanAgentRegistry=new LanAgentRegistry({statePath:path.join(root,"registry.json"),computerSettings:()=>owner.readComputerSettings(),patchComputerSettings:(_id,patch,revision)=>owner.patchComputerSettings(patch,revision),createLocalComputer:()=>({settingsChanged:async()=>{throw Error("controlled cleanup failure")},computerCapabilities:[],terminalShells:[]}) as any});
 const first=owner.readComputerSettings(),result=await registry.updateComputerSettings(registry.localInstanceId,{enabled:false},first.revision);
 assert.equal(result.execution,"unconfirmed");assert.match(result.executionIssue!,/saved/);assert.equal(checkedSettings(result).enabled,false);assert.equal(checkedSettings(owner.readComputerSettings()).enabled,false);assert.equal(result.revision,owner.readComputerSettings().revision);assert.equal(writes,1);
});

test("present primitive computerSettings never become enabled defaults and healthy neighbors stay usable",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"primitive-computer-settings-"));const authority=new LanAgentAuthority({statePath:path.join(root,"authority.json")});
 let registry:LanAgentRegistry|undefined;t.after(()=>{registry?.close();fs.rmSync(root,{recursive:true,force:true});});
 const ids=["bad-string","bad-boolean","bad-array","bad-null","healthy-node"];for(const id of ids)authority.enroll(authority.issueBootstrapTicket().ticket,id);
 const raw=JSON.parse(fs.readFileSync(path.join(root,"authority.json"),"utf8")),bad=["broken",false,[],null];
 bad.forEach((value,index)=>{raw.nodes[index].computerSettings=value;});fs.writeFileSync(path.join(root,"authority.json"),JSON.stringify(raw));const before=fs.readFileSync(path.join(root,"authority.json"));
 fs.writeFileSync(path.join(root,"nodes.json"),JSON.stringify({schemaVersion:2,nodes:ids.map(nodeId=>({nodeId,connected:false})),tasks:[]}));
 registry=new LanAgentRegistry({statePath:path.join(root,"nodes.json"),computerSettings:id=>id===registry!.localInstanceId?{settings:normalizeComputerSettings(),revision:'"default"'}:authority.getComputerSettings(id)});
 const rows=registry.listInstances();for(const id of ids.slice(0,4)){const read=authority.getComputerSettings(id,true);assert.deepEqual(read.settings,bad[ids.indexOf(id)]);assert.equal(read.diagnostics[0]?.field,"computerSettings");assert.match(rows.find(row=>row.instanceId===id)!.computerSettingsIssue!,/settings/);}
 assert.equal(rows.find(row=>row.instanceId==="healthy-node")!.enabled,true);assert.deepEqual(fs.readFileSync(path.join(root,"authority.json")),before);
 const healthy=authority.getComputerSettings("healthy-node");authority.patchComputerSettings("healthy-node",{features:{files:false}},healthy.revision);
 const after=JSON.parse(fs.readFileSync(path.join(root,"authority.json"),"utf8"));bad.forEach((value,index)=>assert.deepEqual(after.nodes[index].computerSettings,value));
});

test("an invalid annotation-only parameter cannot block a valid Agent task policy",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"computer-policy-radius-"));const owner=new ManagerConfigRepository({rootDir:root,managerPort:1}),authority=new LanAgentAuthority({statePath:path.join(root,"authority.json")});let registry:LanAgentRegistry|undefined;t.after(()=>{registry?.close();fs.rmSync(root,{recursive:true,force:true});});
 const settings={enabled:true,features:{agentTasks:true},annotation:{tracking:{matchThreshold:"broken"}}};owner.writeManagerConfig({computerSettings:settings} as any);authority.enroll(authority.issueBootstrapTicket().ticket,"policy-node");const stored=JSON.parse(fs.readFileSync(path.join(root,"authority.json"),"utf8"));stored.nodes[0].computerSettings=settings;fs.writeFileSync(path.join(root,"authority.json"),JSON.stringify(stored));
 fs.writeFileSync(path.join(root,"nodes.json"),JSON.stringify({schemaVersion:2,nodes:[{nodeId:"policy-node",connected:false}],tasks:[]}));
 registry=new LanAgentRegistry({statePath:path.join(root,"nodes.json"),computerFeaturePolicy:(id,feature)=>id===registry!.localInstanceId?owner.readComputerFeaturePolicy(feature):authority.getComputerFeaturePolicy(id,feature),computerSettings:id=>id===registry!.localInstanceId?owner.readComputerSettings():authority.getComputerSettings(id)});
 assert.ok(owner.readComputerSettings().diagnostics.some(item=>item.field.endsWith("matchThreshold")));assert.ok(authority.getComputerSettings("policy-node").diagnostics.some(item=>item.field.endsWith("matchThreshold")));
 assert.doesNotThrow(()=>registry!.assertComputerFeature(registry!.localInstanceId,"agentTasks"));assert.doesNotThrow(()=>registry!.assertComputerFeature("policy-node","agentTasks"));
 const rawManager=JSON.parse(fs.readFileSync(owner.managerConfigPath,"utf8"));rawManager.computerSettings.enabled="broken";fs.writeFileSync(owner.managerConfigPath,JSON.stringify(rawManager));owner.refreshManagerConfig();assert.throws(()=>registry!.assertComputerFeature(registry!.localInstanceId,"agentTasks"),/enabled/);

});

function checkedSettings(read:{settings:unknown;diagnostics?:readonly unknown[]}) {assert.equal(read.diagnostics?.length??0,0);return normalizeSettingsForAssertion(read.settings);}
