import { createRoleSkillReadOwner, type RoleSkillReadContext } from './roleSkillReadRoutes.js';
import { createRoleSkillDownloadOwner, ROLE_SKILL_DOWNLOAD_FRAME_BYTES, type RoleSkillDownloadContext } from './roleSkillDownloadRoutes.js';
import { roleSkillArchiveLimits } from './roleSkillArchive.js';
import { ManagerReadWorkerError } from './managerReadWorkerPool.js';
import { errorResponsePresentation } from '../shared/errorPresentation.js';
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiResponseContract } from './apiOperationContract.js';

export type PersonaSkillContext=RoleSkillReadContext&RoleSkillDownloadContext;
const str={type:'string'},none={kind:'none' as const,allowIgnoredBody:true};
const item={type:'object',required:['id','title','summary','updatedAt','status','keywords','path'],properties:{id:str,title:str,summary:str,updatedAt:str,status:{enum:['active','draft','archived']},keywords:{type:'array',items:str},path:str,source:{type:'object'}}};
const json=(data:unknown):ApiResponseContract=>({mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data}}});
const failure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code'],properties:{code:{const:-1},message:str,error:str,errorCode:str}}};
const errors=Object.fromEntries([400,403,404,409,413,500,503].map(status=>[String(status),failure]));
function failed(error:unknown,download:boolean):ApiOperationResult {
  const cause=error as {statusCode?:number;publicCode?:string};
  const worker=error instanceof ManagerReadWorkerError,unavailable=worker&&['busy','timeout','termination_unconfirmed'].includes(error.code);
  const status=cause?.statusCode??(unavailable?503:500);
  const message=error instanceof Error?error.message:String(error);
  const body=download?{code:-1,error:cause?.publicCode??(status===403?'LAN_AGENT_AUTHORIZATION_REVOKED':unavailable?'SKILL_ARCHIVE_UNAVAILABLE':'SKILL_ARCHIVE_FAILED')}
    :{code:-1,message,...(worker&&error.code==='timeout'?{errorCode:'SEARCH_DEADLINE_EXCEEDED'}:unavailable?{errorCode:'SEARCH_BUSY'}:{})};
  return {status,headers:{'cache-control':'no-store'},body:errorResponsePresentation(body,status)};
}
function define<T>(contract:ApiOperationContract,prepare:(input:Omit<ApiOperationInput,'body'>)=>T,execute:(owner:T,input:ApiOperationInput)=>Promise<ApiOperationResult>,download=false):ApiOperationDefinition {
  const bind=(input:Omit<ApiOperationInput,'body'>)=>{try{const owner=prepare(input);return async(parsed:ApiOperationInput)=>{try{return await execute(owner,parsed);}catch(error){parsed.signal?.throwIfAborted();return failed(error,download);}};}catch(error){input.signal?.throwIfAborted();return failed(error,download);}};
  return {contract,prepare:bind,handler:async input=>{const handler=bind(input);return typeof handler==='function'?handler(input):handler;}};
}
/** List, detail and ZIP use their native interactive reader/archive owner, including the static aliases. */
export function createPersonaSkillOperations(context:PersonaSkillContext):readonly ApiOperationDefinition[] {
  const read=createRoleSkillReadOwner(context),download=createRoleSkillDownloadOwner(context),operations:ApiOperationDefinition[]=[];
  for(const prefix of ['/api/roles','/roles'])for(const action of ['list','detail','download'] as const) {
    const suffix=action==='list'?'skills':'skills/:skillId'+(action==='download'?'/download':'');
    const contract:ApiOperationContract={operationId:'manager.personas.skills.'+action+(prefix==='/roles'?'.alias':''),aliases:[(prefix==='/roles'?'knowledge-alias':'knowledge')+':GET:'+prefix+'/:roleId/'+suffix],contractVersion:'1.0.0',method:'GET',pathTemplate:prefix+'/:roleId/'+suffix,exposure:'public',transport:'http',description:'Read the selected persona’s native Skill catalog/detail or download its complete ZIP; never execute Skill scripts.',
      request:{path:{type:'object',required:action==='list'?['roleId']:['roleId','skillId'],additionalProperties:false,properties:{roleId:{type:'string',minLength:1},...(action==='list'?{}:{skillId:{type:'string',minLength:1}})}},query:{type:'object'},headers:{type:'object'},body:none},
      responses:{'200':action==='download'?{mediaType:'application/zip',headers:{type:'object',required:['content-type','content-length','content-disposition','x-rabiroute-content-sha256','etag','cache-control','x-content-type-options'],properties:{'content-type':{const:'application/zip'},'content-length':{type:'string',pattern:'^[0-9]+$'},'content-disposition':str,'x-rabiroute-content-sha256':{type:'string',pattern:'^[a-f0-9]{64}$'},etag:str,'cache-control':{const:'private, no-store'},'x-content-type-options':{const:'nosniff'}}},stream:{framing:'bytes',maxFrameBytes:ROLE_SKILL_DOWNLOAD_FRAME_BYTES,maxBytes:roleSkillArchiveLimits.maxArchiveBytes,completion:'Original archive file reaches EOF, closes and its private lease is removed before admission releases.',cancellation:'Abort original generation/transfer, close and join the original file stream and remove the private lease. A quarantined worker retains its directory/admission until late confirmed release.'}}
        :json(action==='list'?{type:'array',items:item}:{...item,required:[...item.required,'content'],properties:{...item.properties,content:str}}),...errors},
      effects:{mode:'read',description:action==='download'?'Generate a private native ZIP artifact using the bounded interactive worker; never execute bundled scripts.':'Read the original catalog through the bounded interactive reader.'},
      recovery:{strategy:'repeatable-native-skill-read',description:'Repeat the same role/skill after a confirmed read failure. ZIP source limits and portable path rules remain native. Four download leases include generation, slow transfer and quarantined workers; default transfer timeout is 30 seconds. A failed artifact cleanup retains its admission slot.'},
      validators:[{id:'original-skill-owner',description:'Capture the original persona directory, authenticated connection and Manager generation before work; recheck after awaited worker/file operations and between output frames. Authenticated enabled remote connections require no persona or feature grant.'},{id:'native-skill-resources',description:'Use the original archive limits, private temporary root, O_NOFOLLOW, regular-file/nlink/size validation, SHA-256/ETag headers and late worker-release callback. Cancellation joins original file closure, including an unstarted iterator.'}]
    };
    if(action==='download')operations.push(define(contract,input=>download.prepare(input.request,input.path.roleId,input.path.skillId,input.signal),async(owner,input)=>{const result=await owner.archive(Boolean(input.url.search));return {status:200,headers:result.headers,stream:result.stream};},true));
    else operations.push(define(contract,input=>read.prepare(input.request,input.path.roleId,input.signal),async(owner,input)=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.read(input.path.skillId)}})));
  }
  return operations;
}
