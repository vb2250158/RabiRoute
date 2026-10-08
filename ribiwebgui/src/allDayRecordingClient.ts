import { isReviewEvent, type AllDayEvent } from "../../src/shared/allDayRecording";

const previews = new Map<string, { at: number; events: AllDayEvent[] }>();
let previewDb: Promise<IDBDatabase | null> | undefined;
function previewDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return previewDb ??= new Promise(resolve => {
    const request = indexedDB.open("all-day-recording-preview", 1);
    const timer = setTimeout(() => { previewDb = undefined; resolve(null); }, 4000);
    request.onupgradeneeded = () => request.result.createObjectStore("personas");
    request.onerror = () => { clearTimeout(timer); previewDb = undefined; resolve(null); };
    request.onsuccess = () => {
      clearTimeout(timer);
      request.result.onversionchange = () => { request.result.close(); previewDb = undefined; };
      resolve(request.result);
    };
  });
}
async function previewTransaction<T>(roleId: string, snapshot?: { at: number; events: AllDayEvent[] }): Promise<T | undefined> {
  const db = await previewDatabase();
  if (!db) return;
  return new Promise(resolve => {
    const transaction = db.transaction("personas", snapshot ? "readwrite" : "readonly");
    const store = transaction.objectStore("personas");
    const request = snapshot ? store.put(snapshot, roleId) : store.get(roleId);
    const timer = setTimeout(() => { transaction.abort(); resolve(undefined); }, 4000);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(snapshot ? undefined : request.result); };
    transaction.onerror = transaction.onabort = () => { clearTimeout(timer); resolve(undefined); };
  });
}
/** Restore large metadata snapshots independently of the server and first paint. */
export async function restoreRecordingPreview(roleId: string): Promise<AllDayEvent[]> {
  try {
    const snapshot = await previewTransaction<{ at: number; events: AllDayEvent[] }>(roleId);
    if (!snapshot || Date.now() - snapshot.at >= 86400_000) return [];
    previews.delete(roleId); previews.set(roleId, snapshot);
    while (previews.size > 4) previews.delete(previews.keys().next().value!);
    return recordingPreview(roleId);
  } catch { return []; }
}
/** A disposable per-persona preview, never the owner of saved history. */
export function recordingPreview(roleId: string): AllDayEvent[] {
  try {
    const cached = previews.get(roleId) ?? JSON.parse(localStorage.getItem(`all-day-preview:${roleId}`) || "null");
    if (cached && Date.now() - cached.at < 86400_000 && Array.isArray(cached.events)) {
      return cached.events.filter((row: AllDayEvent) => row && typeof row.id === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) && ["microphone", "screen", "window", "camera", "homeAssistant", "mobile", "session"].includes(row.source) && isReviewEvent(row));
    }
  } catch { /* The server owns history; disabled storage cannot block entry. */ }
  return [];
}
export function rememberRecordingPreview(roleId: string, events: AllDayEvent[]): void {
  const snapshot = { at: Date.now(), events };
  previews.delete(roleId); previews.set(roleId, snapshot);
  while (previews.size > 4) previews.delete(previews.keys().next().value!);
  try {
    const serialized = JSON.stringify(snapshot);
    // A small synchronous preview complements the complete IndexedDB snapshot.
    localStorage.setItem(`all-day-preview:${roleId}`, serialized.length <= 5_000_000 ? serialized : JSON.stringify({ at: snapshot.at, events: events.slice(-200) }));
  } catch { /* Quota exhaustion only disables cross-reload preview storage. */ }
  void previewTransaction(roleId, snapshot).catch(() => {});
}

/** Bound the complete read, including response bodies, without retrying capture mutations. */
export async function readAllDayResource<T>(url: string, read: (response: Response) => Promise<T>, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 12000): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const response = await fetch(url, { ...init, signal: combined });
    return await read(response);
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) {
      throw new DOMException("Recording request timed out", "TimeoutError");
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
