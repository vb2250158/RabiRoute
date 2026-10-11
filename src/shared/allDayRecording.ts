export const ALL_DAY_CAPTURE_SOURCES = ["microphone", "screen", "window", "camera"] as const;
export const ALL_DAY_SOURCES = [...ALL_DAY_CAPTURE_SOURCES, "homeAssistant"] as const;
export type AllDaySource = typeof ALL_DAY_SOURCES[number];
export type AllDaySettings = {
  sources: Record<AllDaySource, boolean>;
  intervalSeconds: number;
  cameraIndex: number;
  mobileDeviceIds: string[];
};
export const DEFAULT_ALL_DAY_SETTINGS: AllDaySettings = {
  sources: { microphone: false, screen: false, window: false, camera: false, homeAssistant: false },
  intervalSeconds: 60, cameraIndex: 0, mobileDeviceIds: []
};
export type AllDayEvent = {
  id: string;
  startedAt: number;
  endedAt: number;
  source: AllDaySource | "mobile" | "session";
  deviceId: string;
  kind: "audio" | "image" | "window" | "status" | "device";
  text: string;
  state: "saved" | "error";
  transcriptionState?: "pending" | "processing" | "ready" | "empty" | "error";
  media?: string;
  speechRecordId?: string;
  mobileMedia?: { owner: string; chunks: string[] };
  homeAssistant?: { eventKind: string; resourceName: string; entityId?: string; domain?: string; state?: string };
};
export type AllDaySnapshot = {
  enabled?: boolean;
  sourceErrors?: Partial<Record<AllDaySource, string>>;
  settings: AllDaySettings;
  running: boolean;
  preparing?: boolean;
  activeRoleId: string | null;
  startedAt: number | null;
  lastSampleAt: number | null;
  error: string;
};
export type AllDayHealth = "off" | "waiting" | "preparing" | "starting" | "recording" | "degraded" | "failed" | "stale";
export function allDayRecordingHealth(snapshot: AllDaySnapshot, now: number): AllDayHealth {
  if (!snapshot.running) return snapshot.enabled ? "waiting" : "off";
  if (snapshot.preparing) return "preparing";
  const sources = ALL_DAY_SOURCES.filter(source => snapshot.settings.sources[source]);
  const failedSources = sources.filter(source => snapshot.sourceErrors?.[source]);
  if (snapshot.error && (!snapshot.lastSampleAt || failedSources.length === sources.length || !failedSources.length)) return "failed";
  if (snapshot.error || failedSources.length) return "degraded";
  if (!ALL_DAY_CAPTURE_SOURCES.some(source => snapshot.settings.sources[source])) return "waiting";
  if (snapshot.lastSampleAt === null) return "starting";
  return now - snapshot.lastSampleAt > Math.max(30_000, snapshot.settings.intervalSeconds * 2_000) ? "stale" : "recording";
}
/** Derived history metadata can be displayed while interrupted indexes recover. */
export type AllDayCatalog = {
  events: AllDayEvent[];
  days: string[];
  incompleteDays: string[];
  loading?: boolean;
  pendingDays?: string[];
  readError?: string;
};
/** Raw audio stays durable; only recognized speech belongs in the review event stream. */
export function isReviewEvent(event: AllDayEvent): boolean {
  return event.kind !== "audio" || ((event.transcriptionState === undefined || event.transcriptionState === "ready") && !!event.text?.trim());
}
export function matchesReviewType(event: AllDayEvent, type: string): boolean {
  return isReviewEvent(event) && (type === "all" || (type === "asr" ? event.kind === "audio" : event.kind === type));
}
export function normalizeAllDaySettings(value: unknown): AllDaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recording settings");
  const input = value as Partial<AllDaySettings>;
  if (!input.sources || ALL_DAY_CAPTURE_SOURCES.some(source => typeof input.sources?.[source] !== "boolean")) throw new Error("Select recording sources");
  // Existing settings remain valid until saved through the current settings owner.
  if (input.sources.homeAssistant !== undefined && typeof input.sources.homeAssistant !== "boolean") throw new Error("Invalid Home Assistant recording source");
  if (!Number.isInteger(input.intervalSeconds) || Number(input.intervalSeconds) < 10 || Number(input.intervalSeconds) > 3600) throw new Error("Sample interval must be 10–3600 seconds");
  if (!Number.isInteger(input.cameraIndex) || Number(input.cameraIndex) < 0 || Number(input.cameraIndex) > 16) throw new Error("Invalid camera index");
  if (!Array.isArray(input.mobileDeviceIds) || input.mobileDeviceIds.length > 32 || input.mobileDeviceIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("Invalid mobile devices");
  return { sources: Object.fromEntries(ALL_DAY_SOURCES.map(source => [source, input.sources![source] ?? false])) as AllDaySettings["sources"], intervalSeconds: input.intervalSeconds!, cameraIndex: input.cameraIndex!, mobileDeviceIds: [...new Set(input.mobileDeviceIds)] };
}
