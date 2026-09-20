export const ALL_DAY_SOURCES = ["microphone", "screen", "window", "camera"] as const;
export type AllDaySource = typeof ALL_DAY_SOURCES[number];
export type AllDaySettings = {
  sources: Record<AllDaySource, boolean>;
  intervalSeconds: number;
  cameraIndex: number;
  mobileDeviceIds: string[];
};
export const DEFAULT_ALL_DAY_SETTINGS: AllDaySettings = {
  sources: { microphone: false, screen: false, window: false, camera: false },
  intervalSeconds: 60, cameraIndex: 0, mobileDeviceIds: []
};
export type AllDayEvent = {
  id: string;
  startedAt: number;
  endedAt: number;
  source: AllDaySource | "mobile" | "session";
  deviceId: string;
  kind: "audio" | "image" | "window" | "status";
  text: string;
  state: "saved" | "error";
  media?: string;
  speechRecordId?: string;
  mobileMedia?: { owner: string; chunks: string[] };
};
export type AllDaySnapshot = {
  settings: AllDaySettings;
  running: boolean;
  activeRoleId: string | null;
  startedAt: number | null;
  lastSampleAt: number | null;
  error: string;
};
export function normalizeAllDaySettings(value: unknown): AllDaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recording settings");
  const input = value as Partial<AllDaySettings>;
  if (!input.sources || ALL_DAY_SOURCES.some(source => typeof input.sources?.[source] !== "boolean")) throw new Error("Select recording sources");
  if (!Number.isInteger(input.intervalSeconds) || Number(input.intervalSeconds) < 10 || Number(input.intervalSeconds) > 3600) throw new Error("Sample interval must be 10–3600 seconds");
  if (!Number.isInteger(input.cameraIndex) || Number(input.cameraIndex) < 0 || Number(input.cameraIndex) > 16) throw new Error("Invalid camera index");
  if (!Array.isArray(input.mobileDeviceIds) || input.mobileDeviceIds.length > 32 || input.mobileDeviceIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid mobile devices");
  return { sources: Object.fromEntries(ALL_DAY_SOURCES.map(source => [source, input.sources![source]])) as AllDaySettings["sources"], intervalSeconds: input.intervalSeconds!, cameraIndex: input.cameraIndex!, mobileDeviceIds: [...new Set(input.mobileDeviceIds)] };
}
