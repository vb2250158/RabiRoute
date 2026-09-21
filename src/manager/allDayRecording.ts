import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { ALL_DAY_SOURCES, DEFAULT_ALL_DAY_SETTINGS, isReviewEvent, matchesReviewType, normalizeAllDaySettings, type AllDayEvent, type AllDaySettings, type AllDaySnapshot } from "../shared/allDayRecording.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const recordingDay = (time: number) => new Date(time).toISOString().slice(0, 10);
export async function atomicRecordingJson(file: string, value: unknown): Promise<void> {
  const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
    group: "all-day-recording", event: "recording_file_write", owner: "all-day-recording",
    action: "write", target: { type: "recording-file", id: hash(file) },
    dataSource: { kind: "file", id: hash(file) }, outcome
  });
  audit("started");
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.partial`;
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
    audit("committed");
  } catch (error) {
    audit("failed");
    throw error;
  }
}
async function jsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
const dayReads = new Map<string, { expires: number; rows: Promise<AllDayEvent[]> }>();
type DayIndex = { schemaVersion: 2; events: AllDayEvent[] };
const dayWrites = new Map<string, Promise<unknown>>();
const recentPath = (directory: string) => path.join(path.dirname(directory), "recent-preview.json");
async function recentRows(directory: string): Promise<AllDayEvent[]> {
  try {
    const value = await jsonOr<{ events: AllDayEvent[] }>(recentPath(directory), { events: [] });
    return Array.isArray(value.events) ? value.events.filter(row => row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)).slice(-128) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}
async function updateRecent(directory: string, rows: AllDayEvent[]): Promise<void> {
  await withDay(recentPath(directory), async () => {
    const events = [...new Map([...(await recentRows(directory)), ...rows].map(row => [row.id, row])).values()]
      .filter(isReviewEvent).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-128);
    await atomicRecordingJson(recentPath(directory), { events });
  });
}
const dayIndexPath = (directory: string, day: string) => path.join(path.dirname(directory), "events-index", `${day}.json`);
const dayDirtyPath = (directory: string, day: string) => path.join(path.dirname(directory), "events-index", `${day}.dirty.json`);
async function withDay<T>(scope: string, action: () => Promise<T>): Promise<T> {
  const pending = (dayWrites.get(scope) ?? Promise.resolve()).catch(() => undefined).then(action);
  dayWrites.set(scope,pending);
  try { return await pending; } finally { if(dayWrites.get(scope) === pending) dayWrites.delete(scope); }
}
async function validDayIndex(directory: string, day: string): Promise<DayIndex | null> {
  try { await fs.access(dayDirtyPath(directory,day)); return null; }
  catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const value = await jsonOr<DayIndex | null>(dayIndexPath(directory,day),null);
    return value?.schemaVersion === 2 && Array.isArray(value.events) && value.events.every(row =>
      row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)) ? value : null;
  } catch { return null; } // A damaged derived index can be rebuilt from originals.
}
async function writeIndexedEvent(directory: string, day: string, key: string, event: AllDayEvent): Promise<void> {
  const scope = path.join(directory,day);
  await withDay(scope,async () => {
    const index = await validDayIndex(directory,day);
    // The durable marker survives a crash between the original and derived writes.
    await atomicRecordingJson(dayDirtyPath(directory,day),{eventId:event.id});
    await atomicRecordingJson(path.join(scope,`${key}.json`),event);
    await updateRecent(directory, [event]);
    dayReads.delete(scope);
    // An absent index is rebuilt by the next query, never by the capture loop.
    if(index) {
      const events = index.events.filter(row => row.id !== event.id); events.push(event);
      const next = { schemaVersion: 2, events };
      await atomicRecordingJson(dayIndexPath(directory,day),next);
      await fs.rm(dayDirtyPath(directory,day));
    }
  });
}
async function readDay(directory: string, day: string): Promise<AllDayEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid recording day");
  const key = path.join(directory, day);
  const cached = dayReads.get(key);
  if (cached && cached.expires > Date.now()) return cached.rows;
  const entry = { expires: Infinity, rows: withDay(key,async () => {
    const index = await validDayIndex(directory,day);
    if(index) { await updateRecent(directory, index.events); return index.events; }
    const rows = await scanDay(directory,day);
    await atomicRecordingJson(dayIndexPath(directory,day),{schemaVersion:2,events:rows});
    await updateRecent(directory, rows);
    await fs.rm(dayDirtyPath(directory,day),{force:true});
    return rows;
  }) };
  dayReads.delete(key); dayReads.set(key,entry);
  while(dayReads.size > 8) dayReads.delete(dayReads.keys().next().value!);
  try {
    const rows = await entry.rows;
    entry.expires = Date.now() + 5000;
    if(rows.length > 20000 && dayReads.get(key) === entry) dayReads.delete(key);
    return rows;
  } catch(error) {
    if(dayReads.get(key) === entry) dayReads.delete(key);
    throw error;
  }
}
async function scanDay(directory: string, day: string): Promise<AllDayEvent[]> {
  let names: string[];
  try { names = await fs.readdir(path.join(directory, day)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const events: AllDayEvent[] = [];
  // Bounded parallel batches avoid one network round-trip per event in series.
  const files = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  for(let offset = 0; offset < files.length; offset += 16) {
    const batch = await Promise.all(files.slice(offset,offset+16).map(name => fs.readFile(path.join(directory,day,name),"utf8")));
    for(const bytes of batch) events.push(JSON.parse(bytes) as AllDayEvent);
  }
  return events;
}
export class AllDayRecordingStore {
  constructor(readonly roleDirectory: (roleId: string) => string, readonly hostId: string, readonly mobileRoot: string) {}
  async enabledRole(): Promise<string | null> {
    const value = await jsonOr<{roleId: string | null}>(path.join(this.mobileRoot, "capture-intent.json"), {roleId:null});
    if (value.roleId !== null && (typeof value.roleId !== "string" || !value.roleId || value.roleId.length > 128 || /[\\/\x00-\x1f]/.test(value.roleId) || [".",".."].includes(value.roleId))) throw new Error("Invalid saved recording persona");
    return value.roleId;
  }
  async enableRole(roleId: string | null) {
    await atomicRecordingJson(path.join(this.mobileRoot, "capture-intent.json"), {roleId});
  }
  directory(roleId: string) { return path.join(this.roleDirectory(roleId), "all-day-recording", hash(this.hostId)); }
  async settings(roleId: string): Promise<AllDaySettings> {
    return normalizeAllDaySettings(await jsonOr(path.join(this.directory(roleId), "settings.json"), DEFAULT_ALL_DAY_SETTINGS));
  }
  async configure(roleId: string, input: unknown) {
    const settings = normalizeAllDaySettings(input);
    await atomicRecordingJson(path.join(this.directory(roleId), "settings.json"), settings);
    return settings;
  }
  async hasEvent(roleId: string, event: AllDayEvent): Promise<boolean> {
    try { await fs.access(path.join(this.directory(roleId), "events", recordingDay(event.startedAt), `${hash(event.id)}.json`)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async append(roleId: string, event: AllDayEvent, image?: Buffer): Promise<void> {
    const root = this.directory(roleId);
    const key = hash(event.id);
    if (image) {
      const audio = event.kind === "audio";
      if (image.length > 16 * 1024 * 1024 || (audio ? image.subarray(0, 4).toString() !== "RIFF" : image[0] !== 0xff || image[1] !== 0xd8)) throw new Error("Invalid recording media");
      const media = path.join("media", recordingDay(event.startedAt), `${key}.${audio ? "wav" : "jpg"}`);
      const destination = path.join(root, media);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.partial`;
      const handle = await fs.open(temporary, "wx");
      try { await handle.writeFile(image); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temporary, destination); } finally { await fs.rm(temporary, { force: true }); }
      event = { ...event, media: media.split(path.sep).join("/") };
    }
    await writeIndexedEvent(path.join(root,"events"),recordingDay(event.startedAt),key,event);
  }
  async timeline(roleId: string, since: number, until: number): Promise<AllDayEvent[]> {
    if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since || until - since > 26 * 3600_000) throw new Error("Select at most one local day");
    const settings = await this.settings(roleId);
    const result: AllDayEvent[] = [];
    for (let time = Date.parse(recordingDay(since)); time <= until; time += 86400_000) {
      result.push(...await readDay(path.join(this.directory(roleId), "events"), recordingDay(time)));
      if (settings.mobileDeviceIds.length) {
        result.push(...(await readDay(path.join(this.mobileRoot, "events"), recordingDay(time))).filter(event => settings.mobileDeviceIds.includes(event.deviceId)));
      }
    }
    return result.filter(event => isReviewEvent(event) && event.startedAt < until && event.endedAt >= since).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
  async recent(roleId: string): Promise<AllDayEvent[]> {
    const [settings, computer] = await Promise.all([
      this.settings(roleId), recentRows(path.join(this.directory(roleId), "events"))
    ]);
    const mobile = settings.mobileDeviceIds.length
      ? (await recentRows(path.join(this.mobileRoot, "events"))).filter(row => settings.mobileDeviceIds.includes(row.deviceId)) : [];
    return [...computer, ...mobile].filter(isReviewEvent).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }
  async page(roleId: string, direction: "older" | "newer", cursor: { time: number; id: string }, source = "all", limit = 100, eventType = "all") {
    if (!["all", "asr", "image", "window", "status"].includes(eventType)) throw new Error("Invalid event type");
    if (!Number.isFinite(cursor.time) || cursor.time < 0 || cursor.id.length > 512 || !["all", ...ALL_DAY_SOURCES, "mobile", "session"].includes(source)) throw new Error("Invalid event cursor");
    const settings = await this.settings(roleId);
    const directories = [path.join(this.directory(roleId), "events"), ...(settings.mobileDeviceIds.length ? [path.join(this.mobileRoot, "events")] : [])];
    const dates = new Set<string>();
    for (const directory of directories) {
      try { for (const day of await fs.readdir(directory)) if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dates.add(day); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const cursorDay = recordingDay(cursor.time);
    const days = [...dates].filter(day => direction === "older" ? day <= cursorDay : day >= cursorDay).sort();
    if (direction === "older") days.reverse();
    const rows: AllDayEvent[] = [];
    const compare = (a: AllDayEvent, b: AllDayEvent) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
    for (const day of days) {
      const records = (await Promise.all(directories.map(directory => readDay(directory, day)))).flat();
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
  async mobileDevices(): Promise<{ id: string; lastReceivedAt: number }[]> {
    return jsonOr(path.join(this.mobileRoot, "devices.json"), []);
  }
  private mobileWrite: Promise<unknown> = Promise.resolve();
  receiveMobile(owner: string, input: unknown): Promise<void> {
    const operation = this.mobileWrite.catch(() => undefined).then(async () => {
      if (!owner || !input || typeof input !== "object") throw new Error("Invalid mobile event");
      const row = input as Record<string, unknown>;
      const startedAt = Number(row.startedAt), endedAt = Number(row.endedAt);
      if (typeof row.id !== "string" || !/^[\w-]{1,200}$/.test(row.id) || !Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(endedAt) || endedAt < startedAt || endedAt > Date.now() + 86400_000 || typeof row.text !== "string" || row.text.length > 100_000) throw new Error("Invalid mobile event fields");
      const deviceId = hash(owner);
      if (!Array.isArray(row.chunks) || row.chunks.length < 1 || row.chunks.length > 16 || row.chunks.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid recording media chunks");
      const transcriptionState = row.transcriptionState === undefined ? "ready" : row.transcriptionState;
      if (!["pending","processing","ready","empty","error"].includes(String(transcriptionState))) throw new Error("Invalid transcription state");
      const event: AllDayEvent = { id: `mobile:${deviceId}:${row.id}`, startedAt, endedAt, source: "mobile", deviceId, kind: "audio", text: row.text, state: "saved", transcriptionState: transcriptionState as AllDayEvent["transcriptionState"], mobileMedia: { owner, chunks: row.chunks as string[] } };
      await writeIndexedEvent(path.join(this.mobileRoot,"events"),recordingDay(startedAt),hash(event.id),event);
      const devices = await this.mobileDevices();
      const updated = [...devices.filter(device => device.id !== deviceId), { id: deviceId, lastReceivedAt: Date.now() }];
      await atomicRecordingJson(path.join(this.mobileRoot, "devices.json"), updated);
    });
    this.mobileWrite = operation;
    return operation;
  }
  async media(roleId: string, day: string, id: string, extension = "jpg"): Promise<Buffer> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-f0-9]{64}$/.test(id) || !["jpg", "wav"].includes(extension)) throw new Error("Invalid media reference");
    return fs.readFile(path.join(this.directory(roleId), "media", day, `${id}.${extension}`));
  }
}

export type RecordingSample = { source: "screen" | "window" | "camera"; text?: string; jpeg?: string; error?: string };
export type AllDayCaptureDependencies = {
  capture(settings: AllDaySettings, sessionId: string): Promise<RecordingSample[]>;
  startMicrophone(sessionId: string): Promise<string | void>;
  stopMicrophone(sessionId: string): Promise<void>;
  audio(since: number, until: number, sessionId: string): Promise<AllDayEvent[]>;
  audioFile(recordId: string): Promise<Buffer>;
  changed(roleId: string): void;
};
type RecordingSession = { audioSessionId?: string; roleId: string; id: string; settings: AllDaySettings; startedAt: number; lastSampleAt: number | null; audioSince: number; error: string; timer?: NodeJS.Timeout; pending?: Promise<void>; stopping: boolean; windowTitle: string | null };

/** One host capture owner; explicit enable intent survives orderly shutdown. */
export class AllDayRecordingService {
  private session: RecordingSession | null = null;
  private transition: Promise<unknown> = Promise.resolve();
  private sourceErrors: Partial<Record<typeof ALL_DAY_SOURCES[number], string>> = {};
  constructor(readonly store: AllDayRecordingStore, private readonly dependencies: AllDayCaptureDependencies) {}
  async restore() { const roleId = await this.store.enabledRole(); if (roleId) await this.start(roleId); }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.transition.catch(() => undefined).then(action);
    this.transition = result;
    return result;
  }
  async snapshot(roleId: string): Promise<AllDaySnapshot> {
    const session = this.session?.roleId === roleId ? this.session : null;
    return { settings: await this.store.settings(roleId), enabled: await this.store.enabledRole() === roleId, sourceErrors:session ? {...this.sourceErrors} : {}, running: !!session && !session.stopping, activeRoleId: this.session?.roleId ?? null, startedAt: session?.startedAt ?? null, lastSampleAt: session?.lastSampleAt ?? null, error: session?.error ?? "" };
  }
  configure(roleId: string, input: unknown) {
    return this.serialize(async () => {
      const settings = normalizeAllDaySettings(input);
      const session = this.session?.roleId === roleId ? this.session : null;
      if (session) {
        clearTimeout(session.timer); session.stopping = true;
        try {
          await session.pending;
          if (session.settings.sources.microphone && !settings.sources.microphone) {
            await this.dependencies.stopMicrophone(session.id);
            await this.collectAudio(session);
            session.audioSessionId = undefined;
          }
          await this.store.configure(roleId, settings);
          if (!session.settings.sources.microphone && settings.sources.microphone) session.audioSince = Date.now();
          session.settings = settings; session.windowTitle = null;
        } finally { session.stopping = false; this.schedule(session, 0); }
      } else await this.store.configure(roleId, settings);
      this.dependencies.changed(roleId);
      return this.snapshot(roleId);
    });
  }
  start(roleId: string) {
    return this.serialize(async () => {
      if (this.session) {
        if (this.session.roleId !== roleId) throw new Error("Another persona is recording on this computer");
        return this.snapshot(roleId);
      }
      const settings = await this.store.settings(roleId);
      if (!ALL_DAY_SOURCES.some(source => settings.sources[source]) && await this.store.enabledRole() !== roleId) throw new Error("Select at least one computer source");
      const now = Date.now();
      this.sourceErrors = {};
      const session: RecordingSession = { roleId, id: randomUUID(), settings, startedAt: now, audioSince: now, lastSampleAt: null, error: "", stopping: false, windowTitle: null };
      await this.store.enableRole(roleId);
      this.session = session;
      try { await this.statusEvent(session, "Recording started"); }
      catch (error) { this.session = null; if (settings.sources.microphone) await this.dependencies.stopMicrophone(session.id); throw error; }
      this.schedule(session, 0);
      this.dependencies.changed(roleId);
      return this.snapshot(roleId);
    });
  }
  stop(roleId: string, preserveIntent = false) {
    return this.serialize(async () => {
      if (!preserveIntent && await this.store.enabledRole() === roleId) await this.store.enableRole(null);
      const session = this.session;
      if (!session || session.roleId !== roleId) return this.snapshot(roleId);
      session.stopping = true;
      clearTimeout(session.timer);
      await session.pending;
      try {
        if (session.settings.sources.microphone) await this.dependencies.stopMicrophone(session.id);
        await this.collectAudio(session);
        await this.statusEvent(session, "Recording paused");
      } finally { this.session = null; this.dependencies.changed(roleId); }
      return this.snapshot(roleId);
    });
  }
  async dispose() { if (this.session) await this.stop(this.session.roleId, true); }
  private async statusEvent(session: RecordingSession, text: string) {
    const now = Date.now();
    await this.store.append(session.roleId, { id: randomUUID(), startedAt: now, endedAt: now, source: "session", deviceId: this.store.hostId, kind: "status", text, state: "saved" });
  }
  private schedule(session: RecordingSession, delay: number) {
    // Sampling deadline is explicit recording work, not a UI/business-state polling loop.
    session.timer = setTimeout(() => {
      session.pending = this.sample(session).catch(error => { session.error = error instanceof Error ? error.message : String(error); }).finally(() => {
        this.dependencies.changed(session.roleId);
        if (this.session === session && !session.stopping) this.schedule(session, session.settings.intervalSeconds * 1000);
      });
    }, delay);
    session.timer.unref();
  }
  private async collectAudio(session: RecordingSession) {
    if (!session.settings.sources.microphone || !session.audioSessionId) return;
    const until = Date.now();
    // Re-read this session: delayed ASR completion must not disappear behind a timestamp cursor.
    for (const event of await this.dependencies.audio(session.audioSince, until, session.audioSessionId)) {
      const filename = path.join(this.store.directory(session.roleId), "events", recordingDay(event.startedAt), `${hash(event.id)}.json`);
      const existing = await jsonOr<AllDayEvent | null>(filename, null);
      if (existing && existing.text === event.text && existing.transcriptionState === event.transcriptionState) continue;
      if (existing?.media) { await this.store.append(session.roleId, { ...event, media: existing.media }); continue; }
      await this.store.append(session.roleId, event, await this.dependencies.audioFile(event.speechRecordId!));
    }
  }
  private async sample(session: RecordingSession) {
    const now = Date.now();
    const errors: string[] = [];
    this.sourceErrors = {};
    let microphoneReady = false;
    if (session.settings.sources.microphone) {
      try { session.audioSessionId = await this.dependencies.startMicrophone(session.id) || session.id; microphoneReady = true; }
      catch (error) { this.sourceErrors.microphone = error instanceof Error ? error.message : String(error); errors.push(`microphone: ${this.sourceErrors.microphone}`); }
    }
    const samples = await this.dependencies.capture({...session.settings, sources:{...session.settings.sources,microphone:microphoneReady}}, session.id);
    for (const sample of samples) {
      if (!session.settings.sources[sample.source]) continue;
      if (sample.error) { this.sourceErrors[sample.source] = sample.error; errors.push(`${sample.source}: ${sample.error}`); }
      if (sample.source === "window" && !sample.error && session.windowTitle === sample.text) continue;
      if (sample.source === "window" && !sample.error) session.windowTitle = sample.text ?? "";
      await this.store.append(session.roleId, { id: randomUUID(), startedAt: now, endedAt: now, source: sample.source, deviceId: this.store.hostId, kind: sample.jpeg ? "image" : sample.source === "window" ? "window" : "status", text: sample.error ?? sample.text ?? "", state: sample.error ? "error" : "saved" }, sample.jpeg ? Buffer.from(sample.jpeg, "base64") : undefined);
    }
    try { await this.collectAudio(session); }
    catch (error) { errors.push(`microphone: ${error instanceof Error ? error.message : String(error)}`); }
    session.lastSampleAt = now;
    session.error = errors.join("; ");
  }
}
