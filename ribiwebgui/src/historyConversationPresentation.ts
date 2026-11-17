import type { PersonaChatReply } from '@shared/personaChatHistory';
import { personaHistoryTaskKey } from '@shared/personaChatHistory';

export type HistoryConversationItem = { key:string; title:string; preview:string; time:string; subtitle?:string; agentProvider?:string; group?:{key:string;title:string;path:string} };
export type HistoryConversationRow =
  | { kind:'group'; key:string; title:string; path:string }
  | { kind:'conversation'; key:string; conversation:HistoryConversationItem };

/** Loaded projects follow their newest session, preserving source order within each project. */
export function historyConversationRows(items:readonly HistoryConversationItem[], grouped:boolean, collapsed?:ReadonlySet<string>):HistoryConversationRow[] {
  const conversation = (item:HistoryConversationItem):HistoryConversationRow => ({kind:'conversation',key:item.key,conversation:item});
  if (!grouped) return items.map(conversation);
  const groups = new Map<string,HistoryConversationItem[]>();
  for (const item of items) {
    const key = item.group?.key || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return [...groups.values()].flatMap(group => {
    const heading = group[0]!.group;
    if (!heading) return group.map(conversation);
    const key = 'project:'+heading.key;
    const header:HistoryConversationRow = {kind:'group',key,title:heading.title,path:heading.path};
    return collapsed?.has(key) ? [header] : [header,...group.map(conversation)];
  });
}

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
export function historyPageForDisplay<T extends {time:number}>(page:readonly T[],_bubble:boolean,live:boolean):T[] {
  const entries=page.slice();
  return live ? entries.sort((a,b)=>a.time-b.time) : entries;
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
