import type http from 'node:http';
import path from 'node:path';
import { validatePublishedRoleKnowledge } from '../roleKnowledge.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';
export type PersonaKnowledgeValidationContext={roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity;requestCatalogRefresh(directory:string):void;validate?:typeof validatePublishedRoleKnowledge};
/** Published memory-only catalog validation; background refresh keeps its original Manager/pool owner. */
export function createPersonaKnowledgeValidationOwner(context:PersonaKnowledgeValidationContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),directory=context.roleDirectory(roleId);
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(directory))throw Object.assign(new Error('Original knowledge validation directory changed.'),{statusCode:409});};
    return {read(){assertCurrent();const validation=(context.validate??validatePublishedRoleKnowledge)(directory);assertCurrent();if(!validation){context.requestCatalogRefresh(directory);throw Object.assign(new Error(`Role knowledge catalog for ${roleId} is warming; retry shortly.`),{statusCode:503,publicCode:'cache_unavailable'});}return validation;}};
  }};
}
