import type http from 'node:http';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';
import { createPersonaHistoryOperations, type PersonaHistoryContext } from './personaHistoryOperations.js';
import type { PersonaChatHistoryContext } from './personaChatHistoryRoutes.js';
import type { PersonaVoiceTranscriptRouteContext } from './personaVoiceTranscriptRoutes.js';
import type { MessageEndpointHistoryContext } from './messageEndpointHistoryRoutes.js';

/** Test-only HTTP adapter: dispatch through the actual executable registry and retire its request lease on close. */
function dispatch(request:http.IncomingMessage,url:URL,response:http.ServerResponse,context:PersonaHistoryContext) {
  const registry=new ManagerPluginRouteRegistry(),registration=registry.registerOperations('persona-history-fixture',createPersonaHistoryOperations(context));
  response.once('close',()=>{void registration.dispose();});
  return registry.handle(request,url,response);
}
const unusedQuery:MessageEndpointHistoryContext['queryHistory']=async()=>{throw new Error('History query is outside this fixture.');};
export function dispatchChatHistoryFixture(request:http.IncomingMessage,url:URL,response:http.ServerResponse,roleDir:PersonaChatHistoryContext['roleDir'],readTasks?:PersonaChatHistoryContext['readTasks']) {
  return dispatch(request,url,response,{roleDir,readTasks,queryHistory:unusedQuery});
}
export function dispatchVoiceTranscriptFixture(request:http.IncomingMessage,url:URL,response:http.ServerResponse,context:PersonaVoiceTranscriptRouteContext) {
  return dispatch(request,url,response,{...context,queryHistory:unusedQuery});
}
export function dispatchMessageHistoryFixture(request:http.IncomingMessage,url:URL,response:http.ServerResponse,context:MessageEndpointHistoryContext&{json?:(response:http.ServerResponse,status:number,body:unknown)=>void}) {
  return dispatch(request,url,response,{roleDir:context.roleDirectory,identity:context.identity,queryHistory:context.queryHistory});
}
