import { createKnowledgeSearchOwner,type KnowledgeSearchContext } from './knowledgeSearchRoutes.js';
import { createPersonaKnowledgeValidationOwner,type PersonaKnowledgeValidationContext } from './personaKnowledgeValidationOwner.js';
import { DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS } from '../roleKnowledge.js';
import { errorResponsePresentation } from '../shared/errorPresentation.js';
import type { ApiOperationContract,ApiOperationDefinition,ApiOperationInput,ApiOperationResult,ApiResponseContract } from './apiOperationContract.js';
export type PersonaKnowledgeContext=KnowledgeSearchContext&PersonaKnowledgeValidationContext;
const str={type:'string'},number={type:'number'},none={kind:'none' as const,allowIgnoredBody:true};
const json=(data:unknown):ApiResponseContract=>({mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data}}});
const status={anyOf:[{type:'object',required:['ready'],additionalProperties:false,properties:{ready:{const:false}}},{type:'object',required:['ready','version','entries','keywords','indexedUpdates','queries','lastCandidates','refreshing','errors','filesRead','watchActive'],properties:{ready:{type:'boolean'},version:number,entries:number,keywords:number,indexedUpdates:number,queries:number,lastCandidates:number,refreshing:{type:'boolean'},errors:number,filesRead:number,refreshedAt:str,watchActive:{type:'boolean'}}}]};
const summary={type:'object',required:['id','kind','title','focus','keywords','archived','updatedAt','excerpt','detailUrl','matchedBy'],properties:{id:str,kind:{enum:['plan','recent','consolidated']},title:str,focus:str,keywords:{type:'array',items:str},archived:{type:'boolean'},updatedAt:str,excerpt:str,detailUrl:str,matchedBy:{type:'array',items:str},status:str,viewedAt:str,revision:str}};
const search=json({type:'object',required:['version','mode','total','items','nextCursor'],properties:{version:number,mode:{enum:['keywords','fulltext']},total:number,items:{type:'array',items:summary},nextCursor:str}});
const limits={type:'object',required:Object.keys(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS),properties:Object.fromEntries(Object.entries(DEFAULT_ROLE_KNOWLEDGE_WRITE_LIMITS).map(([name,fields])=>[name,{type:'object',required:Object.keys(fields),properties:Object.fromEntries(Object.keys(fields).map(key=>[key,number]))}]))};
const validation=json({type:'object',required:['ok','limits','issues'],properties:{ok:{type:'boolean'},limits,issues:{type:'array',items:{type:'object',required:['type','id','message'],properties:{type:{enum:['plan','plan_storage','recent_memory','consolidated_memory']},id:str,message:str}}}}});
const failure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','message'],properties:{code:{const:-1},message:str,error:str}}};
const errors=Object.fromEntries([400,403,409,503].map(code=>[String(code),failure]));
function failed(error:unknown):ApiOperationResult {
  const message=error instanceof Error?error.message:String(error),cause=error as {statusCode?:number;publicCode?:string};
  const code=cause?.statusCode??(message==='KNOWLEDGE_INDEX_WARMING'?503:message==='KNOWLEDGE_CURSOR_EXPIRED'?409:400);
  return {status:code,headers:{'cache-control':'no-store'},body:errorResponsePresentation({code:-1,message,...(cause?.publicCode?{error:cause.publicCode}:{})},code)};
}
function define<T>(contract:ApiOperationContract,prepare:(input:Omit<ApiOperationInput,'body'>)=>T,execute:(owner:T,input:ApiOperationInput)=>ApiOperationResult|Promise<ApiOperationResult>):ApiOperationDefinition {
  const bind=(input:Omit<ApiOperationInput,'body'>)=>{try{const owner=prepare(input);return async(parsed:ApiOperationInput)=>{try{return await execute(owner,parsed);}catch(error){parsed.signal?.throwIfAborted();return failed(error);}};}catch(error){input.signal?.throwIfAborted();return failed(error);}};
  return {contract,prepare:bind,handler:async input=>{const handler=bind(input);return typeof handler==='function'?handler(input):handler;}};
}
/** Search/cache/validation reuse the original Manager service and published catalog, without rescanning storage. */
export function createPersonaKnowledgeOperations(context:PersonaKnowledgeContext):readonly ApiOperationDefinition[] {
  const owner=createKnowledgeSearchOwner(context),published=createPersonaKnowledgeValidationOwner(context);
  const base=(id:string,method:ApiOperationContract['method'],path:string,body:ApiOperationContract['request']['body'],responses:ApiOperationContract['responses']):ApiOperationContract=>({
    operationId:'manager.personas.knowledge.'+id,aliases:[(path.startsWith('/roles/')?'knowledge-alias':id.startsWith('validation')?'knowledge':'persona')+':'+method+':'+path],contractVersion:'1.0.0',method,pathTemplate:path,exposure:'public',transport:'http',description:'Use the current selected persona’s original Manager-owned knowledge index or published catalog validation.',
    request:{path:{type:'object',required:['roleId'],additionalProperties:false,properties:{roleId:{type:'string',minLength:1}}},query:{type:'object'},headers:{type:'object'},body},responses:{...responses,...errors},
    effects:{mode:method==='POST'?'native-index-refresh':'read',description:method==='POST'?'Refresh the derived native index, optionally one kind/id or all; do not mutate plans, memories or bindings.':'Read native index summaries/status or validate only the published catalog; cold catalog schedules the original bounded refresh.'},
    recovery:{strategy:'original-index-version',description:'Keep the original role directory and Manager service/generation. Expired cursors return 409; warming dependencies return 503. Reload preserves original unlimited JSON body/default {}, kind+id/all semantics and native worker deadlines/lifecycle. A cancelled caller cannot destroy the shared service or substitute a new index.'},
    validators:[{id:'original-knowledge-owner',description:'Capture current role directory, authenticated connection, Manager identity and exact original search service before body parsing. Recheck after refresh and before disclosure. Context and persona bindings do not grant or restrict public API features.'},{id:'native-knowledge-query',description:'Retain native query normalization, keyword/fulltext modes, kind/archive filters, page size and versioned cursor, and published validation/write-limit DTOs. No direct storage scan replaces a cold published catalog.'}]
  });
  const path='/api/roles/:roleId/knowledge/',prepare=(input:Omit<ApiOperationInput,'body'>)=>owner.prepare(input.request,input.path.roleId,input.signal);
  const out=(data:unknown):ApiOperationResult=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data}});
  const operations:ApiOperationDefinition[]=[
    define(base('search','GET',path+'search',none,{'200':search}),prepare,(bound,input)=>out(bound.search(input.url.searchParams))),
    define(base('cache.status','GET',path+'cache/status',none,{'200':json(status)}),prepare,bound=>out(bound.status())),
    define(base('cache.reload','POST',path+'cache/reload',{kind:'json',schema:true,maxBytes:0,allowAnyContentType:true,emptyValue:{}},{'200':json(status),'202':json(status)}),prepare,async(bound,input)=>{const result=await bound.reload(input.body);return {...out(result.data),status:result.status};})
  ];
  for(const prefix of ['/api/roles','/roles'])operations.push(define(base('validation'+(prefix==='/roles'?'.alias':''),'GET',prefix+'/:roleId/knowledge-validation',none,{'200':validation}),input=>published.prepare(input.request,input.path.roleId,input.signal),bound=>out(bound.read())));
  return operations;
}
