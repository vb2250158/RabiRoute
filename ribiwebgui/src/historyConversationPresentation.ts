import type { PersonaChatReply } from '@shared/personaChatHistory';
import { personaHistoryTaskKey } from '@shared/personaChatHistory';

/** A node owns sessions: this Manager, a RabiLink computer or an enrolled Agent instance. */
export type HistoryConversationDevice = { key:string; title:string; path?:string; icon?:string; online?:boolean; status?:string; defaultOpen?:boolean };
export type HistoryConversationItem = { key:string; title:string; preview:string; time:string; subtitle?:string; agentProvider?:string; running?:boolean; device?:HistoryConversationDevice; group?:{key:string;title:string;path:string} };
export type HistoryConversationRow =
  | { kind:'group'; key:string; title:string; path:string; count:number; latest:string }
  | { kind:'more'; key:string; groupKey:string; title:string; remaining:number }
  | { kind:'conversation'; key:string; conversation:HistoryConversationItem };
export type HistoryDeviceRow =
  | { kind:'device'; key:string; device:HistoryConversationDevice; count:number; latest:string; loaded:boolean }
  | { kind:'group'; key:string; deviceKey:string; title:string; path:string; count:number; latest:string }
  | { kind:'more'; key:string; groupKey:string; title:string; remaining:number }
  | { kind:'conversation'; key:string; conversation:HistoryConversationItem };

/** Session times arrive as ISO strings; an unknown or relative value sorts last, never first. */
export function historyTimeValue(value:string|undefined):number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}
function newestFirst<T extends { time:string }>(rows:readonly T[]):T[] {
  return [...rows].sort((left, right) => historyTimeValue(right.time) - historyTimeValue(left.time));
}

/** Two collapse levels: a device hides its projects, and a project hides its sessions. */
export function historyDeviceRows(items:readonly HistoryConversationItem[], devices:readonly HistoryConversationDevice[], collapsed?:ReadonlySet<string>,
  options?:{limit:number;expanded:ReadonlySet<string>}):HistoryDeviceRow[] {
  const byDevice = new Map<string,HistoryConversationItem[]>();
  for (const item of items) {
    const key = item.device?.key || '';
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key)!.push(item);
  }
  // Declared devices keep their order; a device only present in loaded rows follows them.
  const declared = new Set(devices.map(device => device.key));
  const ordered = [...devices, ...[...byDevice].filter(([key]) => !declared.has(key)).map(([key, group]) => group[0]!.device ?? { key, title:key })];
  const rows: HistoryDeviceRow[] = [];
  for (const device of ordered) {
    const sessions = byDevice.get(device.key) ?? [];
    const deviceKey = `device:${device.key}`;
    const latest = sessions.reduce((newest,item) => historyTimeValue(item.time) > historyTimeValue(newest) ? item.time : newest, '');
    rows.push({ kind:'device', key:deviceKey, device, count:sessions.length, latest, loaded: sessions.length > 0 || device.online === false });
    if (collapsed?.has(deviceKey) || !sessions.length) continue;
    const projects = new Map<string,HistoryConversationItem[]>();
    for (const item of sessions) {
      const key = item.group?.key || '';
      if (!projects.has(key)) projects.set(key, []);
      projects.get(key)!.push(item);
    }
    // Projects and their sessions are both newest-first, independent of arrival order.
    const projectRows = [...projects].map(([projectKey, group]) => {
      const sorted = newestFirst(group);
      const latestInProject = sorted[0]?.time ?? '';
      return { projectKey, group: sorted, heading: group[0]!.group, latestInProject };
    }).sort((left, right) => historyTimeValue(right.latestInProject) - historyTimeValue(left.latestInProject));
    for (const { projectKey, group, heading, latestInProject } of projectRows) {
      const rowKey = `project:${device.key}:${projectKey}`;
      rows.push({ kind:'group', key:rowKey, deviceKey, title:heading?.title ?? '', path:heading?.path ?? '', count:group.length, latest:latestInProject });
      if (collapsed?.has(rowKey)) continue;
      const limit = options && !options.expanded.has(rowKey) ? options.limit : group.length;
      for (const item of group.slice(0,limit)) rows.push({ kind:'conversation', key:item.key, conversation:item });
      if (limit < group.length) rows.push({ kind:'more', key:`more:${rowKey}`, groupKey:rowKey, title:heading?.title ?? '', remaining:group.length - limit });
    }
  }
  return rows;
}

/** Loaded projects of one device, used when a caller renders its own device header. */
export function historyProjectRows(items:readonly HistoryConversationItem[], collapsed?:ReadonlySet<string>,
  options?:{limit:number;expanded:ReadonlySet<string>}):HistoryDeviceRow[] {
  return historyDeviceRows(items, [], collapsed, options).filter(row => row.kind !== 'device');
}

/** Loaded projects follow their newest session, preserving source order within each project. */
export function historyConversationRows(items:readonly HistoryConversationItem[], grouped:boolean, collapsed?:ReadonlySet<string>, options?:{limit:number;expanded:ReadonlySet<string>}):HistoryConversationRow[] {
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
    const latest = group.reduce((newest,item)=>item.time>newest?item.time:newest,'');
    const header:HistoryConversationRow = {kind:'group',key,title:heading.title,path:heading.path,count:group.length,latest};
    if (collapsed?.has(key)) return [header];
    const limit = options && !options.expanded.has(key) ? options.limit : group.length;
    const rows:HistoryConversationRow[] = [header,...group.slice(0,limit).map(conversation)];
    if (limit < group.length) rows.push({kind:'more',key:'more:'+heading.key,groupKey:key,title:heading.title,remaining:group.length-limit});
    return rows;
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
