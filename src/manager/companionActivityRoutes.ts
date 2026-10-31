import type http from 'node:http';
import { sanitizeRoleId } from '../shared/routeIdentity.js';
import { CompanionActivity, CompanionError } from './companionActivity.js';
import type { CompanionContinuationStore } from './companionContinuation.js';
import { hasAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { localModelSettingsRequestAllowed } from './speechModelSettingsAccess.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';

export type PersonaCompanionContext={
  readonly service:CompanionActivity;
  roleDirectory(roleId:string):string;
  identity?():PersonaResourceIdentity;
  local(request:http.IncomingMessage):boolean;
  readOnly():boolean;
  verifyGateway(roleId:string,gatewayId:string|undefined):string;
  saveSummaryDefault(roleId:string):Promise<boolean>;
  last(roleId:string):Promise<unknown>;
  continuation?:CompanionContinuationStore;
};
export type PersonaCompanionAction='snapshot'|'last'|'frame'|'start'|'command'|'observation'|'review'|'reply';

/** Original activity owner; preparation captures connection, role root and service before body consumption. */
export function createPersonaCompanionOwner(context:PersonaCompanionContext){
  return {prepare(request:http.IncomingMessage,roleId:string,action:PersonaCompanionAction,signal?:AbortSignal){
    let current:()=>void;try{current=preparePersonaResourceAdmission(request,signal,context.identity);}catch(error){throw Object.assign(error as object,{statusCode:(error as {statusCode?:number}).statusCode??403});}
    const originallyAuthenticated=hasAuthenticatedConnectionRequest(request);
    if(!sanitizeRoleId(roleId)||/[\\/]/.test(roleId)||roleId==='.'||roleId==='..')throw new CompanionError('Invalid persona');
    const directory=context.roleDirectory(roleId),service=context.service;let attempted=false;
    const assertCurrent=()=>{try{current();}catch(error){throw Object.assign(error as object,{statusCode:(error as {statusCode?:number}).statusCode??403});}if(context.roleDirectory(roleId)!==directory||context.service!==service)throw new CompanionError('Original activity owner changed',409);
      if(!originallyAuthenticated&&(!localModelSettingsRequestAllowed(request)||!context.local(request)||request.headers['x-rabilink-tunnel-local']))throw new CompanionError('Activity authorization denied',403);
      if(!['snapshot','last','frame'].includes(action)&&context.readOnly())throw new CompanionError('Read only',403);
    };
    assertCurrent();
    if(!['snapshot','last','frame'].includes(action)&&!String(request.headers['content-type']).toLowerCase().startsWith('application/json'))throw new CompanionError('Use application/json',415);
    return {assertCurrent,mutationOutcome:()=>attempted?'unknown' as const:'not_started' as const,
      async execute(body:unknown,query:URLSearchParams){
        assertCurrent();
        if(action==='snapshot'){const snapshot=service.snapshot(roleId);const resumeIntent=snapshot.session?.status==='active'||snapshot.session?.status==='paused'?null:await context.continuation?.read(roleId)??null;assertCurrent();return {...snapshot,resumeIntent};}
        if(action==='last'){const data=await context.last(roleId);assertCurrent();return data;}
        if(action==='frame'){const bytes=service.frameFor(roleId,query.get('reviewId')||'');assertCurrent();return bytes;}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new CompanionError('Expected JSON object');
        const input=body as Record<string,any>;let data:unknown;
        if(action==='start'){
          const gatewayId=context.verifyGateway(roleId,input.gatewayId);
          const saveSummary=input.saveSummary??(input.observationOwner==='desktop'?await context.saveSummaryDefault(roleId):false);
          assertCurrent();attempted=true;data=await service.start(roleId,{...input,gatewayId,saveSummary} as Parameters<CompanionActivity['start']>[1],assertCurrent);
          assertCurrent();const session=service.snapshot(roleId).session!;
          if(session.observationOwner==='desktop')await context.continuation?.save(session,assertCurrent);else await context.continuation?.clear(roleId,assertCurrent);
        }else if(action==='command'){
          attempted=true;data=await service.command(roleId,input as Parameters<CompanionActivity['command']>[1],assertCurrent);assertCurrent();
          if(input.action==='stop'||input.action==='pause')await context.continuation?.clear(roleId,assertCurrent);
          else if(input.action==='resume'||input.action==='set-mode'){const session=service.snapshot(roleId).session;if(session?.status==='active')await context.continuation?.save(session,assertCurrent);}
        }else {attempted=true;
          if(action==='observation')data=service.observe(roleId,input.sessionId,input.revision,input.observation,assertCurrent);
          else if(action==='review')data=await service.review(roleId,input.sessionId,input.revision,input.text||'',assertCurrent);
          else data=await service.reply(roleId,input as Parameters<CompanionActivity['reply']>[1],assertCurrent);
        }
        assertCurrent();return data;
      }
    };
  }};
}
