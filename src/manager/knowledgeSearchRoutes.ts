import type http from 'node:http';
import path from 'node:path';
import { knowledgeReference,type KnowledgeKind } from '../roleKnowledgeSearch.js';
import type { KnowledgeSearchService } from './knowledgeSearchService.js';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';

export type KnowledgeSearchContext={service?:KnowledgeSearchService;roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity};
function kind(value: unknown): KnowledgeKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "plan" && value !== "recent" && value !== "consolidated") throw new Error("Invalid knowledge kind");
  return value;
}


/** The Manager-owned native service retains index state, storage workers and refresh lifecycle. */
export function createKnowledgeSearchOwner(context:KnowledgeSearchContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),directory=context.roleDirectory(roleId),service=context.service;
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(directory)||context.service!==service)throw Object.assign(new Error('Original knowledge index owner changed.'),{statusCode:409});};
    const index=()=>{assertCurrent();if(!service)throw new Error('KNOWLEDGE_INDEX_WARMING');return service.ensure(roleId,directory);};
    return {
      search(parameters:URLSearchParams) {
        const source=index(),mode=parameters.get('mode')??'keywords';
        if(mode!=='keywords'&&mode!=='fulltext')throw new Error('Invalid search mode');
        const data=source.search({query:parameters.get('query')??'',mode,kind:kind(parameters.get('kind')),archived:parameters.get('archived')==='1',limit:Number(parameters.get('limit')??'10'),cursor:parameters.get('cursor')??undefined});
        assertCurrent();return data;
      },
      status(){index();const data=service!.status(directory);assertCurrent();return data;},
      async reload(raw:unknown) {
        index();
        const body=raw as Record<string,unknown>,targetKind=kind(body.kind),id=body.id;
        if((id!==undefined&&(typeof id!=='string'||!id.trim()||id.length>512))||Boolean(targetKind)!==Boolean(id))throw new Error('Provide both kind and id for a point reload');
        if(body.all!==undefined&&typeof body.all!=='boolean')throw new Error('all must be boolean');
        if(body.all===true&&targetKind)throw new Error('Choose either all or a point reload');
        assertCurrent();
        await service!.reload(roleId,directory,body.all===true,targetKind?knowledgeReference(targetKind,id as string):undefined);
        assertCurrent();const data=service!.status(directory);
        return {status:'refreshing' in data&&data.refreshing?202:200,data};
      }
    };
  }};
}
