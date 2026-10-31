import { personaReadSettings } from "../shared/personaReadSettings.js";
import { ReadSettingsError } from "../shared/readSettingsError.js";
import type http from 'node:http';
import { errorResponsePresentation } from '../shared/errorPresentation.js';
import { PERSONA_AVATAR_CONTENT_TYPES, PERSONA_AVATAR_MAX_BYTES } from '../shared/personaAvatarContract.js';
import { createPersonaAvatarOwner, PERSONA_AVATAR_FRAME_BYTES, type PersonaAvatarChanged } from './personaAvatarRoutes.js';
import { createPersonaDocumentOwner, PERSONA_DOCUMENT_MAX_BYTES } from './personaDocumentRoutes.js';
import { createPersonaReferenceOwner, RemotePersonaError } from './remotePersonaRoutes.js';
import type { PersonaResourceIdentity } from './personaResourceAdmission.js';
import type { LanguageStyleValidationResult, LanguageStyleValidationRequest } from '../languageStyleValidation.js';
import { createLanguageStyleOperations } from './languageStyleRoutes.js';
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiResponseContract } from './apiOperationContract.js';

type Options = { rolesRoot:string;roleDirectory(roleId:string):string;identity():PersonaResourceIdentity;
  validate(input:LanguageStyleValidationRequest):Promise<LanguageStyleValidationResult>;
  onAvatarChanged?(change:PersonaAvatarChanged):void };
const path = { type:'object',required:['roleId'],additionalProperties:false,properties:{roleId:{type:'string',minLength:1}} }, ignored={type:'object'};
const none={kind:'none' as const,allowIgnoredBody:true};
const jsonFailure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','message'],properties:{code:{const:-1},message:{type:'string'},uncertain:{const:true}}}};
const textFailure:ApiResponseContract={mediaType:'text/plain; charset=utf-8',schema:{type:'string'}};
const refFailure:ApiResponseContract={mediaType:'application/json',schema:{type:'object',required:['code','error','message'],properties:{code:{const:-1},error:{type:'string'},message:{type:'string'}}}};
function failed(error:unknown,kind:'avatar'|'document'|'reference'):ApiOperationResult {
  if(error instanceof ReadSettingsError)return {status:503,headers:{'cache-control':'no-store'},body:kind==='document'?error.message:{code:-1,error:error.code,message:error.message}};
  const cause=error as {statusCode?:number;uncertain?:boolean}|null;
  const status=cause?.statusCode ?? (kind==='reference'?503:400),message=error instanceof Error?error.message:String(error);
  if(kind==='document')return {status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'},body:message};
  if(kind==='reference')return {status,headers:{'cache-control':'no-store'},body:{code:-1,error:error instanceof RemotePersonaError?error.code:status===403?'REMOTE_PERSONA_ACCESS_DENIED':status===409?'MANAGER_IDENTITY_MISMATCH':'REMOTE_PERSONA_UNAVAILABLE',message:error instanceof RemotePersonaError?message:status===403||status===409?message:'人格读取失败，请检查远端设备、版本及 RabiLink 连接。'}};
  return {status,body:errorResponsePresentation({code:-1,message,...(cause?.uncertain?{uncertain:true}:{})},status)};
}
const define=<T>(contract:ApiOperationContract,prepare:(input:Omit<ApiOperationInput,'body'>)=>T,execute:(owner:T,input:ApiOperationInput)=>ApiOperationResult|Promise<ApiOperationResult>,kind:'avatar'|'document'|'reference'):ApiOperationDefinition=>{
  const bind=(input:Omit<ApiOperationInput,'body'>)=>{try{const owner=prepare(input);return async(parsed:ApiOperationInput)=>{try{return await execute(owner,parsed);}catch(error){parsed.signal?.throwIfAborted();return failed(error,kind);}};}catch(error){input.signal?.throwIfAborted();return failed(error,kind);}};
  return {contract,prepare:bind,handler:async input=>{const prepared=bind(input);return typeof prepared==='function'?prepared(input):prepared;}};
};

/** Persona resources only. Other plan/memory/activity owners remain separate registrations. */
export function createPersonaResourceOperations(options:Options):readonly ApiOperationDefinition[] {
  // This immutable wire contract and its configuration failure retire together.
  // A malformed style-body quota rejects only this operation before body decoding.
  let styleBodyMaxBytes = 0, styleBodyError: ReadSettingsError | undefined;
  try { styleBodyMaxBytes = personaReadSettings.configBytes; }
  catch (error) { if (!(error instanceof ReadSettingsError)) throw error; styleBodyError = error; }
  const avatar=createPersonaAvatarOwner({get rolesRoot(){return options.rolesRoot;},identity:options.identity,onChanged:options.onAvatarChanged});
  const document=createPersonaDocumentOwner({roleDirectory:options.roleDirectory,identity:options.identity});
  const reference=createPersonaReferenceOwner(options);
  const base=(id:string,method:ApiOperationContract['method'],suffix:string,body:ApiOperationContract['request']['body'],responses:ApiOperationContract['responses'],mode='read'):ApiOperationContract=>({
    operationId:'manager.personas.resources.'+id,...(suffix==='avatar'?{}:{aliases:[`persona:${method}:/api/roles/:roleId/${suffix}`]}),contractVersion:'1.0.0',method,pathTemplate:'/api/roles/:roleId/'+suffix,exposure:'public',transport:'http',description:'Read or update the original persona resource, keeping the selected role, authenticated connection, native file rules and Manager identity.',
    request:{path,query:ignored,headers:ignored,body},responses,effects:{mode,description:mode==='read'?'Read the original persona file, avatar or revision-bound style validation without altering its binding.':'Use the native persona avatar owner and audit path. Only the managed avatar/config changes; publish the original versioned relative URL event.'},
    recovery:{strategy:mode==='read'?'repeatable-read':'native-avatar-readback',description:'Retain the selected role and original Manager generation. Avatar PUT of identical bytes retains its content-addressed image; DELETE is idempotent. Read the current resource after uncertain writes. Persona reference validation requires the same current revision and never substitutes a caller style URL.'},
    validators:[{id:'original-persona-resource',description:'Capture original role and connection/generation before body parsing. Recheck after awaited native work and while streaming. Authenticated enabled connections use the public API without role or feature allowlists.'},
      {id:'native-persona-resource-rules',description:'Native persona owners retain avatar signatures and upload bound, selected Markdown file/realpath limits, reference document/config limits and hash revision, and owner-bound style validation. Known binary streams keep native cache, content length and MIME. Cancellation joins the original stream/file closure.'}]
  });
  const errors=(descriptor:ApiResponseContract)=>Object.fromEntries([400,403,404,409,413,503].map(status=>[String(status),descriptor]));
  const mutation:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:{type:'object',required:['code','data'],properties:{code:{const:0},data:{type:'object',required:['configured'],additionalProperties:false,properties:{configured:{type:'boolean'},avatarUrl:{type:'string'}}}}}};
  const stream=(mediaType:string):ApiResponseContract=>({mediaType,stream:{framing:'bytes',maxFrameBytes:PERSONA_AVATAR_FRAME_BYTES,completion:'Original file reaches EOF and closes before the request lease releases.',cancellation:'Destroy the original file stream and join its close acknowledgement, including a never-started iterator.'}});
  const avatarResponse={...stream(PERSONA_AVATAR_CONTENT_TYPES[0]),alternatives:PERSONA_AVATAR_CONTENT_TYPES.slice(1).map(stream)};
  const styleSchema=createLanguageStyleOperations({validate:options.validate})[0]!.contract.responses['200']!.schema;
  const refSnapshot={type:'object',required:['code','data'],additionalProperties:false,properties:{code:{const:0},data:{type:'object',required:['applicationGenerationId','managerInstanceId','schemaVersion','roleId','file','document','personaConfig','revision'],additionalProperties:false,properties:{applicationGenerationId:{type:'string'},managerInstanceId:{type:'string'},schemaVersion:{const:1},roleId:{type:'string'},file:{type:'string'},document:{type:'string'},personaConfig:{type:'object'},revision:{type:'string',pattern:'^[a-f0-9]{64}$'}}}}};
  return [
    define(base('avatar.read','GET','avatar',none,{'200':avatarResponse,...errors(jsonFailure)}),input=>avatar.prepare(input.request,input.path.roleId,input.signal),(owner)=>{const bytes=owner.read();return {status:200,headers:{'content-type':bytes.contentType,'content-length':String(bytes.sizeBytes),'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'},stream:{frames:bytes.frames,cancel:bytes.cancel}};},'avatar'),
    define(base('avatar.save','PUT','avatar',{kind:'binary',mediaType:'application/octet-stream',maxBytes:PERSONA_AVATAR_MAX_BYTES,allowAnyContentType:true,rules:['Original MIME normalization and PNG/JPEG/WebP/GIF signatures; empty payload rejected.']},{'200':mutation,...errors(jsonFailure)},'native-avatar-mutation'),input=>avatar.prepare(input.request,input.path.roleId,input.signal),async(owner,input)=>({status:200,body:{code:0,data:await owner.save(String(input.request.headers['content-type']||''),input.body as http.IncomingMessage)}}),'avatar'),
    define(base('avatar.remove','DELETE','avatar',none,{'200':mutation,...errors(jsonFailure)},'native-avatar-mutation'),input=>avatar.prepare(input.request,input.path.roleId,input.signal),owner=>({status:200,body:{code:0,data:owner.remove()}}),'avatar'),
    define(base('document.read','GET','persona-document',none,{'200':{mediaType:'text/markdown; charset=utf-8',binary:{maxBytes:PERSONA_DOCUMENT_MAX_BYTES}},...errors(textFailure)}),input=>document.prepare(input.request,input.path.roleId,input.signal),(owner,input)=>{const bytes=owner.read(input.url.searchParams.get('file'));return {status:200,body:bytes,headers:{'content-type':'text/markdown; charset=utf-8','content-length':String(bytes.byteLength),'cache-control':'no-store','x-content-type-options':'nosniff'}};},'document'),
    define(base('reference.read','GET','persona-reference',none,{'200':{mediaType:'application/json',schema:refSnapshot},...errors(refFailure)}),input=>reference.prepare(input.request,input.path.roleId,input.signal),async(owner,input)=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.read(input.url.searchParams.get('file'))}}),'reference'),
    define(base('reference.language-style.validate','POST','persona-reference/language-style',{kind:'json',maxBytes:styleBodyMaxBytes,allowAnyContentType:true,schema:{type:'object',required:['text','revision'],additionalProperties:false,properties:{text:{type:'string'},file:{type:'string'},revision:{type:'string',pattern:'^[a-f0-9]{64}$'}}}},{'200':{mediaType:'application/json',schema:styleSchema},...errors(refFailure)}),input=>{const owner=reference.prepare(input.request,input.path.roleId,input.signal);if(styleBodyError)throw styleBodyError;return owner;},async(owner,input)=>({status:200,headers:{'cache-control':'no-store'},body:{code:0,data:await owner.validateStyle(input.body)}}),'reference')
  ];
}
