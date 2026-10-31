import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageContextRecord, RecentMessageContextQuery } from '../messageContextStore.js';
import type { MessageHistorySearchResult } from '../messageHistorySearchIndex.js';
import { ManagerReadWorkerError } from './managerReadWorkerPool.js';
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from './personaResourceAdmission.js';

export type MessageEndpointHistoryContext = {
  roleDirectory(roleId: string): string;
  identity?(): PersonaResourceIdentity;
  queryHistory(roleDir: string, query: RecentMessageContextQuery, options: {signal:AbortSignal;deadlineAt?:number;requestId?:string}): Promise<MessageContextRecord[] | MessageHistorySearchResult>;
};
function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}


const fail = (details: Record<string, unknown>): never => { throw Object.assign(new Error(String(details.message || 'Invalid history query.')), {statusCode:400,publicDetails:details}); };

/** Native bounded history query; the existing pool retains worker termination/quarantine ownership. */
export function createMessageEndpointHistoryOwner(context: MessageEndpointHistoryContext) {
  return {prepare(request:http.IncomingMessage,roleId:string,signal?:AbortSignal) {
    const receivedAt=performance.now(),admission=preparePersonaResourceAdmission(request,signal,context.identity),roleDir=context.roleDirectory(roleId);
    const assertCurrent=()=>{admission();if(path.resolve(context.roleDirectory(roleId))!==path.resolve(roleDir))throw Object.assign(new Error('Persona directory changed while reading original message history.'),{statusCode:409});};
    return {async read(parameters:URLSearchParams) {
      assertCurrent();
      const url={searchParams:parameters};
      const budget = url.searchParams.get("budgetMs");
      if (budget !== null && (!budget.trim() || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1 || Number(budget) > 2147483647)) {
        fail({ code: -1, errorCode: "MESSAGE_HISTORY_BUDGET_INVALID", message: "budgetMs must be an integer from 1 to 2147483647." });

      }
      const deadlineAt = receivedAt + (budget === null ? getTimeoutMs("history.request", 2500) : Number(budget));
      const requestId = randomUUID();
      if (url.searchParams.has("cursor") || url.searchParams.has("offset")) {
        fail({ code: -1, errorCode: "MESSAGE_HISTORY_PAGINATION_UNSUPPORTED",
          message: "This endpoint returns a bounded excerpt and does not support cursor or offset pagination.",
          repair: "Use conversation and Unix-second from/to filters for excerpts; verify a complete source before full-history statistics.", retryable: false });

      }
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const afterSequence = url.searchParams.get("afterSequence");
      const beforeSequence = url.searchParams.get("beforeSequence");
      if ([afterSequence, beforeSequence].some(value => value !== null && (!value.trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0))
        || (afterSequence !== null && beforeSequence !== null && Number(afterSequence) > Number(beforeSequence))) {
        fail({ code: -1, message: "afterSequence/beforeSequence must be non-negative safe integers in ascending order." });

      }
      if ([from, to].some(value => value !== null && (!value.trim() || !Number.isFinite(Number(value))))
        || (from !== null && to !== null && Number(from) > Number(to))) {
        fail({ code: -1, errorCode: "MESSAGE_HISTORY_TIME_RANGE_INVALID",
          message: "from/to must be finite Unix seconds, with from <= to when both are supplied.",
          repair: "Convert the requested time window to Unix seconds; omit unused bounds instead of supplying empty or formatted dates.", retryable: false });

      }
        const query: RecentMessageContextQuery = {
          limit: Math.min(200, Math.max(1, Math.floor(numberParam(url.searchParams.get("limit"), 50)))),
          maxChars: Math.min(200_000, Math.max(1, Math.floor(numberParam(url.searchParams.get("maxChars"), 200_000)))),
          adapter: url.searchParams.get("adapter") || undefined, channel: url.searchParams.get("channel") || undefined,
          kind: url.searchParams.get("kind") || undefined, sender: url.searchParams.get("sender") || undefined,
          target: url.searchParams.get("target") || undefined, conversationKey: url.searchParams.get("conversationKey") || undefined,
          query: url.searchParams.get("query")?.trim() || undefined,
          queryMatch: url.searchParams.get("match") === "all" ? "all" : "any", includeArchives: url.searchParams.get("includeArchives") === "1",
          from: numberParam(url.searchParams.get("from"), NaN), to: numberParam(url.searchParams.get("to"), NaN),
          afterSequence: afterSequence === null ? undefined : Number(afterSequence),
          beforeSequence: beforeSequence === null ? undefined : Number(beforeSequence)
        };

          const controller=new AbortController();
      let timer:ReturnType<typeof setTimeout>|undefined;
      let onAbort:()=>void=()=>{};
      const stopped=new Promise<never>((_,reject)=>{
        onAbort=()=>{controller.abort(signal?.reason);reject(signal?.reason??new Error('History request aborted.'));};
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted)onAbort();
        timer=setTimeout(()=>{const error=new ManagerReadWorkerError('SEARCH_DEADLINE_EXCEEDED','timeout');reject(error);controller.abort(error);},Math.max(1,deadlineAt-performance.now()));
      });
      try {
        const read=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return context.queryHistory(roleDir,query,{signal:controller.signal,deadlineAt,requestId});});
        // The native pool retains its task/slot until termination is acknowledged, even after this HTTP budget expires.
        const data=await Promise.race([read,stopped]);
        assertCurrent();
        const entries=Array.isArray(data)?data:data.entries;
        return {requestId,data:{entries,count:entries.length,coverage:{
        roleId, includeArchives: query.includeArchives, adapter: query.adapter || null, channel: query.channel || null,
        recordScope: "saved_role_messages", resultMode: "latest_matches", completenessUnknown: true, paginationSupported: false,
        limit: query.limit, maxChars: query.maxChars,
        from: Number.isFinite(query.from) ? query.from : null, to: Number.isFinite(query.to) ? query.to : null,
        afterSequence: query.afterSequence ?? null, beforeSequence: query.beforeSequence ?? null,
        limitReducesArchiveScan: false,
        ...(!Array.isArray(data) ? data.coverage : {})

        }}};
      } catch(error) {
        signal?.throwIfAborted();
        const worker=error instanceof ManagerReadWorkerError;
        const unavailable=worker&&['busy','timeout','termination_unconfirmed'].includes(error.code);
        const details={code:-1,requestId,message:error instanceof Error?error.message:String(error),
          ...(worker&&error.code==='timeout'?{errorCode:'SEARCH_DEADLINE_EXCEEDED'}:error instanceof Error&&/^(MESSAGE_HISTORY_INDEX_[A-Z_]+|SEARCH_BUSY)/.test(error.message)?{errorCode:error.message.match(/^[A-Z_]+/)![0]}:unavailable?{errorCode:'SEARCH_BUSY'}:{})};
        throw Object.assign(error instanceof Error?error:new Error(String(error)),{statusCode:(error as {statusCode?:number})?.statusCode??(unavailable?503:400),publicDetails:details});
      } finally {clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
    }};
  }};
}
