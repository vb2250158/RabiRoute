import type http from 'node:http';
import type { createAllDayRecording } from './allDayRecordingRoutes.js';
import { createPersonaRecordingOperations } from './personaRecordingOperations.js';
import { createPersonaRecordingOwner,type PersonaRecordingAction } from './personaRecordingOwner.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';

/** Existing authority fixtures use controlled fake requests; real HTTP always uses the executable registry. */
export function recordingOperationFixture(runtime:ReturnType<typeof createAllDayRecording>,options:{local(request:http.IncomingMessage):boolean;readOnly():boolean;readBody(request:http.IncomingMessage):Promise<unknown>}){
  const context={runtime,roleDirectory:runtime.store.roleDirectory,...options},owner=createPersonaRecordingOwner(context),registry=new ManagerPluginRouteRegistry();
  registry.registerOperations('recording-regression-fixture',createPersonaRecordingOperations(context));
  return (request:http.IncomingMessage,url:URL,response:http.ServerResponse)=>{
    registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(url.pathname,body,undefined));
    if(typeof request[Symbol.asyncIterator]==='function')return registry.handle(request,url,response);
    const match=/^\/(?:api\/)?roles\/([^/]+)\/all-day-recording(?:\/(.*))?$/.exec(url.pathname);if(!match)return false;
    const action=(match[2]||'snapshot').split('/')[0],name=action==='index-repair'?'repair':action;
    void(async()=>{try{const bound=owner.prepare(request,decodeURIComponent(match[1]),name as PersonaRecordingAction),body=name==='settings'?await options.readBody(request):undefined;const data=await bound.execute(body,url.searchParams,{day:(match[2]||'').split('/')[1],file:(match[2]||'').split('/')[2]});bound.assertCurrent();if(name==='audio'||name==='media'){const reply=data as {status:number;bytes:Buffer};response.writeHead(reply.status);response.end(reply.bytes);}else {response.writeHead(200);response.end(JSON.stringify({code:0,data}));}}catch(error){response.writeHead((error as {statusCode?:number}).statusCode??400);response.end(JSON.stringify({code:-1,message:error instanceof Error?error.message:String(error)}));}})();return true;
  };
}
