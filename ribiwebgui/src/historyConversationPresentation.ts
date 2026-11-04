import type { PersonaChatReply } from '@shared/personaChatHistory';
import { personaHistoryTaskKey } from '@shared/personaChatHistory';

export type HistoryConversationItem = { key:string; title:string; preview:string; time:string; subtitle?:string };
export function taskHistoryOutgoing(record:PersonaChatReply,taskKey?:string):boolean {
  return taskKey?record.kind!=='user_delivery'&&(record.sourceTaskKey||personaHistoryTaskKey(record.sessionId,record.sourceTaskOwner))===taskKey:record.kind==='user_delivery';
}
export function taskHistoryCounterparty(record:PersonaChatReply,taskKey?:string):string {
  if(record.kind==='user_delivery')return record.sourceLabel||'用户';
  return taskHistoryOutgoing(record,taskKey)?record.targetSessionTitle||record.targetSessionId||'':record.sessionTitle||record.sessionId;
}

/** Optional date display never removes the conversation or changes its stored timestamp. */
export function endpointHistoryTime(seconds:number):string {
  const date=new Date(seconds*1000);
  return Number.isFinite(date.getTime())?date.toISOString():'';
}

/** Saved pages already follow physical write order; only live QQ uses protocol timestamps. */
export function historyPageForDisplay<T extends {time:number}>(page:readonly T[],bubble:boolean,live:boolean):T[] {
  const entries=page.slice();
  return live?entries.sort((a,b)=>bubble?a.time-b.time:b.time-a.time):bubble?entries:entries.reverse();
}

/** Keep the latest indexed task page authoritative, retaining already loaded older tasks. */
export function mergeHistoryTaskPage<T extends {key:string}>(current:readonly T[],page:readonly T[],append:boolean):T[] {
  if(append)return [...new Map([...current,...page].map(task=>[task.key,task])).values()];
  const keys=new Set(page.map(task=>task.key));
  return [...page,...current.filter(task=>!keys.has(task.key))];
}

/** Refresh a continuous saved window without replacing ledger order with wall-clock order. */
export function mergeSavedHistoryWindow<T>(current:T[],page:T[],atBottom:boolean,key:(row:T)=>string):{entries:T[];newerAvailable:boolean} {
  const known=new Set(current.map(key));
  if(current.length&&page.length&&!page.some(row=>known.has(key(row))))return {entries:current,newerAvailable:true};
  const pageKeys=new Set(page.map(key));
  const merged=[...current.filter(row=>!pageKeys.has(key(row))),...page];
  const entries=atBottom?merged.slice(-200):merged.slice(0,200);
  return {entries,newerAvailable:!atBottom&&(entries.length<merged.length||page.some(row=>!known.has(key(row))))};
}
