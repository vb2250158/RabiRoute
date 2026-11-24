import type { DesktopSettings } from "@shared/desktopSettingsContract";

async function request<T>(init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api/desktop/settings", {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) }
  });
  const body = await response.json() as { code?: number; data?: T; message?: string };
  if (!response.ok || body.code !== 0 || body.data == null) {
    throw new Error(body.message || `HTTP ${response.status}`);
  }
  return body.data;
}

export const desktopSettingsClient = {
  read: readDesktopSettings,
  invalidateRead: () => { readFlight = undefined; },
  update: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> => request<DesktopSettings>({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  }).finally(() => { readFlight = undefined; })
};

let readFlight: Promise<DesktopSettings> | undefined;

function readDesktopSettings(): Promise<DesktopSettings> {
  if (readFlight) return readFlight;
  const flight = request<DesktopSettings>().finally(() => { if (readFlight === flight) readFlight = undefined; });
  readFlight = flight;
  return readFlight;
}
