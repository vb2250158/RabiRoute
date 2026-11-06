import type http from 'node:http';
import path from 'node:path';
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from './personaResourceAdmission.js';

export type RoleSkillReadContext = {
  roleDirectory(roleId:string):string;
  identity?():PersonaResourceIdentity;
  querySkills(roleDir:string,skillId:string|undefined,options:{signal:AbortSignal}):Promise<unknown>;
};
/** List/detail preserve the original bounded interactive reader and selected directory. */
export function createRoleSkillReadOwner(context:RoleSkillReadContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),roleDir=context.roleDirectory(roleId);
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Persona directory changed while reading original Skills.'),{statusCode:409});};
    return {async read(skillId?:string) {
      assertCurrent();
      const data=await context.querySkills(roleDir,skillId||undefined,{signal:signal??new AbortController().signal});
      assertCurrent();
      if(skillId&&!data)throw Object.assign(new Error(`Skill not found: ${skillId}`),{statusCode:404});
      return data;
    }};
  }};
}
