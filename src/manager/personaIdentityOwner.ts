import type http from 'node:http';
import path from 'node:path';
import { listIdentityEndpointAccounts,listIdentityParticipants,listIdentityRelationCards,resolveIdentityRelationContext,recordIdentityCandidateObservation,updateIdentityRelation,type IdentityRelationPatch,type IdentityCandidateObservation } from '../identityRelations.js';
import { findPersonaVoiceIdentity,listPersonaVoiceIdentities,updatePersonaVoiceIdentity,type PersonaVoiceIdentityPatch } from '../personaVoiceIdentities.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';

export type PersonaIdentityEvent='identity_relation_changed'|'persona_voice_identity_changed';
export type PersonaIdentityContext={roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity;onEvent?(name:PersonaIdentityEvent,payload:Record<string,unknown>):void};
/** Original relation/voice ledgers own locking, conflict heads, normalization and replay. */
export function createPersonaIdentityOwner(context:PersonaIdentityContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),roleDir=context.roleDirectory(roleId);
    let mutationStarted=false;
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Original role identity directory changed.'),{statusCode:409});};
    const emit=(name:PersonaIdentityEvent,payload:Record<string,unknown>)=>{assertCurrent();context.onEvent?.(name,{roleId,...payload});assertCurrent();};
    const mutate=<T>(action:()=>T)=>{assertCurrent();try{return action();}catch(error){if(mutationStarted&&error&&typeof error==='object')Object.assign(error,{uncertain:true});throw error;}};
    return {
      mutationOutcome:()=>mutationStarted?'unknown' as const:'not_started' as const,
      relations(parameters:URLSearchParams) {
        assertCurrent();
        const platform=parameters.get('platform')?.trim()||'',endpointIdentityNamespace=parameters.get('endpointIdentityNamespace')?.trim()||'',senderStableId=parameters.get('senderStableId')?.trim()||'';
        if(platform||endpointIdentityNamespace||senderStableId){
          if(!platform||!endpointIdentityNamespace||!senderStableId)throw new Error('platform, endpointIdentityNamespace, and senderStableId must be provided together.');
          const value=resolveIdentityRelationContext(roleDir,{platform,endpointIdentityNamespace,senderStableId,conversationKey:parameters.get('conversationKey')?.trim()||undefined,projectId:parameters.get('projectId')?.trim()||undefined});
          assertCurrent();return {path:'identity-relations/events.jsonl',context:value};
        }
        const data={path:'identity-relations/events.jsonl',endpointAccounts:listIdentityEndpointAccounts(roleDir),participants:listIdentityParticipants(roleDir),relationCards:listIdentityRelationCards(roleDir)};
        assertCurrent();return data;
      },
      patch(raw:unknown){return mutate(()=>{mutationStarted=true;const body=raw as IdentityRelationPatch,data=updateIdentityRelation(roleDir,body);emit('identity_relation_changed',{kind:body.kind,recordId:data.record.id});return data;});},
      observe(raw:unknown){return mutate(()=>{mutationStarted=true;const data=recordIdentityCandidateObservation(roleDir,raw as IdentityCandidateObservation);emit('identity_relation_changed',{kind:'candidate_observation',recordId:data.participant.id});return data;});},
      voices(parameters:URLSearchParams) {
        assertCurrent();const sourceHostId=parameters.get('sourceHostId')?.trim()||'',voiceprintId=parameters.get('voiceprintId')?.trim()||'';
        if(sourceHostId||voiceprintId){
          if(!sourceHostId||!voiceprintId)throw new Error('sourceHostId and voiceprintId must be provided together.');
          const identity=findPersonaVoiceIdentity(roleDir,sourceHostId,voiceprintId);if(!identity)throw Object.assign(new Error('Persona voice identity was not found.'),{statusCode:404});
          assertCurrent();return {path:'voice/voice-identities.jsonl',identity};
        }
        const data={path:'voice/voice-identities.jsonl',identities:listPersonaVoiceIdentities(roleDir)};assertCurrent();return data;
      },
      patchVoice(raw:unknown){return mutate(()=>{
        const body=raw as PersonaVoiceIdentityPatch;
            if (typeof body.sourceHostId !== "string" || !body.sourceHostId.trim()) {
              throw new Error("sourceHostId must be a non-empty string.");
            }
            if (typeof body.voiceprintId !== "string" || !body.voiceprintId.trim()) {
              throw new Error("voiceprintId must be a non-empty string.");
            }
            if (Object.prototype.hasOwnProperty.call(body, "participantId")
              && body.participantId !== null
              && typeof body.participantId !== "string") {
              throw new Error("participantId must be a string, null, or omitted.");
            }
            const hasParticipantPatch = Object.prototype.hasOwnProperty.call(body, "participantId");
            const participantId = typeof body.participantId === "string" ? body.participantId.trim() : "";
            let participantStatus: "confirmed" | "corrected" = "confirmed";
            if (participantId) {
              const participant = listIdentityParticipants(roleDir).find(item => item.id === participantId);
              if (!participant || participant.conflicted || !["confirmed", "corrected"].includes(participant.status)) {
                throw new Error("participantId must reference a confirmed identity in the current persona.");
              }
              participantStatus = participant.status as "confirmed" | "corrected";
            }
            let identityRelationResult: ReturnType<typeof updateIdentityRelation> | undefined;
            if (hasParticipantPatch) {
              const sourceHostId = body.sourceHostId.trim();
              const voiceprintId = body.voiceprintId.trim();
              const endpointIdentityNamespace = `host:${sourceHostId}`;
              const existingAccount = listIdentityEndpointAccounts(roleDir).find(item =>
                item.platform === "voice"
                && item.endpointIdentityNamespace === endpointIdentityNamespace
                && item.senderStableId === voiceprintId
              );
              const retiredPreviousLinks = existingAccount?.participantLinks
                .filter(link => link.participantId !== participantId)
                .map(link => ({ ...link, status: "retired" as const })) ?? [];
              const participantLinks = participantId
                ? [
                    ...retiredPreviousLinks,
                    {
                      participantId,
                      status: participantStatus,
                      confidence: 1,
                      evidenceRefs: [{ note: "角色通过声纹确认界面显式关联到身份。" }]
                    }
                  ]
                : existingAccount?.participantLinks.map(link => ({ ...link, status: "retired" as const })) ?? [];
              if (participantId || existingAccount) {
                assertCurrent(); mutationStarted=true;
                identityRelationResult = updateIdentityRelation(roleDir, {
                  kind: "endpoint_account",
                  platform: "voice",
                  endpointIdentityNamespace,
                  senderStableId: voiceprintId,
                  displayName: typeof body.displayName === "string" ? body.displayName.trim() : existingAccount?.displayName,
                  participantLinks
                });
              }
            }

        assertCurrent();mutationStarted=true;
        const data=updatePersonaVoiceIdentity(roleDir,body);
        if(identityRelationResult)emit('identity_relation_changed',{kind:'endpoint_account',recordId:identityRelationResult.record.id});
        emit('persona_voice_identity_changed',{appended:data.appended,deleted:data.deleted});
        return data;
      });}
    };
  }};
}
