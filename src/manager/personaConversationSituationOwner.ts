import type http from 'node:http';
import path from 'node:path';
import { listConversationSituations } from '../conversationSituationStore.js';
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from './personaResourceAdmission.js';

export function createPersonaConversationSituationOwner(context: {roleDir(roleId:string):string;identity?():PersonaResourceIdentity}) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),roleDir=context.roleDir(roleId);
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDir(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Persona directory changed while reading original conversation situations.'),{statusCode:409});};
    return {read(rawLimit:string|null,situationId?:string) {
      assertCurrent();
      const situations=listConversationSituations(roleDir,Number(rawLimit||20));
      const data=situationId?situations.find(item=>item.id===situationId):situations;
      if(situationId&&!data)throw Object.assign(new Error(`Conversation situation not found: ${situationId}`),{statusCode:404});
      assertCurrent();return data;
    }};
  }};
}
