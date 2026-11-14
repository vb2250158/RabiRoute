import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagerConfigRepository } from "./configRepository.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { createComputerSettingsDefinition, type ComputerSettingsRead } from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import { COMPUTER_SETTINGS_DEFINITION } from "../../apps/rabi-agent/lib/computer-settings-definition.mjs";
function definition(id:string,budget:number) {
 const data=JSON.parse(JSON.stringify(COMPUTER_SETTINGS_DEFINITION));
 data.schema.properties.performance.properties.memoryBudgetBytes.default=budget;
 return createComputerSettingsDefinition(data,id);
}
function value(read:ComputerSettingsRead,pathname:string) {
 let item:unknown=read.settings;
 for(const key of pathname.split(".")){assert.ok(item&&typeof item==="object");item=(item as Record<string,unknown>)[key];}
 return item;
}
function root(t:test.TestContext){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"definition-owner-"));fs.mkdirSync(path.join(directory,"data"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test("definition A to B changes absent defaults in the same owner and rejects old ETags",t=>{
 const directory=root(t);let selected=definition("fixture-A",536870912);
 const owner=new ManagerConfigRepository({rootDir:directory,managerPort:31337,resolveComputerDefinition:()=>selected});
 const first=owner.readComputerSettings();assert.equal(value(first,"performance.memoryBudgetBytes"),536870912);assert.equal(first.rawSettings,undefined);
 selected=definition("fixture-B",805306368);
 const next=owner.readComputerSettings();assert.equal(value(next,"performance.memoryBudgetBytes"),805306368);assert.notEqual(next.revision,first.revision);
 assert.throws(()=>owner.patchComputerSettings({control:{idleTimeoutSeconds:31}},first.revision),error=>(error as {code?:string}).code==="COMPUTER_SETTINGS_CONFLICT");
 const changed=owner.patchComputerSettings({control:{idleTimeoutSeconds:31},customExtension:{keep:true}},next.revision);
 const raw=JSON.parse(fs.readFileSync(owner.managerConfigPath,"utf8")).computerSettings;
 assert.deepEqual(raw,{control:{idleTimeoutSeconds:31},customExtension:{keep:true}});
 assert.equal(value(changed,"performance.memoryBudgetBytes"),805306368);
 assert.equal(Object.hasOwn(raw,"performance"),false);
});
test("old complete values remain explicit and reset deletes only requested overrides in one CAS",t=>{
 const directory=root(t),a=definition("fixture-A",536870912);
 const legacy={...a.normalize(),customExtension:{keep:"original"}};
 fs.writeFileSync(path.join(directory,"data","manager.json"),JSON.stringify({computerSettings:legacy}));
 const b=definition("fixture-B",805306368),owner=new ManagerConfigRepository({rootDir:directory,managerPort:31337,resolveComputerDefinition:()=>b});
 const saved=owner.readComputerSettings();assert.equal(value(saved,"performance.memoryBudgetBytes"),536870912);
 const before=fs.readFileSync(owner.managerConfigPath,"utf8");
 assert.throws(()=>owner.patchComputerSettings({},saved.revision,["performance.memoryBudgetBytes","missing.path"]),error=>(error as {code?:string}).code==="COMPUTER_SETTINGS_PATH_INVALID");
 assert.equal(fs.readFileSync(owner.managerConfigPath,"utf8"),before);
 const restored=owner.patchComputerSettings({},saved.revision,["performance.memoryBudgetBytes"]);
 assert.equal(value(restored,"performance.memoryBudgetBytes"),805306368);
 const raw=JSON.parse(fs.readFileSync(owner.managerConfigPath,"utf8")).computerSettings;
 assert.equal(Object.hasOwn(raw.performance,"memoryBudgetBytes"),false);
 assert.deepEqual(raw.customExtension,{keep:"original"});
 assert.equal(raw.features.input,true);
});
test("partial settings retain invalid explicit fields and allow unrelated sparse repairs",t=>{
 const directory=root(t),file=path.join(directory,"data","manager.json");
 fs.writeFileSync(file,JSON.stringify({computerSettings:{annotation:{tracking:{matchThreshold:"broken"}},performance:{memoryBudgetBytes:"broken"},privateExtension:{keep:1}}}));
 const owner=new ManagerConfigRepository({rootDir:directory,managerPort:31337});
 const read=owner.readComputerSettings();
 assert.equal(value(read,"annotation.tracking.matchThreshold"),"broken");
 assert.equal(value(read,"performance.memoryBudgetBytes"),"broken");
 assert.equal(read.diagnostics.length,2);
 const changed=owner.patchComputerSettings({features:{input:false}},read.revision);
 assert.equal(value(changed,"features.input"),false);
 assert.equal(value(changed,"annotation.tracking.matchThreshold"),"broken");
 assert.equal(owner.readComputerFeaturePolicy("files").allowed,true);
 const raw=JSON.parse(fs.readFileSync(file,"utf8")).computerSettings;
 assert.deepEqual(raw.privateExtension,{keep:1});
 assert.equal(Object.hasOwn(raw,"control"),false);
});
test("definition changes and sparse settings do not revoke the original enrolled connection",t=>{
 const directory=root(t);let selected=definition("fixture-A",536870912);
 const owner=new LanAgentAuthority({statePath:path.join(directory,"authority.json"),resolveComputerDefinition:()=>selected});
 const credential=owner.enroll(owner.issueBootstrapTicket().ticket,"definition-node"),lease=owner.acquireConnectionLease(credential.token);
 const first=owner.getComputerSettings("definition-node");
 owner.patchComputerSettings("definition-node",{features:{input:false},customExtension:{keep:true}},first.revision);
 selected=definition("fixture-B",805306368);
 const next=owner.getComputerSettings("definition-node");
 assert.equal(value(next,"performance.memoryBudgetBytes"),805306368);
 assert.equal(value(next,"features.input"),false);
 assert.deepEqual(owner.acquireConnectionLease(credential.token),lease);
 const reset=owner.patchComputerSettings("definition-node",{},next.revision,["features.input"]);
 assert.equal(value(reset,"features.input"),true);
 const raw=JSON.parse(fs.readFileSync(path.join(directory,"authority.json"),"utf8")).nodes[0].computerSettings;
 assert.equal(Object.hasOwn(raw,"performance"),false);
 assert.deepEqual(raw.customExtension,{keep:true});
 assert.deepEqual(owner.acquireConnectionLease(credential.token),lease);
});
