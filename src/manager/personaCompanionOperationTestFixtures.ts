import type http from 'node:http';
import { registerLanAgentBodyGuard,assertLanAgentBodyAuthority } from './lanAgentBodyAuthority.js';
import type { CompanionActivity } from './companionActivity.js';
import type { PersonaCompanionContext } from './companionActivityRoutes.js';
import { createPersonaCompanionOperations } from './personaCompanionOperations.js';
import { ManagerPluginRouteRegistry } from './managerPluginRouteRegistry.js';

/** Test-only bridge for preexisting native HTTP regression fixtures. */
export function companionOperationFixture(service:CompanionActivity,options:Omit<PersonaCompanionContext,'service'|'roleDirectory'>&Partial<Pick<PersonaCompanionContext,'roleDirectory'>>){
  const registry=new ManagerPluginRouteRegistry();registry.registerOperations('companion-regression-fixture',createPersonaCompanionOperations({...options,service,roleDirectory:options.roleDirectory??(role=>'/fixture/'+role)}));
  return (request:http.IncomingMessage,url:URL,response:http.ServerResponse)=>{registerLanAgentBodyGuard(request,body=>assertLanAgentBodyAuthority(url.pathname,body,undefined));return registry.handle(request,url,response);};
}
