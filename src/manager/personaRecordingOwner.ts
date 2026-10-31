import type http from 'node:http';
import type { createAllDayRecording } from './allDayRecordingRoutes.js';
import { recordingOperation } from './allDayRecording.js';
import { hasAuthenticatedConnectionRequest } from './connectionRequestAccess.js';
import { localModelSettingsRequestAllowed } from './speechModelSettingsAccess.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';
export type PersonaRecordingAction='snapshot'|'recent'|'catalog'|'page'|'transcripts'|'events'|'settings'|'start'|'stop'|'repair'|'media'|'audio';
export type PersonaRecordingContext={readonly runtime:ReturnType<typeof createAllDayRecording>;roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity;local(request:http.IncomingMessage):boolean;readOnly():boolean};
const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
/** Functional admission binds the original capture/store/read model; native work never moves into a proxy handler. */
export function createPersonaRecordingOwner(context:PersonaRecordingContext){return {prepare(request:http.IncomingMessage,roleId:string,action:PersonaRecordingAction,signal?:AbortSignal){
  let current:()=>void;try{current=preparePersonaResourceAdmission(request,signal,context.identity);}catch(error){throw Object.assign(error as object,{statusCode:(error as {statusCode?:number}).statusCode??403});}
  if(!roleId||roleId.length>128||/[\\/\x00-\x1f]/.test(roleId)||roleId==='.'||roleId==='..')throw failure('Invalid persona');
  const directory=context.roleDirectory(roleId),runtime=context.runtime,service=runtime.service,store=runtime.store,reads=runtime.reads,originallyAuthenticated=hasAuthenticatedConnectionRequest(request);let attempted=false;
  const assertCurrent=()=>{try{current();}catch(error){throw Object.assign(error as object,{statusCode:(error as {statusCode?:number}).statusCode??403});}
    if(context.roleDirectory(roleId)!==directory||context.runtime!==runtime||runtime.service!==service||runtime.store!==store||runtime.reads!==reads)throw failure('Original recording owner changed',409);
    if(!originallyAuthenticated&&(!localModelSettingsRequestAllowed(request)||!context.local(request)||request.headers['x-rabilink-tunnel-local']))throw failure('Recording authorization denied',403);
    if(['settings','start','stop','repair'].includes(action)&&context.readOnly())throw failure('Read only',403);
  };
  assertCurrent();
  if(['settings','start','stop','repair'].includes(action)&&!String(request.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw failure('Use application/json for recording controls',415);
  return {assertCurrent,mutationOutcome:()=>attempted?'unknown' as const:'not_started' as const,async execute(body:unknown,query:URLSearchParams,path:Readonly<Record<string,string>>={}){
    assertCurrent();let data:unknown;
    if(action==='snapshot')data={...await service.snapshot(roleId,assertCurrent),devices:await store.mobileDevices(assertCurrent)};
    else if(action==='recent')data=await recordingOperation(assertCurrent,()=>reads.recent(roleId));
    else if(action==='catalog'){const day=query.get('day')??undefined;if(query.get('refresh')==='1')reads.invalidate(roleId,day);data=await recordingOperation(assertCurrent,()=>reads.catalog(roleId,day));if(query.get('summary')==='1')data={...data as object,events:[]};}
    else if(action==='page'){const direction=query.get('direction');if(direction!=='older'&&direction!=='newer')throw failure('Invalid event direction');data=await recordingOperation(assertCurrent,()=>reads.page(roleId,direction,{time:Number(query.get('time')),id:query.get('id')||''},query.get('source')||'all',100,query.get('type')||'all'));}
    else if(action==='transcripts'||action==='events')data=await recordingOperation(assertCurrent,()=>action==='transcripts'?reads.transcripts(roleId,Number(query.get('since')),Number(query.get('until'))):reads.timeline(roleId,Number(query.get('since')),Number(query.get('until'))));
    else if(action==='settings'){attempted=true;data=await service.configure(roleId,body,assertCurrent);assertCurrent();reads.invalidate(roleId);}
    else if(action==='start'){attempted=true;data=await service.start(roleId,assertCurrent);}
    else if(action==='stop'){attempted=true;data=await service.stop(roleId,false,assertCurrent);}
    else if(action==='repair'){assertCurrent();attempted=true;runtime.repairIndex(roleId,path.day);data={queued:true};}
    else if(action==='media'){const file=path.file;if(!/^\d{4}-\d{2}-\d{2}$/.test(path.day)||!file||!/[a-f0-9]{64}\.(jpg|wav)$/.test(file))throw failure('Invalid recording media');const extension=file.slice(-3);const bytes=await recordingOperation(assertCurrent,()=>reads.media(roleId,path.day,file.slice(0,-4),extension,signal));assertCurrent();return {status:200,contentType:extension==='wav'?'audio/wav':'image/jpeg',bytes};}
    else {
      const timeline=await recordingOperation(assertCurrent,()=>reads.timeline(roleId,Number(query.get('since')),Number(query.get('until'))));const event=timeline.events.find(row=>row.id===query.get('id'));
      if(!event&&(timeline.loading||timeline.pendingDays.length))throw failure('Recording history is loading; retry playback when ready',409);
      if(event?.mobileMedia){const bytes=await recordingOperation(assertCurrent,()=>runtime.mobileAudio(event.mobileMedia!.owner,event.mobileMedia!.chunks,assertCurrent));return {status:200,contentType:'audio/wav',bytes};}
      if(!event?.speechRecordId)throw failure('Recording not found',404);
      const audio=await recordingOperation(assertCurrent,()=>runtime.audio(event.speechRecordId!,assertCurrent));return {status:audio.status,contentType:audio.contentType,bytes:audio.body};
    }
    assertCurrent();return data;
  }};
}};}
