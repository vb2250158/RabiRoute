import type http from 'node:http';
import path from 'node:path';
import { knowledgeReference,type KnowledgeKind } from '@rabiroute/host-api/roleKnowledgeSearch';
import type { KnowledgeSearchService } from '@rabiroute/host-api/manager/knowledgeSearchService';
import { preparePersonaResourceAdmission,type PersonaResourceIdentity } from './personaResourceAdmission.js';
import { ApiContractError } from '@rabiroute/host-api/manager/apiOperationContract';

export type KnowledgeSearchContext={service?:KnowledgeSearchService;roleDirectory(roleId:string):string;identity?():PersonaResourceIdentity};
function kind(value: unknown, invalid: () => Error): KnowledgeKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "plan" && value !== "recent" && value !== "consolidated") throw invalid();
  return value;
}


/** The Manager-owned native service retains index state, storage workers and refresh lifecycle. */
export function createKnowledgeSearchOwner(context:KnowledgeSearchContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const admission=preparePersonaResourceAdmission(request,signal,context.identity),directory=context.roleDirectory(roleId),service=context.service;
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(directory)||context.service!==service)throw Object.assign(new Error('Original knowledge index owner changed.'),{statusCode:409});};
    const root='/api/roles/'+encodeURIComponent(roleId)+'/knowledge/';
    const failure=(field:string,reason:string,reload=false,status=400,code='KNOWLEDGE_PARAMETER_INVALID')=>new ApiContractError(status,code,field,
      'manager.personas.knowledge.'+(reload?'cache.reload':'search'),false,undefined,
      reason+` Read GET ${root}cache/status for current index readiness/version. Read GET ${root}search?query=<URL-encoded-original-topic> for summaries and data.items[].id/kind and data.nextCursor, carrying the original valid mode, kind, archived and limit parameters and preserving original omissions. `
      +'For cursor recovery keep the original role/query/mode/kind/archived/limit and omit only the old cursor on the first page; do not substitute example defaults. Correct an invalid indicated parameter using the current contract before searching. Summary discovery does not call a memory-detail endpoint (which can touch viewedAt) or authorize a cache reload. Handle 401/403 and unavailable index/transport separately; do not create a replacement index or retry a reload automatically');
    const index=()=>{assertCurrent();if(!service)throw new Error('KNOWLEDGE_INDEX_WARMING');return service.ensure(roleId,directory);};
    return {
      search(parameters:URLSearchParams) {
        const source=index(),mode=parameters.get('mode')??'keywords';
        if(mode!=='keywords'&&mode!=='fulltext')throw failure('query.mode','mode must be keywords or fulltext; omit it to use keywords.');
        let data;
        try { data=source.search({query:parameters.get('query')??'',mode,kind:kind(parameters.get('kind'),()=>failure('query.kind','kind must be plan, recent or consolidated; omit it or use an empty value for no kind filter.')),archived:parameters.get('archived')==='1',limit:Number(parameters.get('limit')??'10'),cursor:parameters.get('cursor')??undefined}); }
        catch(error) {
          assertCurrent();
          const native=error as {code?:string;field?:string};
          if(native?.code==='KNOWLEDGE_PARAMETER_INVALID'&&native.field==='query')throw failure('query.query','query must contain 1–512 characters after the original normalization.');
          if(native?.code==='KNOWLEDGE_PARAMETER_INVALID'&&native.field==='mode')throw failure('query.mode','mode must be keywords or fulltext.');
          if(native?.code==='KNOWLEDGE_PARAMETER_INVALID'&&native.field==='limit')throw failure('query.limit','limit must be an integer from 1 through 100; omit it to use 10.');
          if(native?.code==='KNOWLEDGE_CURSOR_INVALID')throw failure('query.cursor','Use the data.nextCursor returned by the same knowledge search. Do not construct or edit the version/offset cursor.',false,400,'KNOWLEDGE_CURSOR_INVALID');
          if(native?.code==='KNOWLEDGE_CURSOR_EXPIRED')throw failure('query.cursor','The index version changed. Read the first page with the same original role/query/mode/kind/archived/limit and omit only cursor, then copy its returned data.nextCursor unchanged.',false,409,'KNOWLEDGE_CURSOR_EXPIRED');
          throw error;
        }
        assertCurrent();
        const status=service!.status(directory),errors='errors' in status?status.errors:0;
        return {...data,coverage:{scope:'indexed-inventory' as const,state:errors?'partial' as const:'complete' as const,errors}};
      },
      status(){index();const data=service!.status(directory);assertCurrent();return data;},
      async reload(raw:unknown) {
        index();
        const body=raw as Record<string,unknown>,targetKind=kind(body.kind,()=>failure('body.kind','kind must be plan, recent or consolidated for a point reload.',true)),id=body.id;
        if(id!==undefined&&(typeof id!=='string'||!id.trim()||id.length>512))throw failure('body.id','For a point reload supply both kind and an existing nonempty id of at most 512 characters. Get kind/id from knowledge search summaries on the same role.',true);
        if(Boolean(targetKind)!==Boolean(id))throw failure(targetKind?'body.id':'body.kind','For a point reload supply kind and id together, using the same summary item. Omit both for the original ordinary cache refresh; all=true explicitly requests a full refresh.',true);
        if(body.all!==undefined&&typeof body.all!=='boolean')throw failure('body.all','all must be a boolean when provided.',true);
        if(body.all===true&&targetKind)throw failure('body.all','Choose all=true or a point kind/id pair. Do not combine them; inspect the original refresh intent instead of choosing a target automatically.',true);
        assertCurrent();
        await service!.reload(roleId,directory,body.all===true,targetKind?knowledgeReference(targetKind,id as string):undefined);
        assertCurrent();const data=service!.status(directory);
        return {status:'refreshing' in data&&data.refreshing?202:200,data};
      }
    };
  }};
}
