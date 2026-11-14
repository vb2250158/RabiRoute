import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ComputerSettingsReplica } from "../lib/computer-settings-replica.mjs";
import { ComputerService } from "../lib/computer-service.mjs";
import { BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, createComputerSettingsDefinition } from "../lib/computer-control-contract.mjs";
import { __test } from "../rabi-agent.mjs";

test("definition metadata compiles once per digest while raw fields are not normalized before receipt lookup",()=>{
 let created=0;const replica=new ComputerSettingsReplica({create:(data,digest)=>{created++;return createComputerSettingsDefinition(data,digest);}});
 const data=structuredClone(BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.data);data.schema.properties.control.properties.idleTimeoutSeconds.default=321;
 const frame={settingsDefinition:{data,digest:"controlled-B"},settings:{control:{countdownSeconds:"not a number"}}};
 assert.doesNotThrow(()=>replica.apply(frame));replica.apply(frame);assert.equal(created,1);assert.equal(replica.readRaw().control.countdownSeconds,"not a number");
 assert.throws(()=>{replica.readRaw().control.countdownSeconds=0;},TypeError);
 assert.equal(replica.definition().defaults.control.idleTimeoutSeconds,321);
 const issue=replica.apply({settingsDefinition:{data:null,digest:"invalid"}});assert.ok(issue.issue);assert.equal(replica.definition().digest,"controlled-B");
});
test("actual SDK Manager message handler preserves old receipts and uses a new data definition without recompiling bootstrap",async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-sdk-definition-"));const configPath=path.join(directory,"config.json");
 const config={schemaVersion:1,managerUrl:"http://fixture.invalid:54321",managerGuid:"fixture-manager-guid",applicationGenerationId:"fixture-generation",managerInstanceId:"fixture-manager",releasePublicKeySha256:"a".repeat(64),nodeId:"fixture-node",nodeCredential:"fixture-only",defaultWorkspace:directory,allowedWorkspaces:[directory],agents:[],autoUpdate:false};
 fs.writeFileSync(configPath,JSON.stringify(config));const runtime=new __test.RabiAgentRuntime(config,configPath);
 await runtime.computer.stop();
 const commands=[];runtime.computer=new ComputerService({receiptRoot:path.join(directory,"receipts"),uploadHistoryRoot:path.join(directory,"uploads"),
  instanceId:config.nodeId,getSettings:()=>runtime.computerSettingsReplica.readRaw(),getDefinition:()=>runtime.computerSettingsReplica.definition(),
  nativeFactory:()=>Object.assign(new EventEmitter(),{async request(action,body){commands.push({action,body});return action==="control.begin"?{visible:true,hotkey:{registered:false}}:{state:"completed"};},async close(){}})});
 runtime.connected=true;runtime.socket={close(){}};runtime.socketManagerGuid=config.managerGuid;
 const replies=new EventEmitter();runtime.send=message=>{replies.emit(message.requestId,message);return true;};runtime.sendRaw=runtime.send;
 t.after(async()=>{await runtime.stop();fs.rmSync(directory,{recursive:true,force:true});});
 const invoke=(params)=>new Promise((resolve,reject)=>{const requestId=randomUUID();const timer=setTimeout(()=>reject(new Error("owned SDK management reply timed out")),5000);replies.once(requestId,message=>{clearTimeout(timer);resolve(message);});runtime.handleManagerMessage(JSON.stringify({type:"manageAgent",requestId,operation:"computer",params}));});
 const data=structuredClone(BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.data);data.schema.properties.control.properties.idleTimeoutSeconds.default=321;
 const input={action:"control.begin",requestId:"original-control"};
 const first=await invoke({...input,_computerContext:{sourceId:"same-source",settings:{},settingsDefinition:{data,digest:"controlled-B"}}});
 assert.equal(first.error,undefined);assert.equal(first.result.state,"active");assert.equal(first.computerSettingsDefinitionDigest,"controlled-B");
 assert.equal(commands.find(item=>item.action==="control.begin").body.settings.control.idleTimeoutSeconds,321);
 assert.notEqual(BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION.defaults.control.idleTimeoutSeconds,321);
 const broken={enabled:true,features:{input:false},control:{countdownSeconds:"broken"},annotation:{tracking:{matchThreshold:"broken"}}};
 const replay=await invoke({...input,_computerContext:{sourceId:"same-source",settings:broken}});
 assert.equal(replay.error,undefined);assert.equal(replay.result.controlSessionId,first.result.controlSessionId);
 const disabled=await invoke({...input,requestId:"new-disabled-control",_computerContext:{sourceId:"same-source",settings:broken}});
 assert.equal(disabled.errorCode,"COMPUTER_FEATURE_DISABLED");assert.equal(commands.filter(item=>item.action==="control.begin").length,1);
 const file=await invoke({action:"file.stat",path:configPath,_computerContext:{sourceId:"same-source",settings:broken}});
 assert.equal(file.error,undefined);assert.equal(file.result.path,configPath);
});
