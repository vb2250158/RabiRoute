import type http from 'node:http';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { createPersonaSkillOperations } from './personaSkillOperations.js';
import type { RoleSkillReadContext } from './roleSkillReadRoutes.js';
import type { RoleSkillDownloadContext } from './roleSkillDownloadRoutes.js';

export function dispatchSkillDownloadFixture(request:http.IncomingMessage,pathname:string,response:http.ServerResponse,context:RoleSkillDownloadContext&{json?:(response:http.ServerResponse,status:number,body:unknown)=>void}) {
  const registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('skill-download-fixture',createPersonaSkillOperations({...context,querySkills:async()=>{throw new Error('Catalog is outside this fixture.');}}));
  response.once('close',()=>{void registration.dispose();});
  const handled=registry.handle(request,new URL(pathname,'http://fixture.invalid'),response);
  if(!handled&&!response.writableEnded)response.writeHead(404).end('{}');
  return handled;
}
export function respondSkillReadFixture(request:http.IncomingMessage,response:http.ServerResponse,roleDir:string,skillId:string|undefined,context:Pick<RoleSkillReadContext,'querySkills'>&{json?:(response:http.ServerResponse,status:number,body:unknown)=>void}):Promise<void> {
  const registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('skill-read-fixture',createPersonaSkillOperations({roleDirectory:()=>roleDir,querySkills:context.querySkills,archive:async()=>{throw new Error('ZIP is outside this fixture.');},reportCleanupError:()=>{throw new Error('Unexpected ZIP cleanup.');}}));
  const done=new Promise<void>((resolve,reject)=>{response.once('close',()=>{registration.dispose().then(resolve,reject);});});
  registry.handle(request,new URL('/api/roles/Fixture/skills'+(skillId?'/'+encodeURIComponent(skillId):''),'http://fixture.invalid'),response);
  return done;
}
