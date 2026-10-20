import { ALL_DAY_SOURCES, isReviewEvent, matchesReviewType, type AllDayCatalog, type AllDayEvent, type AllDaySettings } from "../shared/allDayRecording.js";
import type { AllDayReadJob } from "./allDayRecordingReadStorage.js";

type Entry = { role: string; day?: string; kind: "catalog" | "recent"; mobiles: string[]; body: AllDayCatalog; loading: boolean; at: number; error?: string; bytes: number; journal: Map<string, AllDayEvent>; dirty: Set<string>; abort: AbortController };
export type AllDayReadReady = { readDay?: string; catalogReady?: boolean; readFailed?: boolean };
const dayOf = (time: number) => new Date(time).toISOString().slice(0,10);
const order = (a: AllDayEvent, b: AllDayEvent) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
const merge = (a: AllDayEvent[], b: AllDayEvent[]) => [...new Map([...a,...b].map(row=>[row.id,row])).values()].filter(isReviewEvent).sort(order);

/** Disposable metadata projections. Original events and media remain owned by the store. */
export class AllDayRecordingReadModel {
  private readonly entries = new Map<string, Entry>();
  private readonly mediaCache = new Map<string, Buffer>();
  private readonly liveAudio = new Map<string, Map<string, AllDayEvent>>();
  private disposed = false;
  constructor(private readonly options: {
    directory(role: string): string;
    mobileRoot: string;
    settings(role: string): Promise<AllDaySettings>;
    run(job: AllDayReadJob, signal?: AbortSignal): Promise<unknown>;
    ready(role: string, event: AllDayReadReady): void;
  }) {}
  private key(role: string, kind: string, day = "") { return JSON.stringify([role,kind,day]); }
  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry)=>sum+entry.bytes,0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 32 && bytes <= 64*1024*1024) break;
      if (entry.loading) continue;
      bytes -= entry.bytes; this.entries.delete(key);
    }
  }
  private async snapshot(role: string, kind: "catalog" | "recent", day?: string): Promise<AllDayCatalog> {
    if(this.disposed) throw new Error("Recording read owner has stopped");
    if (day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)))) throw new Error("Invalid recording day");
    const key = this.key(role,kind,day);
    let entry = this.entries.get(key);
    if (!entry && this.entries.size >= 32) this.trim();
    if (!entry && this.entries.size >= 48) throw new Error("Recording read queue is full; retry later");
    if (!entry || !entry.loading && Date.now()-entry.at > 300_000) {
      const settings = await this.options.settings(role);
      // Recheck after the settings await: concurrent cold queries share one job.
      entry = this.entries.get(key);
      if (!entry || !entry.loading && Date.now()-entry.at > 300_000) {
        entry = { role,kind,day,mobiles:settings.mobileDeviceIds,body:entry?.body ?? {events:[],days:day?[day]:[],incompleteDays:day?[day]:[]},loading:true,at:Date.now(),bytes:entry?.bytes??0,journal:new Map(),dirty:new Set(),abort:new AbortController() };
        this.entries.set(key,entry);
        const current = entry;
        void this.options.run({kind,directory:this.options.directory(role),mobileRoot:this.options.mobileRoot,mobileDeviceIds:settings.mobileDeviceIds,day},current.abort.signal).then(value=>{
          if(this.disposed || this.entries.get(key)!==current) return;
          const body=value as AllDayCatalog;
          current.body={...body,events:merge(body.events,[...current.journal.values()]),days:[...new Set([...body.days,...[...current.journal.values()].map(row=>dayOf(row.startedAt))])].sort(),incompleteDays:[...new Set([...body.incompleteDays,...current.dirty])].sort()};
          if(kind==="recent") current.body.events=current.body.events.slice(-256);
          current.bytes=Buffer.byteLength(JSON.stringify(current.body)); current.error=undefined;
        },error=>{current.error=error instanceof Error?error.message:String(error);}).finally(()=>{
          current.loading=false;current.at=Date.now();current.journal.clear(); this.trim();
          if(!this.disposed && this.entries.get(key)===current) this.options.ready(role,{...(day?{readDay:day}:kind==="catalog"?{catalogReady:true}:{}),readFailed:!!current.error});
        });
      }
    }
    return {...entry.body,loading:entry.loading,readError:entry.error,pendingDays:entry.loading&&day?[day]:[],incompleteDays:entry.error&&day?[...new Set([...entry.body.incompleteDays,day])]:entry.body.incompleteDays};
  }
  catalog(role: string, day?: string) { return this.snapshot(role,"catalog",day); }
  recent(role: string) { return this.snapshot(role,"recent"); }
  invalidate(role: string, day?: string) {
    for(const [key,entry] of this.entries) if(entry.role===role && (day===undefined || entry.day===day || !entry.day)) { entry.abort.abort(); this.entries.delete(key); }
  }
  committed(role: string | null, event: AllDayEvent, bytes?: Buffer, indexComplete = false) {
    if(this.disposed) return;
    if (role && event.kind === "audio") {
      const rows = this.liveAudio.get(role) ?? new Map<string, AllDayEvent>();
      rows.set(event.id, event); this.liveAudio.set(role, rows);
      for (const [id, row] of rows) if (row.endedAt < Date.now() - 600_000) rows.delete(id);
      while (rows.size > 512) rows.delete(rows.keys().next().value!);
      while (this.liveAudio.size > 16) this.liveAudio.delete(this.liveAudio.keys().next().value!);
    }
    const day = dayOf(event.startedAt);
    for(const entry of this.entries.values()) {
      if(role===null ? !entry.mobiles.includes(event.deviceId) : entry.role!==role) continue;
      if(entry.day && entry.day!==day) continue;
      if(entry.loading) {entry.journal.set(event.id,event);if(!indexComplete) entry.dirty.add(day);}
      entry.body.events=merge(entry.body.events,[event]);
      if(!entry.day) entry.body.events=entry.body.events.slice(-256);
      if(!entry.body.days.includes(day)) entry.body.days=[...entry.body.days,day].sort();
      if(!indexComplete && !entry.body.incompleteDays.includes(day)) entry.body.incompleteDays.push(day);
      entry.bytes=Buffer.byteLength(JSON.stringify(entry.body));
    }
    if(role && bytes && event.media) {
      this.mediaCache.set(this.key(role,"media",event.media),bytes);
      while(this.mediaCache.size>4 || [...this.mediaCache.values()].reduce((sum,item)=>sum+item.length,0)>16*1024*1024) this.mediaCache.delete(this.mediaCache.keys().next().value!);
    }
    this.trim();
  }
  async transcripts(role: string, since: number, until: number) {
    const timeline = await this.timeline(role, since, until);
    const events = merge(timeline.events, [...(this.liveAudio.get(role)?.values() ?? [])])
      .filter(row => row.kind === "audio" && ["microphone", "systemAudio"].includes(row.source) && row.startedAt < until && row.endedAt > since);
    return { ...timeline, events };
  }
  async media(role: string, day: string, id: string, extension: string, signal?: AbortSignal): Promise<Buffer> {
    const cached=this.mediaCache.get(this.key(role,"media",`media/${day}/${id}.${extension}`));
    if(cached) return cached;
    const value=await this.options.run({kind:"media",directory:this.options.directory(role),mobileRoot:this.options.mobileRoot,mobileDeviceIds:[],day,id,extension},signal);
    return Buffer.from(value as Uint8Array);
  }
  async timeline(role: string, since: number, until: number) {
    if(!Number.isFinite(since)||!Number.isFinite(until)||since<0||until<=since||until-since>26*3600_000) throw new Error("Select at most one local day");
    const pages:AllDayCatalog[]=[];
    for(let time=Date.parse(dayOf(since));time<=until;time+=86400_000) pages.push(await this.catalog(role,dayOf(time)));
    return {events:merge([],pages.flatMap(page=>page.events)).filter(row=>row.startedAt<until&&row.endedAt>=since),loading:pages.some(page=>page.loading),pendingDays:[...new Set(pages.flatMap(page=>[...(page.pendingDays??[]),...page.incompleteDays]))],readError:pages.find(page=>page.readError)?.readError};
  }
  async page(role: string, direction:"older"|"newer", cursor:{time:number;id:string}, source="all", limit=100, type="all") {
    if(!Number.isFinite(cursor.time)||cursor.time<0||cursor.id.length>512||!["all",...ALL_DAY_SOURCES,"mobile","session","systemAudio"].includes(source)||!["all","asr","image","window","status","device"].includes(type)) throw new Error("Invalid event cursor");
    const overview=await this.catalog(role), cursorDay=dayOf(cursor.time);
    const days=overview.days.filter(day=>direction==="older"?day<=cursorDay:day>=cursorDay).sort(); if(direction==="older") days.reverse();
    const events:AllDayEvent[]=[]; let loading=!!overview.loading; const pendingDays:string[]=[];
    let readError=overview.readError;
    for(const day of days) {
      const page=await this.catalog(role,day);
      if(page.loading||page.incompleteDays.length||page.readError) {loading=true;pendingDays.push(day);readError=page.readError;break;}
      const rows=page.events.filter(row=>matchesReviewType(row,type)&&(source==="all"||row.source===source)&&(direction==="older"?(row.startedAt-cursor.time||row.id.localeCompare(cursor.id))<0:(row.startedAt-cursor.time||row.id.localeCompare(cursor.id))>0)).sort(order);
      if(direction==="older") rows.reverse(); events.push(...rows.slice(0,limit+1-events.length)); if(events.length>limit) break;
    }
    const result=events.slice(0,limit),last=result.at(-1);
    return {events:result.sort(order),hasMore:loading||events.length>limit,loading,pendingDays,readError,cursor:last?{time:last.startedAt,id:last.id}:cursor};
  }
  dispose() {this.disposed=true;for(const entry of this.entries.values()) entry.abort.abort();this.entries.clear();this.mediaCache.clear();this.liveAudio.clear();}
}
