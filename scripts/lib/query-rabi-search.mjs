import { discoverManagerIdentity } from './discover-manager-url.mjs';

/** One discovery and one shared deadline cover the ordinary unified-search request. */
export async function queryRabiSearch({query={},budgetMs=3000,agentType,id,signal,fetch:fetchImpl=fetch,discovery={}}={}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs<1 || budgetMs>2147483647) throw new Error('budgetMs must be an integer from 1 to 2147483647.');
  const deadlineAt=performance.now()+budgetMs,controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new DOMException('Search total deadline exceeded.','TimeoutError')),budgetMs);
  const cancellation=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const remaining=()=>{cancellation.throwIfAborted();const value=Math.floor(deadlineAt-performance.now());if(value<1)throw new DOMException('Search total deadline exceeded.','TimeoutError');return value;};
  const request=(async()=>{
    let identity=await discoverManagerIdentity({...discovery,fetch:fetchImpl,timeoutMs:remaining()});
    for(let attempt=0;attempt<2;attempt++) {
      const params=new URLSearchParams();
      for(const [name,value] of Object.entries(query))if(value!==undefined && value!==null)params.set(name,Array.isArray(value)?value.join(','):String(value));
      const requestBudgetMs = remaining();
      // Leave time for the server's partial response to be encoded, delivered and read.
      const responseReserveMs = Math.min(500, Math.ceil(requestBudgetMs / 5));
      const affordableMs = Math.max(1, requestBudgetMs - responseReserveMs);
      // An explicit server budget is honoured but never exceeds what this call can still afford.
      const requestedMs = Number(query.budgetMs);
      const serverBudgetMs = Number.isSafeInteger(requestedMs) && requestedMs >= 1 ? Math.max(1, Math.min(requestedMs, affordableMs)) : affordableMs;
      params.set('budgetMs', String(serverBudgetMs));
      const headers={accept:'application/json'};
      if(typeof agentType==='string' && agentType.trim() && typeof id==='string' && id.trim()){
        headers['x-rabiroute-agent-type']=agentType.trim();headers['x-rabiroute-session-id']=id.trim();
      }
      const url=new URL('/api/search',identity.managerBaseUrl);url.search=params.toString();
      const response=await fetchImpl(url,{signal:cancellation,redirect:'error',headers}),body=await response.json();
      if(body.data?.applicationGenerationId && (body.data.applicationGenerationId!==identity.applicationGenerationId || body.data.managerInstanceId!==identity.managerInstanceId)) {
        identity=await discoverManagerIdentity({...discovery,fetch:fetchImpl,timeoutMs:remaining()});
        if(attempt===0 && !query.cursor)continue;
        throw Object.assign(new Error('Manager identity changed. Restart the search from its first page.'),{status:409,errorCode:'SEARCH_CURSOR_EXPIRED'});
      }
      if(!response.ok)throw Object.assign(new Error(body.message || 'Unified search failed.'),{status:response.status,errorCode:body.errorCode,body});
      return body;
    }
  })();
  let onAbort;
  const interrupted=new Promise((_,reject)=>{onAbort=()=>reject(cancellation.reason);cancellation.addEventListener('abort',onAbort,{once:true});if(cancellation.aborted)onAbort();});
  try{return await Promise.race([request,interrupted]);}
  finally{clearTimeout(timer);cancellation.removeEventListener('abort',onAbort);}
}
