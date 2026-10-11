import fs from "node:fs";
import { promises as asyncFs } from "node:fs";
import path from "node:path";
import { isReviewEvent, type AllDayCatalog, type AllDayEvent } from "../shared/allDayRecording.js";

/** Only the Manager supplies these roots; HTTP callers supply no filesystem paths. */
export type AllDayReadJob = {
  kind: "catalog" | "recent" | "scan" | "media";
  directory: string;
  mobileRoot: string;
  mobileDeviceIds: string[];
  day?: string;
  id?: string;
  extension?: string;
};
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day));
function names(directory: string): string[] {
  try { return fs.readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function exists(file: string): boolean {
  try { fs.accessSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function read(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}
function rows(value: unknown): AllDayEvent[] | null {
  const events = (value as { events?: unknown } | null)?.events;
  return Array.isArray(events) && events.every(row => row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt)) ? events : null;
}
async function scanOriginals(directory: string): Promise<AllDayEvent[]> {
  let files: string[];
  try { files = await asyncFs.readdir(directory); }
  catch(error) {if((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error;}
  const originals = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const events: AllDayEvent[] = [];
  // Bound SMB concurrency inside the worker; the Manager's file threads stay free.
  for(let offset=0;offset<originals.length;offset+=16) {
    const batch=await Promise.all(originals.slice(offset,offset+16).map(name=>asyncFs.readFile(path.join(directory,name),"utf8")));
    events.push(...batch.map(body=>JSON.parse(body) as AllDayEvent));
  }
  return events;
}
/** SMB calls run in an isolated, cancellable read worker, never the Manager. */
export function readAllDayStorage(job: AllDayReadJob): AllDayCatalog | Buffer | Promise<AllDayEvent[]> {
  if (job.day !== undefined && !validDay(job.day)) throw new Error("Invalid recording day");
  if (job.kind === "media") {
    if (!job.day || !/^[a-f0-9]{64}$/.test(job.id ?? "") || !["jpg", "wav"].includes(job.extension ?? "")) throw new Error("Invalid media reference");
    return fs.readFileSync(path.join(job.directory, "media", job.day, `${job.id}.${job.extension}`));
  }
  if (job.kind === "scan") {
    if (!job.day) throw new Error("Missing recording day");
    return scanOriginals(path.join(job.directory, job.day));
  }
  const directories = [job.directory, ...(job.mobileDeviceIds.length ? [job.mobileRoot] : [])];
  const events: AllDayEvent[] = [], days = new Set<string>(), incomplete = new Set<string>();
  for (const root of directories) {
    if (job.kind === "recent" || !job.day) events.push(...(rows(read(path.join(root, "recent-preview.json"))) ?? []).slice(-128));
    if (job.kind === "recent") continue;
    const indexRoot = path.join(root, "events-index"), originalsRoot = path.join(root, "events");
    if (job.day) {
      days.add(job.day);
      const index = read(path.join(indexRoot, `${job.day}.json`));
      const indexed = (index as { schemaVersion?: number } | null)?.schemaVersion === 2 ? rows(index) : null;
      const dirty = exists(path.join(indexRoot, `${job.day}.dirty.json`));
      if (dirty || !indexed && (exists(path.join(indexRoot, `${job.day}.json`)) || exists(path.join(originalsRoot, job.day)))) incomplete.add(job.day);
      if (indexed) events.push(...indexed);
    } else {
      const indexes = new Set(names(indexRoot));
      for (const day of new Set([...names(originalsRoot).filter(validDay), ...[...indexes].filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, 10))])) {
        days.add(day);
        if (!indexes.has(`${day}.json`) || indexes.has(`${day}.dirty.json`)) incomplete.add(day);
      }
    }
  }
  const filtered = events.filter(row => isReviewEvent(row) && (row.source !== "mobile" || job.mobileDeviceIds.includes(row.deviceId)));
  return { events: [...new Map(filtered.map(row => [row.id, row])).values()].sort((a,b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)), days: [...days].sort(), incompleteDays: [...incomplete].sort() };
}
