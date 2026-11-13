import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateComputerSettingsDefinition } from "./generate-computer-settings-definition.mjs";

test("canonical Core definition generates one immutable SDK snapshot without rewriting identical inputs",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-definition-generator-"));
  try {
    const source=path.join(root,"src/plugins/io.rabiroute.manager.core/assets/computer-settings.json");await fs.mkdir(path.dirname(source),{recursive:true});
    const original={schemaVersion:1,features:{files:{title:"Files",description:"Controlled fixture"}},schema:{type:"object",properties:{enabled:{type:"boolean",default:true}}},actions:{"file.stat":{feature:"files",readOnly:true}}};
    await fs.writeFile(source,JSON.stringify(original));const first=await generateComputerSettingsDefinition(root);assert.equal(first.changed,true);
    const entry=path.join(root,"apps/rabi-agent/lib/computer-settings-definition.mjs");const before=await fs.stat(entry);
    const snapshot=await import(pathToFileURL(entry).href);assert.deepEqual(snapshot.COMPUTER_SETTINGS_DEFINITION,original);assert.equal(Object.isFrozen(snapshot.COMPUTER_SETTINGS_DEFINITION.schema),true);
    assert.deepEqual(await generateComputerSettingsDefinition(root,{check:true}),{digest:first.digest,changed:false});assert.equal((await fs.stat(entry)).mtimeMs,before.mtimeMs);
    await fs.writeFile(source,JSON.stringify({actions:original.actions,schema:original.schema,features:original.features,schemaVersion:1}));assert.equal((await generateComputerSettingsDefinition(root)).digest,first.digest);
    original.schema.properties.enabled.default=false;await fs.writeFile(source,JSON.stringify(original));await assert.rejects(generateComputerSettingsDefinition(root,{check:true}),/stale/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
