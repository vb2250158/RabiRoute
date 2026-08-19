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
  read: (): Promise<DesktopSettings> => request(),
  update: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> => request({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  })
};
