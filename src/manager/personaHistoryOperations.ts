import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiResponseContract } from './apiOperationContract.js';
import { createPersonaChatHistoryOwner, type PersonaChatHistoryContext } from './personaChatHistoryRoutes.js';
import { createPersonaVoiceTranscriptOwner, type PersonaVoiceTranscriptRouteContext } from './personaVoiceTranscriptRoutes.js';
import { createMessageEndpointHistoryOwner, type MessageEndpointHistoryContext } from './messageEndpointHistoryRoutes.js';
import { createPersonaConversationSituationOwner } from './personaConversationSituationOwner.js';
import { ManagerReadWorkerError } from './managerReadWorkerPool.js';
import { errorResponsePresentation } from '../shared/errorPresentation.js';
import { recordMessageHistoryResponseTrace } from './messageHistorySearchTelemetry.js';

export type PersonaHistoryContext = PersonaChatHistoryContext & PersonaVoiceTranscriptRouteContext & {queryHistory:MessageEndpointHistoryContext['queryHistory']};
const object={type:'object'},none={kind:'none' as const,allowIgnoredBody:true},str={type:'string'},array=(items:unknown=true)=>({type:'array',items});
const json=(data:unknown):ApiResponseContract=>({mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data}}});
const failure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code'],properties:{code:{const:-1},message:str,errorCode:str,error:str,requestId:str,repair:str,retryable:{type:'boolean'},uncertain:{const:true}}}};
const failures=Object.fromEntries([400,403,404,409,413,503,504].map(status=>[String(status),failure]));
const taskOwner={type:'object',required:['kind','provider','agentId'],additionalProperties:false,properties:{kind:{enum:['local','instance','device','service']},provider:str,agentId:str,nodeId:str,nodeName:str}};
const reply={type:'object',required:['id','receivedAt','sessionId','text'],properties:{historyCursor:{type:'number'},historyEndCursor:{type:'number'},textTruncated:{type:'boolean'},id:str,receivedAt:str,sessionId:str,text:str,kind:str,turnId:str,deliveryId:str,deliveryStatus:str,targetSessionId:str,targetSessionTitle:str,targetTaskUrl:str,sessionTitle:str,taskUrl:str,sourceTaskOwner:taskOwner,targetTaskOwner:taskOwner}};
const chat=json({type:'object',required:['entries','nextCursor'],properties:{entries:array(reply),nextCursor:{type:['number','null']},newerCursor:{type:['number','null']},invalidRecords:{type:'number'}}});
const aiui=json({type:'object',required:['receipt'],properties:{receipt:{type:'object',required:['state','turnId','recordIds','deduplicated'],properties:{state:{const:'committed'},turnId:str,recordIds:array(str),deduplicated:{type:'boolean'}}}}});
const voice=json({type:'object',required:['identityPath','conversationPath','matchedCount','items','summary'],properties:{identityPath:{const:'voice/voice-identities.jsonl'},conversationPath:{const:'conversation/current.jsonl'},matchedCount:{type:'number'},items:array({type:'object',required:['record','personaClassification','evidence','segmentViews'],properties:{record:object,personaClassification:str,evidence:array(),segmentViews:array()}}),summary:{type:'object',required:['recordCount','mixedRecordCount','segmentCount','recordingDurationSeconds','speakerDurationSeconds','classifiedSpeakerDurationSeconds','coverageRate','byClassification','unresolvedVoiceprints'],properties:{recordCount:{type:'number'},mixedRecordCount:{type:'number'},segmentCount:{type:'number'},recordingDurationSeconds:{type:'number'},speakerDurationSeconds:{type:'number'},classifiedSpeakerDurationSeconds:{type:'number'},coverageRate:{type:'number'},byClassification:object,unresolvedVoiceprints:array()}}}});
const situation={type:'object',required:['schemaVersion','id','createdAt','routeId','routeKind','messageIds','speaker','addressing','topic','evidence','decisions'],properties:{schemaVersion:{const:1},id:str,createdAt:str,routeId:str,routeKind:str,messageIds:array(str),speaker:object,addressing:object,topic:object,evidence:object,decisions:object}};
const history:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','requestId','data'],properties:{code:{const:0},requestId:str,data:{type:'object',required:['entries','count','coverage'],properties:{entries:array(object),count:{type:'number'},coverage:{type:'object',required:['roleId','recordScope','resultMode','completenessUnknown','paginationSupported','limit','maxChars','limitReducesArchiveScan'],properties:{roleId:str,recordScope:{const:'saved_role_messages'},resultMode:{const:'latest_matches'},completenessUnknown:{const:true},paginationSupported:{const:false},limit:{type:'number'},maxChars:{type:'number'},limitReducesArchiveScan:{const:false}}}}}}}};

function fail(error:unknown,kind:string):ApiOperationResult {
  const cause=error as {statusCode?:number;publicDetails?:Record<string,unknown>;uncertain?:boolean};
  const worker=error instanceof ManagerReadWorkerError;
  const status=cause?.statusCode??(kind==='voice'&&worker?error.code==='busy'?503:error.code==='timeout'?504:400:400);
  const message=error instanceof Error?error.message:String(error);
  const body=kind==='aiui'?{code:-1,errorCode:'AIUI_HISTORY_UNCONFIRMED',...(cause?.uncertain?{uncertain:true}:{})}:errorResponsePresentation({code:-1,message,...cause?.publicDetails,...(cause?.uncertain?{uncertain:true}:{})},status);
  return {status,headers:{'cache-control':'no-store'},body};
}
function trace(input:ApiOperationInput,result:ApiOperationResult):ApiOperationResult {
  const body=result.body as {requestId?:string};if(!body?.requestId)return result;
  const started=performance.now(),bytes=Buffer.byteLength(JSON.stringify(body));
  const cleanup=()=>{input.response.off('finish',done);input.response.off('close',cleanup);};
  const done=()=>{cleanup();recordMessageHistoryResponseTrace(body.requestId!,performance.now()-started,bytes,input.response.statusCode);};
  input.response.once('finish',done);input.response.once('close',cleanup);return result;
}
function define<T>(contract:ApiOperationContract,prepare:(input:Omit<ApiOperationInput,'body'>)=>T,execute:(owner:T,input:ApiOperationInput)=>unknown|Promise<unknown>,kind:string):ApiOperationDefinition {
  const bind=(input:Omit<ApiOperationInput,'body'>)=>{try{const owner=prepare(input);return async(parsed:ApiOperationInput)=>{
    let result:ApiOperationResult;
    try {const data=await execute(owner,parsed);result={status:200,headers:{'cache-control':'no-store'},body:kind==='history'?{code:0,...data as object}:{code:0,data}};}
    catch(error){parsed.signal?.throwIfAborted();result=fail(error,kind);}
    return kind==='history'?trace(parsed,result):result;
  };}catch(error){input.signal?.throwIfAborted();return fail(error,kind);}};
  return {contract,prepare:bind,handler:async input=>{const handler=bind(input);return typeof handler==='function'?handler(input):handler;}};
}

/** Original ledgers/read workers; exact API and static aliases share the same functional owners. */
export function createPersonaHistoryOperations(context:PersonaHistoryContext):readonly ApiOperationDefinition[] {
  const chats=createPersonaChatHistoryOwner(context),voices=createPersonaVoiceTranscriptOwner(context),situations=createPersonaConversationSituationOwner(context);
  const messages=createMessageEndpointHistoryOwner({roleDirectory:context.roleDir,identity:context.identity,queryHistory:context.queryHistory});
  const base=(id:string,method:ApiOperationContract['method'],prefix:string,suffix:string,body:ApiOperationContract['request']['body'],response:ApiResponseContract,kind:string):ApiOperationContract=>({
    operationId:'manager.personas.history.'+id+(prefix==='/roles' ? '.alias':''),
    ...(kind==='aiui'?{}:{aliases:[(kind==='history'?'persona':prefix==='/roles'?'knowledge-alias':'knowledge')+':'+method+':'+prefix+'/:roleId/'+suffix]}),
    contractVersion:'1.0.0',method,pathTemplate:prefix+'/:roleId/'+suffix,exposure:'public',transport:'http',description:'Read the original selected persona history, transcripts, bounded message excerpt or conversation situation; explicit AIUI ingestion appends only its native stable-turn ledger.',
    request:{path:{type:'object',required:suffix.includes(':situationId')?['roleId','situationId']:['roleId'],additionalProperties:false,properties:{roleId:{type:'string',minLength:1},...(suffix.includes(':situationId')?{situationId:{type:'string',minLength:1}}:{})}},query:object,headers:object,body},
    responses:{'200':response,...failures},effects:{mode:kind==='aiui'?'native-ledger-append':'read',description:kind==='aiui'?'Append original AIUI user/assistant rows with stable session+turn IDs and conflicting replay detection; never invoke an Agent.':'Read existing native sources; Desktop metadata enriches full IDs/titles and cannot hide recorded messages when unavailable.'},
    recovery:{strategy:'original-history-identity',description:'Keep the original persona directory and Manager generation. AIUI repeats the same session/turn/text and reconciles its receipt. Chat cursors remain exclusive byte offsets. Message history stays a bounded latest-matches excerpt, rejects pagination, carries original requestId and Unix-second/sequence filters, and retains the native worker’s deadline/termination ownership.'},
    validators:[{id:'original-history-owner',description:'Capture the current persona directory and authenticated connection/Manager identity before consuming the body; recheck before disclosure and native AIUI append. No persona, context or feature grant is added.'},{id:'native-history-rules',description:'Keep chat limit/cursor validation, AIUI 128 KiB and original field limits, voice classification filters, situation read window, message excerpt bounds and client budget. Cancellation aborts original worker work; the native pool retains quarantined slots until termination is confirmed.'}]
  });
  const operations:ApiOperationDefinition[]=[];
  for(const prefix of ['/api/roles','/roles']) {
    operations.push(define(base('chat.read','GET',prefix,'chat-history',none,chat,'chat'),input=>chats.prepare(input.request,input.path.roleId,input.signal),(owner,input)=>owner.read(input.url.searchParams.has('cursor')?Number(input.url.searchParams.get('cursor')):undefined,Number(input.url.searchParams.get('limit')??50), {summary:input.url.searchParams.get('summary')==='true',direction:input.url.searchParams.get('direction')==='newer'?'newer':'older',id:input.url.searchParams.get('id')??undefined}),'chat'));
    operations.push(define(base('chat.aiui.append','POST',prefix,'chat-history/aiui',{kind:'json',schema:true,maxBytes:131072,allowAnyContentType:true,emptyValue:null},aiui,'aiui'),input=>chats.prepare(input.request,input.path.roleId,input.signal),async(owner,input)=>({receipt:await owner.append(input.body)}),'aiui'));
    operations.push(define(base('voice.read','GET',prefix,'voice-transcripts',none,voice,'voice'),input=>voices.prepare(input.request,input.path.roleId,input.signal),(owner,input)=>owner.read(input.url.searchParams),'voice'));
    for(const detail of [false,true])operations.push(define(base(detail?'situations.detail':'situations.list','GET',prefix,'conversation-situations'+(detail?'/:situationId':''),none,json(detail?situation:array(situation)),'situation'),input=>situations.prepare(input.request,input.path.roleId,input.signal),(owner,input)=>owner.read(input.url.searchParams.get('limit'),input.path.situationId),'situation'));
  }
  operations.push(define(base('messages.search','GET','/api/roles','message-endpoint-history',none,history,'history'),input=>messages.prepare(input.request,input.path.roleId,input.signal),(owner,input)=>owner.read(input.url.searchParams),'history'));
  return operations;
}
