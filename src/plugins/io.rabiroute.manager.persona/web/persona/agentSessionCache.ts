/** Session-list cache: the last read of each Agent endpoint, so a revisit paints before the network. */
import type { PersonaAgentTask } from "./agentSessionClient";

export type CachedSessionPage = { tasks: PersonaAgentTask[]; nextOffset: number | null; readAt: number };
const STORAGE_KEY = "rabiroute.history.agent-sessions.cache";
/** Two hours covers a working session; older pages would misrepresent "recent" ordering. */
export const SESSION_CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Bounded per Agent endpoint and in total, so a long-lived tab cannot grow without limit. */
export const SESSION_CACHE_MAX_ENTRIES = 60;
export const SESSION_CACHE_MAX_TASKS = 400;

const cache = new Map<string, CachedSessionPage>();
let loaded = false;

function readStorage(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CachedSessionPage>;
    for (const [key, page] of Object.entries(parsed)) {
      if (!Array.isArray(page?.tasks) || typeof page.readAt !== "number") continue;
      if (Date.now() - page.readAt > SESSION_CACHE_MAX_AGE_MS) continue;
      cache.set(key, page);
    }
  } catch { /* A disabled or full store only costs the warm start. */ }
}

/** Persist only the head of each list: older pages come from the network when requested. */
function writeStorage(): void {
  try {
    const entries = [...cache].slice(-SESSION_CACHE_MAX_ENTRIES).map(([key, page]) => [key, {
      ...page, tasks: page.tasks.slice(0, SESSION_CACHE_MAX_TASKS)
    }]);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* Quota or privacy mode leaves the in-memory cache usable. */ }
}

export function cachedSessionPage(key: string): CachedSessionPage | undefined {
  readStorage();
  const page = cache.get(key);
  if (!page) return undefined;
  if (Date.now() - page.readAt > SESSION_CACHE_MAX_AGE_MS) { cache.delete(key); return undefined; }
  return page;
}

export function rememberSessionPage(key: string, tasks: readonly PersonaAgentTask[], nextOffset: number | null): void {
  readStorage();
  cache.set(key, { tasks: tasks.slice(0, SESSION_CACHE_MAX_TASKS), nextOffset, readAt: Date.now() });
  // Drop the oldest reads first; the current list keeps its newest entries.
  while (cache.size > SESSION_CACHE_MAX_ENTRIES) {
    const oldest = [...cache].sort((left, right) => left[1].readAt - right[1].readAt)[0];
    if (!oldest) break;
    cache.delete(oldest[0]);
  }
  writeStorage();
}

export function forgetSessionPages(): void {
  cache.clear();
  loaded = true;
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* Nothing to clear. */ }
}
