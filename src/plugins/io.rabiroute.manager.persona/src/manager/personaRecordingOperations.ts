import { apiDigest,type ApiOperationContract,type ApiOperationDefinition,type ApiOperationInput,type ApiOperationResult,type ApiResponseContract } from '@rabiroute/host-api/manager/apiOperationContract';
import { errorResponsePresentation } from '@rabiroute/host-api/shared/errorPresentation';
import { ALL_DAY_REVIEW_SOURCES, ALL_DAY_SOURCES, type AllDayEvent } from '@rabiroute/host-api/shared/allDayRecording';
import { MESSAGE_EVENT_CATEGORIES } from '@rabiroute/host-api/shared/personaEventTypes';
import { createPersonaRecordingOwner,type PersonaRecordingContext,type PersonaRecordingAction } from './personaRecordingOwner.js';
const str={type:'string'},num={type:'number'},bool={type:'boolean'},array=(items:unknown)=>({type:'array',items}),object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required});
const event=object({id:str,startedAt:num,endedAt:num,source:{enum:[...ALL_DAY_REVIEW_SOURCES]},deviceId:str,kind:{enum:['audio','image','window','status','device','message']},text:str,state:{enum:['saved','error']},transcriptionState:{enum:['pending','processing','ready','empty','error']},media:str,speechRecordId:str,mobileMedia:object({owner:str,chunks:array(str)},['owner','chunks']),homeAssistant:object({eventKind:str,resourceName:str,entityId:str,domain:str,state:str},['eventKind','resourceName'])},['id','startedAt','endedAt','source','deviceId','kind','text','state']);
const settings=object({sources:object(Object.fromEntries(ALL_DAY_SOURCES.map(source=>[source,bool])),[...ALL_DAY_SOURCES]),intervalSeconds:num,cameraIndex:num,mobileDeviceIds:array(str),messageSources:array({enum:MESSAGE_EVENT_CATEGORIES.map(category=>category.value)})},['sources','intervalSeconds','cameraIndex','mobileDeviceIds']);
const catalog=object({events:array(event),days:array(str),incompleteDays:array(str),loading:bool,pendingDays:array(str),readError:str},['events','days','incompleteDays']);
const timeline=object({events:array(event),loading:bool,pendingDays:array(str),readError:str},['events','loading','pendingDays']);
const snapshot=object({enabled:bool,settings,running:bool,preparing:bool,sourceErrors:{type:'object',additionalProperties:str},activeRoleId:{type:['string','null']},startedAt:{type:['number','null']},lastSampleAt:{type:['number','null']},error:str,devices:array(object({id:str,lastReceivedAt:num},['id','lastReceivedAt']))},['settings','running','activeRoleId','startedAt','lastSampleAt','error']);
const page=object({events:array(event),hasMore:bool,loading:bool,pendingDays:array(str),readError:str,cursor:object({time:num,id:str},['time','id'])},['events','hasMore','loading','pendingDays','cursor']);
const json=(data:unknown):ApiResponseContract=>({mediaType:'application/json; charset=utf-8',schema:object({code:{const:0},data},['code','data'])});
const failure:ApiResponseContract={mediaType:'application/json; charset=utf-8',schema:object({code:{const:-1},message:str,uncertain:{const:true}},['code','message'])};
const binary:ApiResponseContract={mediaType:'*/*',binary:{maxBytes:Number.MAX_SAFE_INTEGER}};
function failed(error:unknown,outcome:'not_started'|'unknown'):ApiOperationResult{const status=(error as {statusCode?:number}).statusCode??400;return {status,mutationOutcome:outcome,headers:{'cache-control':'no-store'},body:errorResponsePresentation({code:-1,message:error instanceof Error?error.message:String(error),...(outcome==='unknown'?{uncertain:true}:{})},status)};}
/** Twenty-four concrete routes; the original Host service and bounded worker pools retain execution ownership. */

const recordingPurposes: Record<string, string> = {
  "snapshot": "查询全天记录状态",
  "recent": "查询近期全天记录",
  "catalog": "查询全天记录目录",
  "page": "分页查询全天记录",
  "transcripts": "查询全天录音转写",
  "events": "查询全天记录事件",
  "settings": "配置全天记录",
  "start": "启动全天记录",
  "stop": "停止全天记录",
  "repair": "修复全天记录索引",
  "media": "读取全天记录媒体",
  "audio": "读取全天记录音频"
};

export function createPersonaRecordingOperations(context:PersonaRecordingContext):readonly ApiOperationDefinition[]{
  const owner=createPersonaRecordingOwner(context),definitions:ApiOperationDefinition[]=[];
  for(const prefix of ['/api/roles','/roles'])for(const [action,method,suffix,response] of [
    ['snapshot','GET','',snapshot],['recent','GET','/recent',catalog],['catalog','GET','/catalog',catalog],['page','GET','/page',page],['transcripts','GET','/transcripts',timeline],['events','GET','/events',timeline],['settings','PUT','/settings',snapshot],['start','POST','/start',snapshot],['stop','POST','/stop',snapshot],['repair','POST','/index-repair/:day',object({queued:{const:true}},['queued'])],['media','GET','/media/:day/:file',null],['audio','GET','/audio',null]
  ] as const){
    const path=prefix+'/:roleId/all-day-recording'+suffix,media=action==='audio'||action==='media';
    const contract:ApiOperationContract={operationId:'manager.personas.recording.'+action+(prefix==='/roles'?'.alias':''),contractVersion:'1.0.0',method,pathTemplate:path,exposure:'public',transport:'http',description:'Use the role’s original Host recording service, persistent events, bounded historical projections, controlled media and authenticated phone audio.',
      ...(action==='page'&&prefix==='/api/roles'?{searchable:{scope:'events',legend:'角色记录里的画面采集 / saved screen and camera captures',kinds:['capture']}}:{}),
      request:{path:object({roleId:str,...(suffix.includes(':day')?{day:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'}}:{}),...(action==='media'?{file:{type:'string',pattern:'^[a-f0-9]{64}\\.(jpg|wav)$'}}:{})},['roleId',...(suffix.includes(':day')?['day']:[]),...(action==='media'?['file']:[])]),query:object({}),headers:object({}),body:action==='settings'?{kind:'json',maxBytes:0,allowAnyContentType:true,emptyValue:{},schema:true}:{kind:'none',allowIgnoredBody:true}},
      responses:media?{default:binary,...Object.fromEntries([400,403,404,409,415].map(status=>[status,{...failure,alternatives:[binary]}]))}:{200:json(response),...Object.fromEntries([400,403,404,409,415].map(status=>[status,failure]))},
      effects:{mode:['settings','start','stop','repair'].includes(action)?'native-recording-control':'read',description:'The original service serializes configuration/start/stop and retains the sole Host capture owner. Explicit repair queues native derived-index work without waiting for a scan. Catalog/recent reads may populate bounded projections; raw durable events are not deleted.'},
      recovery:{strategy:'original-recording-readback',description:'Read original settings, enabled/running state and event IDs before retrying uncertain controls. Native start/stop and index-repair deduplication remain authoritative; HTTP queued or loading is not worker completion. Reconcile the original phone event before requesting its private media.'},
      validators:[{id:'original-recording-owner',description:'Capture original connection lease, Manager identity, role directory and service/store/read model before body consumption. Preserve local origin/readOnly checks and authenticated remote default public access without feature grants. Native controls revalidate inside their original queue, storage and Host calls.'},{id:'native-history-media',description:'Keep original 26-hour bounds, full stable event cursor, source/type filters, page size 100, cold/loading metadata, bounded worker ownership and media cancellation. Phone owner/chunks come only from an event visible in the role’s selected-source timeline. No arbitrary file paths or source identities are accepted.'}]
    };
    const prepare=(input:Omit<ApiOperationInput,'body'>)=>{try{const bound=owner.prepare(input.request,input.path.roleId,action as PersonaRecordingAction,input.signal);return async(parsed:ApiOperationInput)=>{try{const data=await bound.execute(parsed.body,parsed.url.searchParams,parsed.path);bound.assertCurrent();if(media){const reply=data as {status:number;contentType:string;bytes:Buffer};return {status:reply.status,mutationOutcome:bound.mutationOutcome(),headers:{'cache-control':'private, no-store','content-type':reply.contentType},body:reply.bytes};}return {status:200,mutationOutcome:bound.mutationOutcome(),headers:{'cache-control':'no-store'},body:{code:0,data}} as ApiOperationResult;}catch(error){parsed.signal?.throwIfAborted();return failed(error,bound.mutationOutcome());}};}catch(error){input.signal?.throwIfAborted();return failed(error,'not_started');}};
    definitions.push({contract,discovery:{title:recordingPurposes[action],summary:recordingPurposes[action]+"。",category:{id:"knowledge.recording",title:"全天记录",parentId:"knowledge"},keywords:[recordingPurposes[action],action.replace(/[.-]/g," "),"persona"],inputSources:[{field:"path.roleId",operationId:"manager.roles.list",resultPath:"/data/roles",valuePath:"/roleId"}]},prepare,handler:async input=>{const handler=prepare(input);return typeof handler==='function'?handler(input):handler;},
      ...(contract.searchable ? { searchLanes: ({request,roles}) => roles.map(({roleId}) => ({
        key: roleId, source: 'events', agent: roleId,
        async read({query,signal,snapshot}) {
          const to = snapshot && /^\d+$/.test(snapshot) ? Number(snapshot) : Math.round((query.to ?? Date.now()/1000)*1000)+1;
          const bound=owner.prepare(request,roleId,'page',signal);
          const parameters=new URLSearchParams({direction:'older',type:'image',time:String(to)});
          const result=await bound.execute(undefined,parameters) as {events:AllDayEvent[];hasMore:boolean;loading:boolean;readError?:string};
          const recent = result.loading && !result.events.length
            ? (await owner.prepare(request,roleId,'recent',signal).execute(undefined,new URLSearchParams()) as {events:AllDayEvent[]}).events : [];
          const items=[...(result.events.length ? result.events : recent)].flatMap(event=>{
            if (event.kind!=='image' || event.state!=='saved' || !event.media || !/^media\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.jpg$/.test(event.media)
                || !Number.isFinite(event.startedAt) || event.startedAt >= to) return [];
            const detailUrl='/api/roles/'+encodeURIComponent(roleId)+'/all-day-recording/'+event.media;
            const observedAt=new Date(event.startedAt).toISOString();
            const label=event.source==='camera'?'画面采集 · 摄像头':'画面采集 · 屏幕';
            return [{source:'events',kind:'capture',agent:roleId,label,excerpt:event.text || label,
              origin:{agent:roleId,recordId:event.id,kind:event.source},detailUrl,handle:{detailUrl},
              searchText:[label,event.text,event.deviceId,event.source,event.source==='camera'?'摄像 照片 camera':'桌面 截图 屏幕采集 screen desktop capture'].join(' '),
              evidence:{state:'confirmed' as const,observedAt,evidenceRefs:[detailUrl]}}];
          });
          const gap = result.loading ? 'CAPTURE_HISTORY_LOADING' : result.readError ? 'CAPTURE_HISTORY_READ_FAILED' : result.hasMore ? 'CAPTURE_HISTORY_BOUNDED' : undefined;
          return {items,version:apiDigest(items),snapshot:String(to),complete:!gap,
            gaps:gap?[{code:gap,message:result.readError || 'Some capture history is outside the current returned window.'}]:[]};
        }
      })) } : {})});
  }
  return definitions;
}
