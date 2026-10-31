import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { renameFileWithRetry } from "../shared/filePersistence.js";
import { ALL_DAY_CAPTURE_SOURCES, ALL_DAY_SOURCES, DEFAULT_ALL_DAY_SETTINGS, isReviewEvent, matchesReviewType, normalizeAllDaySettings, type AllDayCatalog, type AllDayEvent, type AllDaySettings, type AllDaySnapshot } from "../shared/allDayRecording.js";
import type { HomeAssistantActivityPort, HomeAssistantActivityRecord, HomeAssistantActivityRequest } from "../shared/homeAssistantActivity.js";
import { MOBILE_RECORDING_MAX_CHUNKS, MOBILE_RECORDING_TEXT_MAX_CODE_UNITS, MOBILE_RECORDING_EVENT_ID_PATTERN, MOBILE_RECORDING_TRANSCRIPTION_STATES, RESOURCE_HASH_PATTERN } from "./resourceCacheProtocol.js";

export type RecordingAuthorization = () => void;
/** Check before dispatch and after settlement, including failed operations. */
export async function recordingOperation<T>(authorize: RecordingAuthorization | undefined, operation: () => Promise<T>): Promise<T> {
  authorize?.();
  try { const result = await operation(); authorize?.(); return result; }
  catch (error) { authorize?.(); throw error; }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const mobileEventPattern = new RegExp(MOBILE_RECORDING_EVENT_ID_PATTERN), mobileChunkPattern = new RegExp(RESOURCE_HASH_PATTERN);
const activityDayStart = (time: number) => new Date(time).setHours(0, 0, 0, 0);
export const recordingDay = (time: number) => new Date(time).toISOString().slice(0, 10);
export async function atomicRecordingJson(file: string, value: unknown, authorize?: RecordingAuthorization): Promise<void> {
  const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
    group: "all-day-recording", event: "recording_file_write", owner: "all-day-recording",
    action: "write", target: { type: "recording-file", id: hash(file) },
    dataSource: { kind: "file", id: hash(file) }, outcome
  });
  authorize?.();
  audit("started");
  try {
    await recordingOperation(authorize, () => fs.mkdir(path.dirname(file), { recursive: true }));
    const temporary = `${file}.${randomUUID()}.partial`;
    authorize?.();
    const handle = await fs.open(temporary, "wx");
    try {
      try {
        await recordingOperation(authorize, () => handle.writeFile(JSON.stringify(value)));
        await recordingOperation(authorize, () => handle.sync());
      } finally { await handle.close(); }
      await recordingOperation(authorize, () => renameFileWithRetry(temporary, file, {
        rename: (source, destination) => recordingOperation(authorize, () => fs.rename(source, destination))
      }));
    } finally { await fs.rm(temporary, { force: true }); }
    audit("committed");
  } catch (error) {
    audit("failed");
    throw error;
  }
}
async function jsonOr<T>(file: string, fallback: T, authorize?: RecordingAuthorization): Promise<T> {
  try { return JSON.parse(await recordingOperation(authorize, () => fs.readFile(file, "utf8"))) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
const dayReads = new Map<string, { expires: number; rows: Promise<AllDayEvent[]> }>();
type DayIndex = { schemaVersion: 2; events: AllDayEvent[] };
// Day bodies can take many SMB round trips. Share reads and retain only bounded,
// derived metadata; the writer invalidates before replacing an index.
const indexReads = new Map<string, { expires: number; bytes: number; value: Promise<DayIndex | null> }>();
function invalidateIndex(directory: string, day: string) { indexReads.delete(dayIndexPath(directory, day)); }
async function indexedRows(directory: string, day: string): Promise<DayIndex | null> {
  const file = dayIndexPath(directory, day), cached = indexReads.get(file);
  if (cached && cached.expires > Date.now()) return cached.value;
  const entry = { expires: Infinity, bytes: 0, value: Promise.resolve<DayIndex | null>(null) };
  entry.value = (async () => {
    try {
      const bytes = await fs.readFile(file, "utf8");
      const value = JSON.parse(bytes) as DayIndex;
      entry.bytes = Buffer.byteLength(bytes);
      return value?.schemaVersion === 2 && Array.isArray(value.events) && value.events.every(row =>
        row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  })();
  indexReads.delete(file); indexReads.set(file, entry);
  try {
    const value = await entry.value;
    entry.expires = Date.now() + 30_000;
    if (!value && indexReads.get(file) === entry) indexReads.delete(file);
    while (indexReads.size > 32 || [...indexReads.values()].reduce((total, item) => total + item.bytes, 0) > 64 * 1024 * 1024) {
      indexReads.delete(indexReads.keys().next().value!);
    }
    return value;
  } catch (error) { if (indexReads.get(file) === entry) indexReads.delete(file); throw error; }
}
const dayWrites = new Map<string, Promise<unknown>>();
const repairDeltas = new Map<string, Map<string, AllDayEvent>>();
const recentReads = new Map<string, Promise<AllDayEvent[]>>();
const recentPath = (directory: string) => path.join(path.dirname(directory), "recent-preview.json");
async function recentRows(directory: string, authorize?: RecordingAuthorization): Promise<AllDayEvent[]> {
  authorize?.();
  if (authorize) return recordingOperation(authorize, () => readRecentRows(directory, authorize));
  let pending = recentReads.get(directory);
  if (!pending) {
    pending = readRecentRows(directory); recentReads.set(directory,pending);
    while(recentReads.size>32) recentReads.delete(recentReads.keys().next().value!);
  }
  try { return await pending; }
  catch(error) {if(recentReads.get(directory)===pending) recentReads.delete(directory); throw error;}
}
async function readRecentRows(directory: string, authorize?: RecordingAuthorization): Promise<AllDayEvent[]> {
  try {
    const value = await jsonOr<{ events: AllDayEvent[] }>(recentPath(directory), { events: [] }, authorize);
    return Array.isArray(value.events) ? value.events.filter(row => row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)).slice(-128) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}
async function updateRecent(directory: string, rows: AllDayEvent[], authorize?: RecordingAuthorization): Promise<void> {
  await withDay(recentPath(directory), async () => {
    authorize?.();
    const events = [...new Map([...(await recentRows(directory, authorize)), ...rows].map(row => [row.id, row])).values()]
      .filter(isReviewEvent).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-128);
    await atomicRecordingJson(recentPath(directory), { events }, authorize);
    recentReads.set(directory,Promise.resolve(events));
  });
}
const dayIndexPath = (directory: string, day: string) => path.join(path.dirname(directory), "events-index", `${day}.json`);
const dayDirtyPath = (directory: string, day: string) => path.join(path.dirname(directory), "events-index", `${day}.dirty.json`);
async function withDay<T>(scope: string, action: () => Promise<T>): Promise<T> {
  const pending = (dayWrites.get(scope) ?? Promise.resolve()).catch(() => undefined).then(action);
  dayWrites.set(scope,pending);
  try { return await pending; } finally { if(dayWrites.get(scope) === pending) dayWrites.delete(scope); }
}
async function validDayIndex(directory: string, day: string, authorize?: RecordingAuthorization): Promise<DayIndex | null> {
  try { await recordingOperation(authorize, () => fs.access(dayDirtyPath(directory,day))); return null; }
  catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    return await recordingOperation(authorize, () => indexedRows(directory,day));
  } catch { authorize?.(); return null; } // A damaged derived index can be rebuilt from originals.
}
async function writeIndexedEvent(directory: string, day: string, key: string, event: AllDayEvent, authorize?: RecordingAuthorization): Promise<boolean> {
  const scope = path.join(directory,day);
  return withDay(scope,async () => {
    const index = await validDayIndex(directory,day,authorize);
    // The durable marker survives a crash between the original and derived writes.
    await atomicRecordingJson(dayDirtyPath(directory,day),{eventId:event.id},authorize);
    await atomicRecordingJson(path.join(scope,`${key}.json`),event,authorize);
    repairDeltas.get(scope)?.set(event.id,event);
    await updateRecent(directory, [event],authorize);
    if(dayReads.get(scope)?.expires!==Infinity) dayReads.delete(scope);
    // An absent index is rebuilt by the next query, never by the capture loop.
    if(index) {
      const events = index.events.filter(row => row.id !== event.id); events.push(event);
      const next: DayIndex = { schemaVersion: 2, events };
      invalidateIndex(directory,day);
      await atomicRecordingJson(dayIndexPath(directory,day),next,authorize);
      indexReads.set(dayIndexPath(directory,day),{expires:Date.now()+30_000,bytes:Buffer.byteLength(JSON.stringify(next)),value:Promise.resolve(next)});
      await recordingOperation(authorize, () => fs.rm(dayDirtyPath(directory,day)));
    }
    return !!index;
  });
}
async function readDay(directory: string, day: string, authorize?: RecordingAuthorization, scan = scanDay): Promise<AllDayEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid recording day");
  const key = path.join(directory, day);
  authorize?.();
  const cached = authorize ? undefined : dayReads.get(key);
  if (cached && cached.expires > Date.now()) return cached.rows;
  const entry = { expires: Infinity, rows: (async () => {
    const delta = new Map<string,AllDayEvent>();
    const index = await withDay(key,async()=>{
      const value=await validDayIndex(directory,day,authorize);
      if(!value) repairDeltas.set(key,delta);
      return value;
    });
    if(index) return index.events;
    try {
      // Scanning originals must not hold the capture owner's write queue.
      const scanned = await recordingOperation(authorize, () => scan(directory,day,authorize));
      return await withDay(key,async()=>{
        const rows=[...new Map([...scanned,...delta.values()].map(row=>[row.id,row])).values()];
        invalidateIndex(directory,day);
        await atomicRecordingJson(dayIndexPath(directory,day),{schemaVersion:2,events:rows},authorize);
        await updateRecent(directory,rows,authorize);
        await recordingOperation(authorize, () => fs.rm(dayDirtyPath(directory,day),{force:true}));
        return rows;
      });
    } finally {if(repairDeltas.get(key)===delta) repairDeltas.delete(key);}
  })() };
  if (!authorize) { dayReads.delete(key); dayReads.set(key,entry); }
  while(dayReads.size > 8) dayReads.delete(dayReads.keys().next().value!);
  try {
    const rows = await recordingOperation(authorize, () => entry.rows);
    entry.expires = Date.now() + 5000;
    if(rows.length > 20000 && dayReads.get(key) === entry) dayReads.delete(key);
    return rows;
  } catch(error) {
    if(dayReads.get(key) === entry) dayReads.delete(key);
    throw error;
  }
}
async function scanDay(directory: string, day: string, authorize?: RecordingAuthorization): Promise<AllDayEvent[]> {
  let names: string[];
  try { names = await recordingOperation(authorize, () => fs.readdir(path.join(directory, day))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events: AllDayEvent[] = [];
  // Bounded parallel batches avoid one network round-trip per event in series.
  const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  for(let offset = 0; offset < files.length; offset += 16) {
    const batch = await Promise.all(files.slice(offset,offset+16).map(name => recordingOperation(authorize, () => fs.readFile(path.join(directory,day,name),"utf8"))));
    for(const bytes of batch) events.push(JSON.parse(bytes) as AllDayEvent);
  }
  return events;
}
export class AllDayRecordingStore {
  private intent?: Promise<string | null>;
  private readonly settingReads = new Map<string, Promise<AllDaySettings>>();
  private deviceRead?: Promise<{ id: string; lastReceivedAt: number }[]>;
  private repairQueue: Promise<unknown> = Promise.resolve();
  private readonly repairs = new Map<string, Promise<void>>();
  constructor(readonly roleDirectory: (roleId: string) => string, readonly hostId: string, readonly mobileRoot: string, private readonly readOptions: {
    scan?(directory: string, day: string): Promise<AllDayEvent[]>;
    committed?(role: string | null, event: AllDayEvent, bytes: Buffer | undefined, indexComplete: boolean): void;
  } = {}) {}
  async enabledRole(authorize?: RecordingAuthorization): Promise<string | null> {
    authorize?.();
    const pending = this.intent ??= (async () => {
      const value = await jsonOr<{roleId: string | null}>(path.join(this.mobileRoot, "capture-intent.json"), {roleId:null});
      if (value.roleId !== null && (typeof value.roleId !== "string" || !value.roleId || value.roleId.length > 128 || /[\\/\x00-\x1f]/.test(value.roleId) || [".",".."].includes(value.roleId))) throw new Error("Invalid saved recording persona");
      return value.roleId;
    })();
    try { return await recordingOperation(authorize, () => pending); } catch (error) { if(this.intent === pending) this.intent = undefined; throw error; }
  }
  async enableRole(roleId: string | null, authorize?: RecordingAuthorization) {
    await atomicRecordingJson(path.join(this.mobileRoot, "capture-intent.json"), {roleId},authorize);
    this.intent = Promise.resolve(roleId);
  }
  directory(roleId: string) { return path.join(this.roleDirectory(roleId), "all-day-recording", hash(this.hostId)); }
  async settings(roleId: string, authorize?: RecordingAuthorization): Promise<AllDaySettings> {
    authorize?.();
    const originalDirectory = this.directory(roleId);
    let pending = this.settingReads.get(originalDirectory);
    if (!pending) {
      pending = jsonOr(path.join(originalDirectory, "settings.json"), DEFAULT_ALL_DAY_SETTINGS).then(normalizeAllDaySettings);
      this.settingReads.set(originalDirectory,pending);
      while(this.settingReads.size > 16) this.settingReads.delete(this.settingReads.keys().next().value!);
    }
    try { return structuredClone(await recordingOperation(authorize, () => pending)); }
    catch(error) { if(this.settingReads.get(originalDirectory) === pending) this.settingReads.delete(originalDirectory); throw error; }
  }
  async configure(roleId: string, input: unknown, authorize?: RecordingAuthorization) {
    const settings = normalizeAllDaySettings(input);
    const originalDirectory = this.directory(roleId);
    await atomicRecordingJson(path.join(originalDirectory, "settings.json"), settings, authorize);
    this.settingReads.set(originalDirectory,Promise.resolve(structuredClone(settings)));
    return settings;
  }
  /** Explicit derived-index work returns a task immediately, never an HTTP scan wait. */
  repairIndex(roleId: string, day: string, completed: (error?: unknown) => void = () => {}): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) throw new Error("Invalid recording day");
    const originalDirectory = this.directory(roleId), key = `${originalDirectory}/${day}`, existing = this.repairs.get(key);
    if (existing) return existing;
    if(this.repairs.size >= 32) throw new Error("History reconstruction queue is full; retry later");
    const task = this.repairQueue.catch(() => undefined).then(async () => {
      if (this.directory(roleId) !== originalDirectory) throw new Error("Recording role directory changed before reconstruction");
      const settings = await this.settings(roleId);
      if (this.directory(roleId) !== originalDirectory) throw new Error("Recording role directory changed before reconstruction");
      await readDay(path.join(originalDirectory, "events"),day,undefined,this.readOptions.scan);
      if(settings.mobileDeviceIds.length) await readDay(path.join(this.mobileRoot,"events"),day,undefined,this.readOptions.scan);
    });
    this.repairs.set(key,task); this.repairQueue = task;
    void task.then(() => { this.repairs.delete(key); completed(); }, error => { this.repairs.delete(key); completed(error); });
    return task;
  }
  /** Join accepted derived-index work before releasing the native recording owner. */
  async waitForRepairs(): Promise<void> { await Promise.allSettled(this.repairs.values()); }
  async hasEvent(roleId: string, event: AllDayEvent): Promise<boolean> {
    try { await fs.access(path.join(this.directory(roleId), "events", recordingDay(event.startedAt), `${hash(event.id)}.json`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async append(roleId: string, event: AllDayEvent, image?: Buffer, authorize?: RecordingAuthorization): Promise<void> {
    authorize?.();
    const root = this.directory(roleId);
    const key = hash(event.id);
    if (image) {
      const audio = event.kind === "audio";
      if (image.length > 16 * 1024 * 1024 || (audio ? image.subarray(0, 4).toString() !== "RIFF" : image[0] !== 0xff || image[1] !== 0xd8)) throw new Error("Invalid recording media");
      const media = path.join("media", recordingDay(event.startedAt), `${key}.${audio ? "wav" : "jpg"}`);
      const destination = path.join(root, media);
      await recordingOperation(authorize, () => fs.mkdir(path.dirname(destination), { recursive: true }));
      const temporary = `${destination}.${randomUUID()}.partial`;
      authorize?.();
      const handle = await fs.open(temporary, "wx");
      try {
        try { await recordingOperation(authorize, () => handle.writeFile(image)); await recordingOperation(authorize, () => handle.sync()); }
        finally { await handle.close(); }
        await recordingOperation(authorize, () => renameFileWithRetry(temporary, destination, {
          rename: (source, target) => recordingOperation(authorize, () => fs.rename(source, target))
        }));
      } finally { await fs.rm(temporary, { force: true }); }
      event = { ...event, media: media.split(path.sep).join("/") };
    }
    const complete = await writeIndexedEvent(path.join(root,"events"),recordingDay(event.startedAt),key,event, authorize);
    this.readOptions.committed?.(roleId,event,image,complete);
  }
  async timeline(roleId: string, since: number, until: number, authorize?: RecordingAuthorization): Promise<AllDayEvent[]> {
    if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since || until - since > 26 * 3600_000) throw new Error("Select at most one local day");
    const settings = await this.settings(roleId, authorize);
    const reads: Promise<AllDayEvent[]>[] = [];
    for (let time = Date.parse(recordingDay(since)); time <= until; time += 86400_000) {
      reads.push(readDay(path.join(this.directory(roleId), "events"), recordingDay(time), authorize));
      if (settings.mobileDeviceIds.length) {
        reads.push(readDay(path.join(this.mobileRoot, "events"), recordingDay(time), authorize).then(rows => rows.filter(event => settings.mobileDeviceIds.includes(event.deviceId))));
      }
    }
    const result = (await Promise.all(reads)).flat();
    return result.filter(event => isReviewEvent(event) && event.startedAt < until && event.endedAt >= since).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
  async recent(roleId: string, authorize?: RecordingAuthorization): Promise<AllDayEvent[]> {
    const [settings, computer] = await Promise.all([
      this.settings(roleId, authorize), recentRows(path.join(this.directory(roleId), "events"), authorize)
    ]);
    const mobile = settings.mobileDeviceIds.length
      ? (await recentRows(path.join(this.mobileRoot, "events"), authorize)).filter(row => settings.mobileDeviceIds.includes(row.deviceId)) : [];
    return [...computer, ...mobile].filter(isReviewEvent).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
  async catalog(roleId: string, day?: string): Promise<AllDayCatalog> {
    if (day !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)))) throw new Error("Invalid recording day");
    const settings = await this.settings(roleId);
    const directories = [path.join(this.directory(roleId), "events"), ...(settings.mobileDeviceIds.length ? [path.join(this.mobileRoot, "events")] : [])];
    const days = new Set<string>(), incompleteDays = new Set<string>();
    const rows: AllDayEvent[] = [];
    if (day !== undefined) {
      days.add(day);
      await Promise.all(directories.map(async directory => {
        let index: DayIndex | null = null;
        let damaged = false;
        const dirty = await fs.access(dayDirtyPath(directory, day)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        try { index = await indexedRows(directory, day); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; damaged = true; }
        if (!index || index.schemaVersion !== 2 || !Array.isArray(index.events) || !index.events.every(row => row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt))) {
          // An absent mobile shard with no originals is an empty contribution.
          if (index || damaged || dirty) incompleteDays.add(day);
          try { await fs.access(path.join(directory, day)); incompleteDays.add(day); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          return;
        }
        if (dirty) incompleteDays.add(day);
        for (const row of index.events) if (isReviewEvent(row) && (row.source !== "mobile" || settings.mobileDeviceIds.includes(row.deviceId))) rows.push(row);
      }));
    } else {
      const names = async (directory: string): Promise<string[]> => {
        try { return await fs.readdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      };
      for (const directory of directories) {
        const [originals, indexes] = await Promise.all([names(directory), names(path.join(path.dirname(directory), "events-index"))]);
        const indexNames = new Set(indexes);
        const dates = new Set([...originals.filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)), ...indexes.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, 10))]);
        for (const date of dates) {
          days.add(date);
          if (!indexNames.has(`${date}.json`) || indexNames.has(`${date}.dirty.json`)) incompleteDays.add(date);
        }
      }
    }
    // Opening the catalog never scans originals or takes the capture write lock.
    // Day responses stay independent so large history can render progressively.
    const recent = day === undefined ? await this.recent(roleId) : [];
    const events = [...new Map([...rows, ...recent].map(row => [row.id, row])).values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    return { events, days: [...days].sort(), incompleteDays: [...incompleteDays].sort() };
  }
  async page(roleId: string, direction: "older" | "newer", cursor: { time: number; id: string }, source = "all", limit = 100, eventType = "all", authorize?: RecordingAuthorization) {
    if (!["all", "asr", "image", "window", "status", "device"].includes(eventType)) throw new Error("Invalid event type");
    if (!Number.isFinite(cursor.time) || cursor.time < 0 || cursor.id.length > 512 || !["all", ...ALL_DAY_SOURCES, "mobile", "session", "systemAudio"].includes(source)) throw new Error("Invalid event cursor");
    const settings = await this.settings(roleId, authorize);
    const directories = [path.join(this.directory(roleId), "events"), ...(settings.mobileDeviceIds.length ? [path.join(this.mobileRoot, "events")] : [])];
    const dates = new Set<string>();
    for (const directory of directories) {
      try { for (const day of await recordingOperation(authorize, () => fs.readdir(directory))) if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dates.add(day); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const cursorDay = recordingDay(cursor.time);
    const days = [...dates].filter(day => direction === "older" ? day <= cursorDay : day >= cursorDay).sort();
    if (direction === "older") days.reverse();
    const rows: AllDayEvent[] = [];
    const compare = (a: AllDayEvent, b: AllDayEvent) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
    for (const day of days) {
      const records = (await Promise.all(directories.map(directory => readDay(directory, day, authorize)))).flat();
      const matches = records.filter(row => {
        if (!matchesReviewType(row, eventType)) return false;
        if (row.source === "mobile" && !settings.mobileDeviceIds.includes(row.deviceId)) return false;
        if (source !== "all" && row.source !== source) return false;
        const order = row.startedAt - cursor.time || row.id.localeCompare(cursor.id);
        return direction === "older" ? order < 0 : order > 0;
      }).sort(compare);
      if (direction === "older") matches.reverse();
      rows.push(...matches.slice(0, limit + 1 - rows.length));
      if (rows.length > limit) break;
    }
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);
    const last = events.at(-1);
    return { events: events.sort(compare), hasMore, cursor: last ? { time: last.startedAt, id: last.id } : cursor };
  }
  async mobileDevices(authorize?: RecordingAuthorization): Promise<{ id: string; lastReceivedAt: number }[]> {
    authorize?.();
    const pending = this.deviceRead ??= jsonOr<{ id: string; lastReceivedAt: number }[]>(path.join(this.mobileRoot, "devices.json"), []);
    try { return structuredClone(await recordingOperation(authorize, () => pending)); }
    catch (error) { if (this.deviceRead === pending) this.deviceRead = undefined; throw error; }
  }
  private mobileWrite: Promise<unknown> = Promise.resolve();
  receiveMobile(owner: string, input: unknown, authorize?: RecordingAuthorization): Promise<void> {
    const operation = this.mobileWrite.catch(() => undefined).then(async () => {
      authorize?.();
      if (!owner || !input || typeof input !== "object") throw new Error("Invalid mobile event");
      const row = input as Record<string, unknown>;
      const startedAt = Number(row.startedAt), endedAt = Number(row.endedAt);
      if (typeof row.id !== "string" || !mobileEventPattern.test(row.id) || !Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(endedAt) || endedAt < startedAt || endedAt > Date.now() + 86400_000 || typeof row.text !== "string" || row.text.length > MOBILE_RECORDING_TEXT_MAX_CODE_UNITS) throw new Error("Invalid mobile event fields");
      const deviceId = hash(owner);
      if (!Array.isArray(row.chunks) || row.chunks.length < 1 || row.chunks.length > MOBILE_RECORDING_MAX_CHUNKS || row.chunks.some(id => typeof id !== "string" || !mobileChunkPattern.test(id))) throw new Error("Invalid recording media chunks");
      const transcriptionState = row.transcriptionState === undefined ? "ready" : row.transcriptionState;
      if (!(MOBILE_RECORDING_TRANSCRIPTION_STATES as readonly string[]).includes(String(transcriptionState))) throw new Error("Invalid transcription state");
      const event: AllDayEvent = { id: `mobile:${deviceId}:${row.id}`, startedAt, endedAt, source: "mobile", deviceId, kind: "audio", text: row.text, state: "saved", transcriptionState: transcriptionState as AllDayEvent["transcriptionState"], mobileMedia: { owner, chunks: row.chunks as string[] } };
      const complete = await writeIndexedEvent(path.join(this.mobileRoot,"events"),recordingDay(startedAt),hash(event.id),event,authorize);
      authorize?.();
      this.readOptions.committed?.(null,event,undefined,complete);
      const devices = await this.mobileDevices();
      authorize?.();
      const updated = [...devices.filter(device => device.id !== deviceId), { id: deviceId, lastReceivedAt: Date.now() }];
      await atomicRecordingJson(path.join(this.mobileRoot, "devices.json"), updated,authorize);
      this.deviceRead = Promise.resolve(updated);
    });
    this.mobileWrite = operation;
    return operation;
  }
  async media(roleId: string, day: string, id: string, extension = "jpg", authorize?: RecordingAuthorization): Promise<Buffer> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-f0-9]{64}$/.test(id) || !["jpg", "wav"].includes(extension)) throw new Error("Invalid media reference");
    return recordingOperation(authorize, () => fs.readFile(path.join(this.directory(roleId), "media", day, `${id}.${extension}`)));
  }
}

export type RecordingSample = { source: "screen" | "window" | "camera"; text?: string; jpeg?: string; error?: string };
export type AllDayCaptureDependencies = {
  prepare?(): Promise<void>;
  capture(settings: AllDaySettings, sessionId: string, authorize?: RecordingAuthorization): Promise<RecordingSample[]>;
  startMicrophone(sessionId: string, authorize?: RecordingAuthorization): Promise<string | void>;
  stopMicrophone(sessionId: string, authorize?: RecordingAuthorization): Promise<void>;
  audio(since: number, until: number, sessionId: string, authorize?: RecordingAuthorization): Promise<AllDayEvent[]>;
  audioRecord?(id: string, sessionId: string): Promise<AllDayEvent | null>;
  watchAudio?(changed: (id?: string) => void, failed: (error: string) => void): () => void;
  audioFile(recordId: string, authorize?: RecordingAuthorization): Promise<Buffer>;
  stopCapture?(sessionId: string, authorize?: RecordingAuthorization): Promise<void>;
  renewCapture?(sessionId: string): Promise<void>;
  renewMicrophone?(sessionId: string): Promise<void>;
  changed(roleId: string): void;
};
type RecordingSession = { audioLeaseTimer?: NodeJS.Timeout; audioLeasePending?: Promise<void>; releaseAudio?: () => void; audioPending?: Promise<void>; audioWake?: NodeJS.Timeout; audioChanges?: Set<string>; audioCatchup?: boolean; audioRecords?: Map<string, AllDayEvent>; cameraActive?: boolean; cameraLeaseTimer?: NodeJS.Timeout; preparing?: boolean; prepared?: boolean; homeAssistantSince?: number; audioSessionId?: string; roleId: string; id: string; settings: AllDaySettings; startedAt: number; lastSampleAt: number | null; audioSince: number; error: string; timer?: NodeJS.Timeout; pending?: Promise<void>; stopping: boolean; windowTitle: string | null };

/** One host capture owner; explicit enable intent survives orderly shutdown. */
export class AllDayRecordingService {
  private session: RecordingSession | null = null;
  private transition: Promise<unknown> = Promise.resolve();
  private sourceErrors: Partial<Record<typeof ALL_DAY_SOURCES[number], string>> = {};
  constructor(readonly store: AllDayRecordingStore, private readonly dependencies: AllDayCaptureDependencies) {}
  private readonly activityListeners = new Set<(request: HomeAssistantActivityRequest | null) => void>();
  readonly homeAssistantActivity: HomeAssistantActivityPort = {
    subscribe: listener => { this.activityListeners.add(listener); listener(this.activityRequest()); return () => { this.activityListeners.delete(listener); }; },
    receive: (roleId, record) => this.receiveHomeAssistant(roleId, record),
    report: (roleId, error) => {
      const session = this.session;
      if (!session || session.roleId !== roleId || !session.settings.sources.homeAssistant) return;
      if (error) this.sourceErrors.homeAssistant = error; else delete this.sourceErrors.homeAssistant;
      session.error = Object.entries(this.sourceErrors).map(([source, message]) => `${source}: ${message}`).join("; ");
      this.dependencies.changed(roleId);
    }
  };
  private activityRequest(): HomeAssistantActivityRequest | null {
    const session = this.session;
    return session && !session.stopping && session.settings.sources.homeAssistant
      ? { roleId: session.roleId, startedAt: session.homeAssistantSince ?? session.startedAt } : null;
  }
  private notifyActivity(): void { for (const listener of this.activityListeners) listener(this.activityRequest()); }
  async restore() { const roleId = await this.store.enabledRole(); if (roleId) await this.start(roleId); }
  private serialize<T>(action: () => Promise<T>, authorize?: RecordingAuthorization): Promise<T> {
    const result = this.transition.catch(() => undefined).then(() => recordingOperation(authorize, action));
    this.transition = result;
    return result;
  }
  async snapshot(roleId: string, authorize?: RecordingAuthorization): Promise<AllDaySnapshot> {
    const session = this.session?.roleId === roleId ? this.session : null;
    return { settings: await this.store.settings(roleId, authorize), enabled: await this.store.enabledRole(authorize) === roleId, sourceErrors:session ? {...this.sourceErrors} : {}, running: !!session && !session.stopping, preparing: !!session?.preparing, activeRoleId: this.session?.roleId ?? null, startedAt: session?.startedAt ?? null, lastSampleAt: session?.lastSampleAt ?? null, error: session?.error ?? "" };
  }
  configure(roleId: string, input: unknown, authorize?: RecordingAuthorization) {
    return this.serialize(async () => {
      const settings = normalizeAllDaySettings(input);
      const session = this.session?.roleId === roleId ? this.session : null;
      if (session) {
        clearTimeout(session.timer); clearTimeout(session.cameraLeaseTimer); clearTimeout(session.audioLeaseTimer); clearTimeout(session.audioWake); session.releaseAudio?.(); session.releaseAudio = undefined; session.stopping = true;
        try {
          await recordingOperation(authorize, async () => { await Promise.all([session.pending, session.audioPending, session.audioLeasePending]); });
          if (session.cameraActive && (!settings.sources.camera || settings.cameraIndex !== session.settings.cameraIndex)) {
            await recordingOperation(authorize, async () => { await this.dependencies.stopCapture?.(session.id,authorize); });
            session.cameraActive = false;
          }
          if (session.audioSessionId && !settings.sources.microphone) {
            await recordingOperation(authorize, () => this.dependencies.stopMicrophone(session.id,authorize));
            await this.collectAudio(session,authorize);
            session.audioSessionId = undefined;
          }
          await this.store.configure(roleId, settings, authorize);
          if (!session.settings.sources.microphone && settings.sources.microphone) session.audioSince = Date.now();
          if (!session.settings.sources.homeAssistant && settings.sources.homeAssistant) session.homeAssistantSince = activityDayStart(Date.now());
          session.settings = settings; session.windowTitle = null;
          if (!settings.sources.homeAssistant) delete this.sourceErrors.homeAssistant;
        } finally { session.stopping = false; session.cameraLeaseTimer = undefined; this.schedule(session, 0); }
      } else await this.store.configure(roleId, settings, authorize);
      authorize?.();
      this.notifyActivity();
      this.dependencies.changed(roleId);
      return this.snapshot(roleId, authorize);
    }, authorize);
  }
  start(roleId: string, authorize?: RecordingAuthorization) {
    return this.serialize(async () => {
      if (this.session) {
        if (this.session.roleId !== roleId) throw new Error("Another persona is recording on this computer");
        return this.snapshot(roleId, authorize);
      }
      const settings = await this.store.settings(roleId, authorize);
      if (!ALL_DAY_SOURCES.some(source => settings.sources[source]) && await this.store.enabledRole(authorize) !== roleId) throw new Error("Select at least one recording source");
      const now = Date.now();
      this.sourceErrors = settings.sources.homeAssistant ? { homeAssistant: "Home Assistant 活动连接尚未就绪" } : {};
      const session: RecordingSession = { homeAssistantSince: settings.sources.homeAssistant ? activityDayStart(now) : undefined, roleId, id: randomUUID(), settings, startedAt: now, audioSince: now, lastSampleAt: null, error: "", stopping: false, windowTitle: null };
      await this.store.enableRole(roleId, authorize);
      this.session = session;
      let snapshot: AllDaySnapshot;
      try {
        await this.statusEvent(session, "Recording started", authorize);
        snapshot = await this.snapshot(roleId, authorize);
        authorize?.();
      } catch (error) { this.session = null; throw error; }
      authorize?.();
      // Once published, ongoing capture belongs to the Host, not this request lease.
      this.schedule(session, 0);
      this.notifyActivity();
      this.dependencies.changed(roleId);
      return snapshot;
    }, authorize);
  }
  stop(roleId: string, preserveIntent = false, authorize?: RecordingAuthorization) {
    return this.serialize(async () => {
      if (!preserveIntent && await this.store.enabledRole(authorize) === roleId) await this.store.enableRole(null, authorize);
      const session = this.session;
      if (!session || session.roleId !== roleId) return this.snapshot(roleId, authorize);
      session.stopping = true;
      this.notifyActivity();
      clearTimeout(session.timer); clearTimeout(session.cameraLeaseTimer); clearTimeout(session.audioLeaseTimer); clearTimeout(session.audioWake); session.releaseAudio?.(); session.releaseAudio = undefined;
      let stopped = false;
      try {
        await recordingOperation(authorize, async () => { await Promise.all([session.pending, session.audioPending, session.audioLeasePending]); });
        authorize?.();
        // Once stop is dispatched, never resurrect capture on a failed/revoked reply.
        stopped = true;
        if (session.audioSessionId) await recordingOperation(authorize, () => this.dependencies.stopMicrophone(session.id, authorize));
        await this.collectAudio(session, authorize);
        await this.statusEvent(session, "Recording paused", authorize);
      } finally {
        if (stopped) {
          try { if (session.cameraActive) await this.dependencies.stopCapture?.(session.id); }
          finally { this.session = null; this.dependencies.changed(roleId); }
        }
        else { session.stopping = false; this.schedule(session, 0); }
      }
      return this.snapshot(roleId, authorize);
    }, authorize);
  }
  async dispose() { if (this.session) await this.stop(this.session.roleId, true); }
  /** Persist the Activity stream under the active recording persona, independent of Agent routing. */
  receiveHomeAssistant(roleId: string, input: HomeAssistantActivityRecord): Promise<boolean> {
    const enrolled = this.session;
    return this.serialize(async () => {
      const session = this.session;
      if (!session || session !== enrolled || session.roleId !== roleId || session.stopping || !session.settings.sources.homeAssistant) return false;
      try {
        const time = input.occurredAt;
        if (!Number.isFinite(time) || !input.id || typeof input.text !== "string" || !input.name) throw new Error("Invalid Home Assistant activity");
        if (time < (session.homeAssistantSince ?? session.startedAt) || time > Date.now() + 60_000) return false;
        const event: AllDayEvent = {
          id: `homeAssistant:${input.id}`, startedAt: time, endedAt: time,
          source: "homeAssistant", deviceId: input.entityId ?? `home:activity:${input.domain ?? "logbook"}`, kind: "device",
          text: input.text, state: "saved",
          homeAssistant: { eventKind: "logbook", resourceName: input.name, entityId: input.entityId, domain: input.domain, state: input.state }
        };
        if (await this.store.hasEvent(roleId, event)) return false;
        await this.store.append(roleId, event);
        session.lastSampleAt = Date.now();
        delete this.sourceErrors.homeAssistant;
        session.error = Object.entries(this.sourceErrors).map(([source, message]) => `${source}: ${message}`).join("; ");
        this.dependencies.changed(roleId);
        return true;
      } catch (error) {
        this.sourceErrors.homeAssistant = error instanceof Error ? error.message : String(error);
        session.error = `homeAssistant: ${this.sourceErrors.homeAssistant}`;
        this.dependencies.changed(roleId);
        return false;
      }
    });
  }
  private async statusEvent(session: RecordingSession, text: string, authorize?: RecordingAuthorization) {
    const now = Date.now();
    await this.store.append(session.roleId, { id: randomUUID(), startedAt: now, endedAt: now, source: "session", deviceId: this.store.hostId, kind: "status", text, state: "saved" }, undefined, authorize);
  }
  private schedule(session: RecordingSession, delay: number) {
    if (!ALL_DAY_CAPTURE_SOURCES.some(source => session.settings.sources[source])) return;
    // Sampling deadline is explicit recording work, not a UI/business-state polling loop.
    session.timer = setTimeout(() => {
      session.pending = this.sample(session).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        session.error = /fetch failed|Failed to fetch|ECONNREFUSED/i.test(message)
          ? "本机采集服务连接失败，正在尝试恢复；仍失败时请在模型管理中重试安装运行环境。" : message;
        for (const source of ALL_DAY_CAPTURE_SOURCES) if (session.settings.sources[source]) this.sourceErrors[source] = session.error;
      }).finally(() => {
        this.dependencies.changed(session.roleId);
        if (this.session === session && !session.stopping) this.schedule(session, session.settings.intervalSeconds * 1000);
      });
    }, delay);
    session.timer.unref();
  }
  private scheduleCameraLease(session: RecordingSession) {
    clearTimeout(session.cameraLeaseTimer);
    if (!this.dependencies.renewCapture || !session.settings.sources.camera || session.stopping) return;
    session.cameraLeaseTimer = setTimeout(() => {
      if (this.session !== session || session.stopping) return;
      // Renew the owned hardware lease independently of sampling/NAS writes.
      // This endpoint cannot open a camera or acquire another session's lease.
      void this.dependencies.renewCapture!(session.id).catch(() => undefined).finally(() => {
        if (this.session === session && !session.stopping) this.scheduleCameraLease(session);
      });
    }, 30_000);
    session.cameraLeaseTimer.unref();
  }
  private scheduleAudioLease(session: RecordingSession) {
    clearTimeout(session.audioLeaseTimer);
    if (!this.dependencies.renewMicrophone || !session.audioSessionId || !session.settings.sources.microphone || session.stopping) return;
    session.audioLeaseTimer = setTimeout(() => {
      if (this.session !== session || session.stopping) return;
      session.audioLeasePending = this.dependencies.renewMicrophone!(session.id).catch(error => {
        if (this.session === session && !session.stopping) {
          this.sourceErrors.microphone = error instanceof Error ? error.message : String(error);
          this.dependencies.changed(session.roleId);
        }
      }).finally(() => {
        session.audioLeasePending = undefined;
        if (this.session === session && !session.stopping) this.scheduleAudioLease(session);
      });
    }, 30_000);
    session.audioLeaseTimer.unref();
  }
  private async collectAudio(session: RecordingSession, authorize?: RecordingAuthorization) {
    if (!session.settings.sources.microphone || !session.audioSessionId) return;
    const until = Date.now();
    // Catch up only on subscription/reconnection or stop. Completion updates use stable record IDs.
    for (const event of await recordingOperation(authorize, () => this.dependencies.audio(session.audioSince, until, session.audioSessionId!, authorize))) {
      await this.saveAudio(session, event, authorize);
    }
  }
  private async saveAudio(session: RecordingSession, event: AllDayEvent, authorize?: RecordingAuthorization) {
      if (event.startedAt < session.audioSince || event.startedAt > Date.now() + 60_000) return;
      const cached = session.audioRecords?.get(event.id);
      if (cached?.text === event.text && cached?.transcriptionState === event.transcriptionState) return;
      const filename = path.join(this.store.directory(session.roleId), "events", recordingDay(event.startedAt), `${hash(event.id)}.json`);
      const existing = await jsonOr<AllDayEvent | null>(filename, null, authorize);
      if (!existing || existing.text !== event.text || existing.transcriptionState !== event.transcriptionState) {
        if (existing?.media) await this.store.append(session.roleId, { ...event, media: existing.media }, undefined, authorize);
        else await this.store.append(session.roleId, event, await recordingOperation(authorize, () => this.dependencies.audioFile(event.speechRecordId!, authorize)), authorize);
      }
      session.audioRecords ??= new Map(); session.audioRecords.set(event.id, event);
      while (session.audioRecords.size > 512) session.audioRecords.delete(session.audioRecords.keys().next().value!);
  }
  private watchAudio(session: RecordingSession) {
    if (session.releaseAudio || !this.dependencies.watchAudio) return;
    session.releaseAudio = this.dependencies.watchAudio(id => {
      if (this.session !== session || session.stopping) return;
      session.audioChanges ??= new Set();
      if (id && session.audioChanges.size < 256) session.audioChanges.add(id); else session.audioCatchup = true;
      this.wakeAudio(session);
    }, error => {
      if (this.session !== session || session.stopping) return;
      this.sourceErrors.microphone = error; this.dependencies.changed(session.roleId);
    });
  }
  private wakeAudio(session: RecordingSession) {
    if (session.audioPending || session.audioWake || session.stopping) return;
    session.audioWake = setTimeout(() => {
      session.audioWake = undefined;
      if (this.session !== session || session.stopping) return;
      const authorize = () => { if (this.session !== session || session.stopping) throw new Error("Recording session has ended"); };
      session.audioPending = (async () => {
        if (session.audioCatchup) { session.audioCatchup = false; await this.collectAudio(session, authorize); }
        for (const id of session.audioChanges ?? []) {
          session.audioChanges!.delete(id);
          if (this.dependencies.audioRecord && session.audioSessionId) {
            const event = await this.dependencies.audioRecord(id, session.audioSessionId);
            authorize(); if (event) await this.saveAudio(session, event, authorize);
          }
        }
        delete this.sourceErrors.microphone;
      })().catch(error => {
        if (session.stopping) return;
        this.sourceErrors.microphone = error instanceof Error ? error.message : String(error);
        session.audioCatchup = true;
      }).finally(() => {
        session.audioPending = undefined;
        session.error = Object.entries(this.sourceErrors).map(([source, message]) => `${source}: ${message}`).join("; ");
        this.dependencies.changed(session.roleId);
        if (this.session === session && !session.stopping && (session.audioCatchup || session.audioChanges?.size)) this.wakeAudio(session);
      });
    }, session.audioCatchup && this.sourceErrors.microphone ? 3000 : 40);
    session.audioWake.unref();
  }
  /** Playback transcription belongs to the same timeline owner as microphone ASR. */
  async savePlayback(roleId: string, id: string, startedAt: number, endedAt: number, text: string, wav: Buffer, requestAuthorize?: RecordingAuthorization) {
    requestAuthorize?.();
    const session = this.session;
    if (!session || session.roleId !== roleId || session.stopping) return;
    const authorize = () => { requestAuthorize?.(); if (this.session !== session || session.stopping) throw new Error("Recording session has ended"); };
    await this.store.append(roleId, { id: `systemPlayback:${id}`, source: "systemAudio", deviceId: this.store.hostId, kind: "audio", state: "saved",
      transcriptionState: text ? "ready" : "empty", startedAt, endedAt, text }, wav, authorize);
    authorize();
    this.dependencies.changed(roleId);
  }
  private async sample(session: RecordingSession) {
    if (!session.prepared && this.dependencies.prepare) {
      session.preparing = true;
      this.dependencies.changed(session.roleId);
      try { await this.dependencies.prepare(); session.prepared = true; }
      finally { session.preparing = false; this.dependencies.changed(session.roleId); }
    }
    if (session.stopping) return;
    const now = Date.now();
    const errors: string[] = [];
    for (const source of ALL_DAY_CAPTURE_SOURCES) delete this.sourceErrors[source];
    if (this.sourceErrors.homeAssistant) errors.push(`homeAssistant: ${this.sourceErrors.homeAssistant}`);
    let microphoneReady = false;
    if (session.settings.sources.microphone) {
      try { session.audioSessionId = await this.dependencies.startMicrophone(session.id) || session.id; microphoneReady = true; this.watchAudio(session); this.scheduleAudioLease(session); }
      catch (error) { this.sourceErrors.microphone = error instanceof Error ? error.message : String(error); errors.push(`microphone: ${this.sourceErrors.microphone}`); }
    }
    if (session.settings.sources.camera) {
      session.cameraActive = true;
      if (!session.cameraLeaseTimer) this.scheduleCameraLease(session);
    }
    let samples: RecordingSample[];
    try { samples = await this.dependencies.capture({...session.settings, sources:{...session.settings.sources,microphone:microphoneReady}}, session.id); }
    catch (error) { session.prepared = false; throw error; }
    let successful = microphoneReady;
    for (const sample of samples) {
      if (!session.settings.sources[sample.source]) continue;
      if (sample.error) { this.sourceErrors[sample.source] = sample.error; errors.push(`${sample.source}: ${sample.error}`); }
      else successful = true;
      if (sample.source === "window" && !sample.error && session.windowTitle === sample.text) continue;
      if (sample.source === "window" && !sample.error) session.windowTitle = sample.text ?? "";
      await this.store.append(session.roleId, { id: randomUUID(), startedAt: now, endedAt: now, source: sample.source, deviceId: this.store.hostId, kind: sample.jpeg ? "image" : sample.source === "window" ? "window" : "status", text: sample.error ?? sample.text ?? "", state: sample.error ? "error" : "saved" }, sample.jpeg ? Buffer.from(sample.jpeg, "base64") : undefined);
    }
    if (!this.dependencies.watchAudio) {
      try { await this.collectAudio(session); }
      catch (error) { this.sourceErrors.microphone = error instanceof Error ? error.message : String(error); errors.push(`microphone: ${this.sourceErrors.microphone}`); }
    }
    if (this.sourceErrors.microphone && !errors.some(error => error.startsWith("microphone:"))) errors.push(`microphone: ${this.sourceErrors.microphone}`);
    if (successful) session.lastSampleAt = now;
    session.error = errors.join("; ");
  }
}
