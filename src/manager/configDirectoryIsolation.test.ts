import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerConfigRepository } from "./configRepository.js";
import { createManagerConfigurationOwner } from "../plugins/io.rabiroute.manager.route-control/src/manager/rabiApi.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";

test("the original directory configuration owner reads, preserves and repairs one invalid domain", async t => {
 for (const field of ["rolesDir","routeDir"] as const) {
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),"directory-owner-"));
  t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(rootDir,"data"));
  const file=path.join(rootDir,"data","manager.json");
  const original=JSON.stringify({rolesDir:"data/healthy-roles",routeDir:"data/healthy-route",[field]:42});
  fs.writeFileSync(file,original);
  const repository=new ManagerConfigRepository({rootDir,managerPort:31337});
  const storage=new RoleStorageApplication({rolesRoot:()=>repository.requireDomainRoot("roles"),applicationGenerationId:"fixture-generation",managerInstanceId:"fixture-manager"});
  const owner=createManagerConfigurationOwner({rootDir,get routeRoot(){return repository.routeRoot;},get rolesRoot(){return repository.rolesRoot;},
   readManagerConfig:()=>repository.readManagerConfig(),writeManagerConfig:config=>repository.writeManagerConfig(config),ensureDataDirs:()=>repository.ensureDataDirsAsync()});
  try {
   const before=owner.read();
   assert.equal(before[field],undefined);
   assert.equal(before.rawDirectoryConfig?.[field],42);
   assert.equal(before.directoryDiagnostics?.[0]?.field,field);
   assert.equal(fs.readFileSync(file,"utf8"),original);
   const other=field==="rolesDir"?"routeDir":"rolesDir";
   const partial=await owner.update({[other]:"data/changed-healthy"},()=>{});
   assert.equal(partial[other],"data/changed-healthy");
   assert.equal(partial.rawDirectoryConfig?.[field],42);
   assert.equal(JSON.parse(fs.readFileSync(file,"utf8"))[field],42);
   const repaired=await owner.update({[field]:"data/repaired"},()=>{});
   assert.equal(repaired[field],"data/repaired");
   assert.equal(repaired.directoryDiagnostics,undefined);
  } finally {await storage.stop();}
 }
});
