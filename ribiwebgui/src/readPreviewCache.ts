const storageKey = "rabiroute:read-previews:v1";
const retentionMs = 24 * 60 * 60 * 1000;
const maxEntryChars = 120_000;
const maxTotalChars = 600_000;
const maxEntries = 32;

type Entry = { key: string; at: number; json: string };

function keyFor(parts: readonly string[]): string {
  return JSON.stringify([window.__RABI_MANAGER_API_BASE__ || "", ...parts]);
}

function readEntries(): Entry[] {
  const raw = window.sessionStorage.getItem(storageKey);
  if (!raw || raw.length > maxTotalChars) return [];
  const entries: unknown = JSON.parse(raw);
  const now = Date.now();
  return Array.isArray(entries) ? entries.filter((entry): entry is Entry =>
    entry && typeof entry.key === "string" && typeof entry.json === "string" &&
    entry.json.length <= maxEntryChars && Number.isFinite(entry.at) &&
    entry.at <= now && now - entry.at < retentionMs
  ) : [];
}

/** First-paint data only. The caller still owns live reads, authorization and actions. */
export function readPreview<T>(parts: readonly string[]): T | undefined {
  try {
    const entry = readEntries().find(item => item.key === keyFor(parts));
    return entry ? JSON.parse(entry.json) as T : undefined;
  } catch { return undefined; }
}

export function writePreview(parts: readonly string[], value: unknown): void {
  try {
    const key = keyFor(parts);
    const entries = readEntries().filter(item => item.key !== key);
    if (value !== undefined) {
      const json = JSON.stringify(value);
      if (json.length <= maxEntryChars) entries.unshift({ key, at: Date.now(), json });
    }
    entries.length = Math.min(entries.length, maxEntries);
    let encoded = JSON.stringify(entries);
    while (encoded.length > maxTotalChars) {
      entries.pop();
      encoded = JSON.stringify(entries);
    }
    window.sessionStorage.setItem(storageKey, encoded);
  } catch { /* Disabled or full browser storage does not affect the live request. */ }
}

export function clearReadPreviews(): void {
  try { window.sessionStorage.removeItem(storageKey); }
  catch { /* Storage is unavailable. */ }
}

export function previewAccessDenied(status: unknown): boolean {
  return status === 401 || status === 403 || status === 404;
}
