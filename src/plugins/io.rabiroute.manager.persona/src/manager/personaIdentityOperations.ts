import { createPersonaIdentityOwner,type PersonaIdentityContext } from './personaIdentityOwner.js';
import { errorResponsePresentation } from '@rabiroute/host-api/shared/errorPresentation';
import { apiDigest, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationInput, type ApiOperationResult, type ApiResponseContract, type SearchLane } from '@rabiroute/host-api/manager/apiOperationContract';
import type { IncomingMessage } from 'node:http';
const str={type:'string'},bool={type:'boolean'},array=(items:unknown)=>({type:'array',items}),statuses={enum:['candidate','confirmed','corrected','retired']};
const evidence={type:'object',properties:{gatewayId:str,routeId:str,endpoint:str,conversationKey:str,messageId:str,note:str}};
const evidenceRefs=array(evidence),scope={type:'object',required:['conversationKeys','projectIds'],properties:{conversationKeys:array(str),projectIds:array(str)}};
const link={type:'object',required:['participantId','status','evidenceRefs'],properties:{participantId:str,status:statuses,confidence:{type:'number'},evidenceRefs}};
const participantBase={type:'object',required:['id','kind','aliases','status','evidenceRefs','updatedAt'],properties:{id:str,kind:{enum:['person','organization','shared_account','automated','unknown']},displayName:str,aliases:array(str),speakingHabits:array({type:'object',required:['dimension','description','evidenceRefs'],properties:{dimension:str,description:str,confidence:{type:'number'},evidenceRefs}}),status:statuses,evidenceRefs,updatedAt:str}};
const endpointBase={type:'object',required:['id','platform','endpointIdentityNamespace','senderStableId','participantLinks','updatedAt'],properties:{id:str,platform:str,endpointIdentityNamespace:str,senderStableId:str,displayName:str,isSelf:bool,participantLinks:array(link),updatedAt:str}};
const cardBase={type:'object',required:['id','subjectParticipantId','targetKind','targetId','relationship','status','scope','evidenceRefs','updatedAt'],properties:{id:str,subjectParticipantId:str,targetKind:{enum:['participant','organization','project']},targetId:str,relationship:str,status:statuses,scope,evidenceRefs,updatedAt:str}};
const conflict={conflicted:bool,conflictEventIds:array(str),conflictCandidates:array({type:'object',required:['eventId','record'],properties:{eventId:str,record:{anyOf:[participantBase,endpointBase,cardBase]}}})};
const participant={...participantBase,properties:{...participantBase.properties,...conflict}},endpoint={...endpointBase,properties:{...endpointBase.properties,...conflict}},card={...cardBase,properties:{...cardBase.properties,...conflict}};
const record={anyOf:[participant,endpoint,card]};
const relationContext={type:'object',required:['endpoint','possibleParticipants','candidateParticipants','relevantRelations','unresolved'],properties:{endpoint:{type:'object',required:['id','platform','endpointIdentityNamespace','senderStableId'],properties:{id:str,platform:str,endpointIdentityNamespace:str,senderStableId:str,displayName:str,isSelf:bool}},confirmedParticipant:participant,possibleParticipants:array({type:'object',required:['participant','link'],properties:{participant,link}}),candidateParticipants:array({type:'object',required:['participant','link'],properties:{participant,link}}),relevantRelations:array(card),unresolved:array(str)}};
const voiceValue={type:'object',required:['identityKey','sourceHostId','voiceprintId','aliases','updatedAt'],properties:{identityKey:str,sourceHostId:str,sourceHostName:str,voiceprintId:str,participantId:str,displayName:str,relationship:str,isUser:bool,aliases:array(str),notes:str,updatedAt:str}};
const voice={...voiceValue,properties:{...voiceValue.properties,conflicted:bool,conflictFields:array(str),conflictCandidates:array({...voiceValue,required:[...voiceValue.required,'eventId','deleted'],properties:{...voiceValue.properties,eventId:str,deleted:bool}})}};
const relationPath={const:'identity-relations/events.jsonl'},voicePath={const:'voice/voice-identities.jsonl'};
const relationRead={anyOf:[{type:'object',required:['path','endpointAccounts','participants','relationCards'],properties:{path:relationPath,endpointAccounts:array(endpoint),participants:array(participant),relationCards:array(card)}},{type:'object',required:['path'],properties:{path:relationPath,context:relationContext}}]};
const voiceRead={anyOf:[{type:'object',required:['path','identities'],properties:{path:voicePath,identities:array(voice)}},{type:'object',required:['path','identity'],properties:{path:voicePath,identity:voice}}]};
const mutation={type:'object',required:['record','appended'],properties:{record,appended:bool}},observation={type:'object',required:['participant','relations','appended'],properties:{participant,relations:array(card),appended:bool}},voiceMutation={type:'object',required:['appended','deleted'],properties:{identity:voice,appended:bool,deleted:bool}};
const json=(data:unknown):ApiResponseContract=>({mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data}}});
const failure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','message'],properties:{code:{const:-1},message:str,uncertain:{const:true}}}};
const errors=Object.fromEntries([400,403,404,409].map(status=>[String(status),failure]));
const body=(properties:Record<string,unknown>)=>({kind:'json' as const,maxBytes:0,allowAnyContentType:true,emptyValue:{},schema:{type:'object',properties}});
const patchBody=body(Object.fromEntries(['kind','platform','endpointIdentityNamespace','senderStableId','displayName','isSelf','participantLinks','participantId','participantKind','aliases','speakingHabits','relationId','subjectParticipantId','targetKind','targetId','relationship','status','scope','evidenceRefs'].map(key=>[key,true])));
const observationBody=body(Object.fromEntries(['platform','endpointIdentityNamespace','senderStableId','displayName','conversationKey','projectId','participantId','participantKind','participantDisplayName','aliases','evidenceRefs','relations'].map(key=>[key,true])));
const voiceBody=body({sourceHostId:str,voiceprintId:str,participantId:{type:['string','null']},sourceHostName:true,displayName:true,relationship:true,isUser:true,aliases:true,notes:true,deleted:true});
type Owner=ReturnType<ReturnType<typeof createPersonaIdentityOwner>['prepare']>;
function failed(error:unknown,outcome?:ReturnType<Owner['mutationOutcome']>):ApiOperationResult {
  const cause=error as {statusCode?:number;uncertain?:boolean};const status=cause?.statusCode??400;
  return {status,...(outcome?{mutationOutcome:outcome}:{}),headers:{'cache-control':'no-store'},body:errorResponsePresentation({code:-1,message:error instanceof Error?error.message:String(error),...(cause?.uncertain?{uncertain:true}:{})},status)};
}
/** Ten exact relation/observation/voice routes share the original native ledgers. */

const identityPurposes: Record<string, string> = {
  "relations.read": "查询角色身份与人物关系",
  "relations.patch": "更新人物身份与关系",
  "observations.append": "记录人物身份观察",
  "voice.read": "查询声音身份映射",
  "voice.patch": "修改声音身份关联"
};

const identityKinds = ['endpoint_account', 'participant', 'relation_card', 'voice_identity'];

function identitySearchLanes(owner: ReturnType<typeof createPersonaIdentityOwner>, request: IncomingMessage, roleId: string): SearchLane[] {
  const baseUrl = '/api/roles/' + encodeURIComponent(roleId);
  const detailUrl = baseUrl + '/identity-relations';
  const item = (kind: string, id: string, label: string, excerpt: string, fields: unknown[], updatedAt: string,
    status?: string, conflicted?: boolean, url = detailUrl, operationId = 'manager.personas.identities.relations.read') => ({
    source: 'identities', kind, agent: roleId, label, excerpt, updatedAt, ...(status ? { status } : {}),
    origin: { agent: roleId, recordId: id, kind, ...(conflicted ? { conflicted } : {}) }, detailUrl: url,
    handle: { detailUrl: url, operationId, recordId: id },
    searchText: [id, label, excerpt, ...fields].join(' '),
    evidence: {
      state: !conflicted && (status === 'confirmed' || status === 'corrected') ? 'confirmed' as const
        : !conflicted && status === 'candidate' ? 'candidate' as const : 'unknown' as const,
      evidenceRefs: [url]
    }
  });
  return [{
    key: roleId, source: 'identities', agent: roleId,
    async read({ query, signal }) {
      if (query.kinds.length && query.kinds.every(kind => kind === 'voice_identity')) {
        return { items: [], complete: true, version: 'filtered' };
      }
      const records = owner.prepare(request, roleId, signal).relations(new URLSearchParams());
      if (!('endpointAccounts' in records)) throw new Error('IDENTITY_RELATIONS_UNAVAILABLE');
      const names = new Map(records.participants.map(person => [person.id, [person.displayName, ...person.aliases].filter(Boolean).join(' ')]));
      const items = [
        ...records.endpointAccounts.map(account => {
          const params = new URLSearchParams({ platform: account.platform, endpointIdentityNamespace: account.endpointIdentityNamespace, senderStableId: account.senderStableId });
          return item('endpoint_account', account.id, account.displayName || account.senderStableId, account.platform,
            [account.senderStableId, account.endpointIdentityNamespace, ...account.participantLinks.flatMap(link => [link.participantId, names.get(link.participantId)])],
            account.updatedAt, undefined, account.conflicted, detailUrl + '?' + params);
        }),
        ...records.participants.map(person => item('participant', person.id, person.displayName || person.aliases[0] || person.id,
          person.aliases.join(' · '), [person.kind, ...(person.speakingHabits?.map(habit => habit.description) ?? [])], person.updatedAt, person.status, person.conflicted)),
        ...records.relationCards.map(card => item('relation_card', card.id, card.relationship,
          [names.get(card.subjectParticipantId) || card.subjectParticipantId, names.get(card.targetId) || card.targetId].join(' → '),
          [card.subjectParticipantId, card.targetId, card.targetKind, ...card.scope.projectIds, ...card.scope.conversationKeys],
          card.updatedAt, card.status, card.conflicted))
      ];
      return { items, complete: true, version: apiDigest(items) };
    }
  }, {
    key: roleId + ':voice', source: 'identities', agent: roleId,
    async read({ query, signal }) {
      if (query.kinds.length && !query.kinds.includes('voice_identity')) {
        return { items: [], complete: true, version: 'filtered' };
      }
      const records = owner.prepare(request, roleId, signal).voices(new URLSearchParams());
      if (!('identities' in records)) throw new Error('VOICE_IDENTITIES_UNAVAILABLE');
      const items = records.identities.map(voice => {
        const params = new URLSearchParams({ sourceHostId: voice.sourceHostId, voiceprintId: voice.voiceprintId });
        return item('voice_identity', voice.identityKey, voice.displayName || voice.aliases[0] || voice.voiceprintId,
          voice.relationship || voice.aliases.join(' · '), [...voice.aliases, voice.sourceHostName, voice.sourceHostId, voice.voiceprintId, voice.participantId],
          voice.updatedAt, undefined, voice.conflicted, baseUrl + '/voice-identities?' + params, 'manager.personas.identities.voice.read');
      });
      return { items, complete: true, version: apiDigest(items) };
    }
  }];
}

export function createPersonaIdentityOperations(context:PersonaIdentityContext):readonly ApiOperationDefinition[] {
  const owner=createPersonaIdentityOwner(context),operations:ApiOperationDefinition[]=[];
  for(const prefix of ['/api/roles','/roles'])for(const [id,method,suffix,response,inputBody] of [
    ['relations.read','GET','identity-relations',relationRead,{kind:'none',allowIgnoredBody:true}],
    ['relations.patch','PUT','identity-relations',mutation,patchBody],
    ['observations.append','POST','identity-relations/observations',observation,observationBody],
    ['voice.read','GET','voice-identities',voiceRead,{kind:'none',allowIgnoredBody:true}],
    ['voice.patch','PUT','voice-identities',voiceMutation,voiceBody]
  ] as const) {
    const path=prefix+'/:roleId/'+suffix;
    const contract:ApiOperationContract={operationId:'manager.personas.identities.'+id+(prefix==='/roles'?'.alias':''),aliases:[(prefix==='/roles'?'knowledge-alias':'knowledge')+':'+method+':'+path],contractVersion:'1.0.0',method,pathTemplate:path,exposure:'public',transport:'http',description:'Read or update the original selected role’s relation, candidate-observation and voice-identity records. Identity facts do not grant business authority.',
      ...(id === 'relations.read' && prefix === '/api/roles' ? { searchable: { scope: 'identities', legend: '身份关系与声纹身份 / identity relations and voice identities', kinds: identityKinds } } : {}),
      request:{path:{type:'object',required:['roleId'],additionalProperties:false,properties:{roleId:{type:'string',minLength:1}}},query:{type:'object'},headers:{type:'object'},body:inputBody},responses:{'200':json(response),...(method==='GET'?{}:{'201':json(response)}),...errors},
      effects:{mode:method==='GET'?'read':'native-identity-ledger-mutation',description:method==='GET'?'Read original role-scoped identities, endpoint context or voice associations.':'Use native file locks, event heads, conflict resolution and replay rules, then publish original change events. Voice participant association keeps the native relation/voice ledger sequence.'},
      recovery:{strategy:'original-identity-readback',description:'Retain explicit participant/relation IDs and compound endpoint or sourceHostId/voiceprintId identity. Unchanged native patches replay without another row; an omitted participant/relation ID can create a fresh ID and must not be blindly retried. Re-read both ledgers after an uncertain composite voice write; no rollback erases committed history.'},
      validators:[{id:'original-identity-owner',description:'Capture current role directory, authenticated connection and Manager identity before body consumption. Recheck before native writes and before/after each original change event. All authenticated enabled remote connections can invoke the public API without role or feature grants.'},{id:'native-identity-evidence',description:'Keep native normalization and limits, candidate evidence/source-message requirements, conflict heads and status rules. Voice participant IDs must resolve to a confirmed/corrected unconflicted participant in the same role; null detaches while omission preserves binding. Production unlimited JSON bodies and empty {} semantics remain.'}]
    };
    const bind=(input:Omit<ApiOperationInput,'body'>)=>{try{const bound=owner.prepare(input.request,input.path.roleId,input.signal);return async(parsed:ApiOperationInput)=>{
      try {
        const data=id==='relations.read'?bound.relations(parsed.url.searchParams):id==='voice.read'?bound.voices(parsed.url.searchParams):id==='relations.patch'?bound.patch(parsed.body):id==='observations.append'?bound.observe(parsed.body):bound.patchVoice(parsed.body);
        return {status:method==='GET'?200:(data as {appended:boolean}).appended?201:200,mutationOutcome:bound.mutationOutcome(),headers:{'cache-control':'no-store'},body:{code:0,data}} as ApiOperationResult;
      }catch(error){parsed.signal?.throwIfAborted();return failed(error,bound.mutationOutcome());}
    };}catch(error){input.signal?.throwIfAborted();return failed(error,'not_started');}};
    operations.push({contract,discovery:{title:identityPurposes[id],summary:identityPurposes[id]+"。",category:{id:"knowledge.identity",title:"人物身份与关系",parentId:"knowledge"},keywords:[identityPurposes[id],id.replace(/[.-]/g," "),"persona"],inputSources:[{field:"path.roleId",operationId:"manager.roles.list",resultPath:"/data/roles",valuePath:"/roleId"}]},prepare:bind,handler:async input=>{const handler=bind(input);return typeof handler==='function'?handler(input):handler;},
      ...(contract.searchable ? { searchLanes: ({ request, roles }) => roles.flatMap(({ roleId }) => identitySearchLanes(owner, request, roleId)) } : {})});
  }
  return operations;
}
