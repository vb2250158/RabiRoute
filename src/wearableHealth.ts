import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const WEARABLE_HEALTH_DIR = "wearable-health";
export const WEARABLE_HEALTH_EVENTS_DIR = "events";
export const WEARABLE_HEALTH_STATE_FILE = "state.json";
export const WEARABLE_HEALTH_CONFIG_FILE = "config.json";

export type WearableHealthMetric = "heart_rate" | "sleep_session" | "sleep_stage" | "sleep_state";
export type WearableSleepState = "sleeping" | "awake" | "unknown";
export type WearableSleepStage = "awake" | "light" | "deep" | "rem" | "unknown";

export type WearableHealthSample = {
  schemaVersion: 1;
  id: string;
  eventId: string;
  metric: WearableHealthMetric;
  recordedAt: string;
  startAt: string;
  endAt?: string;
  value?: number;
  unit?: "bpm";
  sleepState?: WearableSleepState;
  sleepStage?: WearableSleepStage;
  source: string;
  sourceDeviceId: string;
  sourceDeviceName?: string;
  sourceDeviceKind: string;
  transport?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type WearableHealthPolicy = {
  enabled: boolean;
  heartRateHighBpm: number;
  heartRateLowBpm: number;
  heartRateAlertCooldownMinutes: number;
  sleepStateAlertEnabled: boolean;
  heartRateStaleAfterMinutes: number;
  sleepStateStaleAfterMinutes: number;
};

export type WearableHealthDeviceConfig = {
  sourceDeviceId: string;
  sourceDeviceName?: string;
  sourceDeviceKind: string;
  updatedAt: string;
  policy: WearableHealthPolicy;
};

export type WearableHealthConfig = {
  schemaVersion: 1;
  defaultPolicy: WearableHealthPolicy;
  devices: Record<string, WearableHealthDeviceConfig>;
  updatedAt: string;
};

export type WearableHealthAlert = {
  id: string;
  type: "heart_rate_high" | "heart_rate_low" | "sleep_state_changed";
  severity: "warning" | "urgent" | "info";
  message: string;
  ruleKey: string;
  createdAt: string;
  sample: WearableHealthSample;
};

export type WearableHealthState = {
  schemaVersion: 1;
  updatedAt: string;
  latestByMetric: Partial<Record<WearableHealthMetric, WearableHealthSample>>;
  recentSampleIds: string[];
  lastAlertAtByRule: Record<string, string>;
};

export type WearableHealthObservationInput = {
  eventId?: unknown;
  clientMessageId?: unknown;
  capturedAt?: unknown;
  source?: unknown;
  sourceDeviceId?: unknown;
  deviceId?: unknown;
  sourceDeviceName?: unknown;
  deviceName?: unknown;
  sourceDeviceKind?: unknown;
  deviceKind?: unknown;
  transport?: unknown;
  policy?: unknown;
  samples?: unknown;
};

export type WearableHealthIngestResult = {
  eventId: string;
  accepted: WearableHealthSample[];
  deduplicated: WearableHealthSample[];
  alerts: WearableHealthAlert[];
  policy: WearableHealthPolicy;
  state: WearableHealthCurrentState;
};

export type WearableHealthCurrentState = {
  updatedAt: string;
  sourceDeviceId?: string;
  latestHeartRate?: WearableHealthSample;
  heartRateStale: boolean;
  sleepState: WearableSleepState;
  sleepStateReason: string;
  sleepStateStale: boolean;
  latestSleepSession?: WearableHealthSample;
};

export type WearableHealthHistoryQuery = {
  metrics?: WearableHealthMetric[];
  sourceDeviceId?: string;
  from?: string | number | Date;
  to?: string | number | Date;
  limit?: number;
  order?: "asc" | "desc";
};

export type WearableHealthSummary = {
  from: string;
  to: string;
  sourceDeviceId?: string;
  heartRate: {
    count: number;
    min?: number;
    max?: number;
    average?: number;
    latest?: WearableHealthSample;
  };
  sleep: {
    state: WearableSleepState;
    stateReason: string;
    stateStale: boolean;
    sessionCount: number;
    totalSleepMinutes: number;
    latestSession?: WearableHealthSample;
  };
};

const defaultPolicy: WearableHealthPolicy = {
  enabled: true,
  heartRateHighBpm: 120,
  heartRateLowBpm: 0,
  heartRateAlertCooldownMinutes: 15,
  sleepStateAlertEnabled: false,
  heartRateStaleAfterMinutes: 15,
  sleepStateStaleAfterMinutes: 180
};

const metricValues = new Set<WearableHealthMetric>(["heart_rate", "sleep_session", "sleep_stage", "sleep_state"]);
const sleepStateValues = new Set<WearableSleepState>(["sleeping", "awake", "unknown"]);
const sleepStageValues = new Set<WearableSleepStage>(["awake", "light", "deep", "rem", "unknown"]);
const sensitiveMetadataKey = /(?:auth|token|secret|password|cookie|encrypt|beacon|irq|key)/i;
const maxRecentSampleIds = 2_000;

function wearableHealthRoot(roleDir: string): string {
  return path.join(path.resolve(roleDir), WEARABLE_HEALTH_DIR);
}

export function wearableHealthConfigPath(roleDir: string): string {
  return path.join(wearableHealthRoot(roleDir), WEARABLE_HEALTH_CONFIG_FILE);
}

export function wearableHealthStatePath(roleDir: string): string {
  return path.join(wearableHealthRoot(roleDir), WEARABLE_HEALTH_STATE_FILE);
}

export function wearableHealthEventsDir(roleDir: string): string {
  return path.join(wearableHealthRoot(roleDir), WEARABLE_HEALTH_EVENTS_DIR);
}

function optionalText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function shortIdentifier(value: unknown, fallback: string, maxLength = 128): string {
  const text = optionalText(value).slice(0, maxLength);
  return text || fallback;
}

function normalizedDeviceKind(value: unknown): string {
  const kind = optionalText(value).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(kind) ? kind : "wearable";
}

function finiteNumber(value: unknown): number | undefined {
  if (value === "" || value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = finiteNumber(value);
  return number == null ? fallback : Math.min(maximum, Math.max(minimum, number));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = optionalText(value).toLowerCase();
  if (text === "true" || text === "1" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "0" || text === "no" || text === "off") return false;
  return fallback;
}

function timestampMillis(value: unknown, fallback = Date.now()): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : fallback;
  const number = finiteNumber(value);
  if (number != null) {
    const milliseconds = Math.abs(number) < 10_000_000_000 ? number * 1000 : number;
    return Number.isFinite(milliseconds) ? milliseconds : fallback;
  }
  const parsed = Date.parse(optionalText(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoTime(value: unknown, fallback = Date.now()): string {
  return new Date(timestampMillis(value, fallback)).toISOString();
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function normalizePolicy(value: unknown, fallback: WearableHealthPolicy = defaultPolicy): WearableHealthPolicy {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof WearableHealthPolicy, unknown>>
    : {};
  return {
    enabled: booleanValue(raw.enabled, fallback.enabled),
    heartRateHighBpm: boundedNumber(raw.heartRateHighBpm, fallback.heartRateHighBpm, 40, 240),
    heartRateLowBpm: boundedNumber(raw.heartRateLowBpm, fallback.heartRateLowBpm, 0, 150),
    heartRateAlertCooldownMinutes: boundedNumber(raw.heartRateAlertCooldownMinutes, fallback.heartRateAlertCooldownMinutes, 1, 1_440),
    sleepStateAlertEnabled: booleanValue(raw.sleepStateAlertEnabled, fallback.sleepStateAlertEnabled),
    heartRateStaleAfterMinutes: boundedNumber(raw.heartRateStaleAfterMinutes, fallback.heartRateStaleAfterMinutes, 1, 1_440),
    sleepStateStaleAfterMinutes: boundedNumber(raw.sleepStateStaleAfterMinutes, fallback.sleepStateStaleAfterMinutes, 1, 2_880)
  };
}

export function readWearableHealthConfig(roleDir: string): WearableHealthConfig {
  const stored = readJson<Partial<WearableHealthConfig>>(wearableHealthConfigPath(roleDir));
  const devices: Record<string, WearableHealthDeviceConfig> = {};
  if (stored?.devices && typeof stored.devices === "object") {
    for (const [deviceId, value] of Object.entries(stored.devices)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Partial<WearableHealthDeviceConfig>;
      const sourceDeviceId = shortIdentifier(item.sourceDeviceId || deviceId, "unknown-wearable");
      devices[sourceDeviceId] = {
        sourceDeviceId,
        sourceDeviceName: optionalText(item.sourceDeviceName) || undefined,
        sourceDeviceKind: normalizedDeviceKind(item.sourceDeviceKind),
        updatedAt: isoTime(item.updatedAt),
        policy: normalizePolicy(item.policy, normalizePolicy(stored.defaultPolicy))
      };
    }
  }
  return {
    schemaVersion: 1,
    defaultPolicy: normalizePolicy(stored?.defaultPolicy),
    devices,
    updatedAt: isoTime(stored?.updatedAt)
  };
}

export function updateWearableHealthConfig(
  roleDir: string,
  patch: { defaultPolicy?: unknown; devices?: unknown }
): WearableHealthConfig {
  const current = readWearableHealthConfig(roleDir);
  const next: WearableHealthConfig = {
    ...current,
    defaultPolicy: patch.defaultPolicy === undefined
      ? current.defaultPolicy
      : normalizePolicy(patch.defaultPolicy, current.defaultPolicy),
    devices: { ...current.devices },
    updatedAt: new Date().toISOString()
  };
  if (patch.devices && typeof patch.devices === "object" && !Array.isArray(patch.devices)) {
    for (const [deviceId, value] of Object.entries(patch.devices as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      const sourceDeviceId = shortIdentifier(raw.sourceDeviceId || deviceId, "unknown-wearable");
      const previous = next.devices[sourceDeviceId];
      next.devices[sourceDeviceId] = {
        sourceDeviceId,
        sourceDeviceName: optionalText(raw.sourceDeviceName) || previous?.sourceDeviceName,
        sourceDeviceKind: normalizedDeviceKind(raw.sourceDeviceKind || previous?.sourceDeviceKind),
        updatedAt: next.updatedAt,
        policy: normalizePolicy(raw.policy ?? raw, previous?.policy ?? next.defaultPolicy)
      };
    }
  }
  writeJsonAtomic(wearableHealthConfigPath(roleDir), next);
  return next;
}

function policyForObservation(
  roleDir: string,
  sourceDeviceId: string,
  sourceDeviceName: string,
  sourceDeviceKind: string,
  value: unknown
): WearableHealthPolicy {
  const config = readWearableHealthConfig(roleDir);
  const previous = config.devices[sourceDeviceId];
  const policy = value === undefined
    ? previous?.policy ?? config.defaultPolicy
    : normalizePolicy(value, previous?.policy ?? config.defaultPolicy);
  if (value !== undefined || !previous) {
    updateWearableHealthConfig(roleDir, {
      devices: {
        [sourceDeviceId]: {
          sourceDeviceId,
          sourceDeviceName,
          sourceDeviceKind,
          policy
        }
      }
    });
  }
  return policy;
}

function normalizeMetric(value: unknown): WearableHealthMetric | undefined {
  const text = optionalText(value).toLowerCase().replace(/[.\s-]+/g, "_");
  const aliased = text === "heartrate" || text === "heart_rate_bpm" || text === "bpm"
    ? "heart_rate"
    : text === "sleep" || text === "sleep_record"
      ? "sleep_session"
      : text;
  return metricValues.has(aliased as WearableHealthMetric) ? aliased as WearableHealthMetric : undefined;
}

function publicMetadata(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
    if (sensitiveMetadataKey.test(key)) continue;
    if (typeof raw === "string") result[key.slice(0, 64)] = raw.slice(0, 256);
    else if (typeof raw === "number" && Number.isFinite(raw)) result[key.slice(0, 64)] = raw;
    else if (typeof raw === "boolean") result[key.slice(0, 64)] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function derivedSampleId(sample: Omit<WearableHealthSample, "id">): string {
  const identity = [
    sample.eventId,
    sample.metric,
    sample.sourceDeviceId,
    sample.startAt,
    sample.endAt || "",
    sample.value == null ? "" : String(sample.value),
    sample.sleepState || "",
    sample.sleepStage || "",
    sample.source
  ].join("\u0000");
  return `health-${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32)}`;
}

function normalizeSample(
  value: unknown,
  context: {
    eventId: string;
    capturedAt: number;
    source: string;
    sourceDeviceId: string;
    sourceDeviceName: string;
    sourceDeviceKind: string;
    transport: string;
  }
): WearableHealthSample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const metric = normalizeMetric(raw.metric ?? raw.type ?? raw.kind);
  if (!metric) return undefined;
  const recordedAt = isoTime(raw.recordedAt ?? raw.time ?? raw.timestamp ?? raw.startAt, context.capturedAt);
  const startAt = isoTime(raw.startAt ?? raw.startTime ?? raw.time ?? raw.timestamp, Date.parse(recordedAt));
  const endValue = raw.endAt ?? raw.endTime;
  const endAt = endValue == null || optionalText(endValue) === "" ? undefined : isoTime(endValue, Date.parse(startAt));
  const base: Omit<WearableHealthSample, "id"> = {
    schemaVersion: 1,
    eventId: context.eventId,
    metric,
    recordedAt,
    startAt,
    endAt,
    source: shortIdentifier(raw.source || context.source, "wearable", 64),
    sourceDeviceId: context.sourceDeviceId,
    sourceDeviceName: context.sourceDeviceName || undefined,
    sourceDeviceKind: context.sourceDeviceKind,
    transport: context.transport || undefined,
    metadata: publicMetadata(raw.metadata)
  };
  if (metric === "heart_rate") {
    const bpm = finiteNumber(raw.value ?? raw.bpm ?? raw.heartRateBpm);
    if (bpm == null || bpm < 1 || bpm > 300) return undefined;
    base.value = Math.round(bpm);
    base.unit = "bpm";
  } else if (metric === "sleep_state") {
    const state = optionalText(raw.sleepState ?? raw.state).toLowerCase();
    base.sleepState = sleepStateValues.has(state as WearableSleepState) ? state as WearableSleepState : "unknown";
  } else if (metric === "sleep_stage") {
    const stage = optionalText(raw.sleepStage ?? raw.stage).toLowerCase();
    base.sleepStage = sleepStageValues.has(stage as WearableSleepStage) ? stage as WearableSleepStage : "unknown";
  } else if (metric === "sleep_session") {
    const state = optionalText(raw.sleepState ?? raw.state).toLowerCase();
    if (state) base.sleepState = sleepStateValues.has(state as WearableSleepState) ? state as WearableSleepState : "unknown";
  }
  const explicitId = optionalText(raw.id ?? raw.sampleId);
  return {
    ...base,
    id: explicitId ? explicitId.slice(0, 160) : derivedSampleId(base)
  };
}

function emptyState(): WearableHealthState {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    latestByMetric: {},
    recentSampleIds: [],
    lastAlertAtByRule: {}
  };
}

export function readWearableHealthState(roleDir: string): WearableHealthState {
  const stored = readJson<Partial<WearableHealthState>>(wearableHealthStatePath(roleDir));
  if (!stored) return emptyState();
  return {
    schemaVersion: 1,
    updatedAt: isoTime(stored.updatedAt, 0),
    latestByMetric: stored.latestByMetric && typeof stored.latestByMetric === "object" ? stored.latestByMetric : {},
    recentSampleIds: Array.isArray(stored.recentSampleIds)
      ? stored.recentSampleIds.map(optionalText).filter(Boolean).slice(-maxRecentSampleIds)
      : [],
    lastAlertAtByRule: stored.lastAlertAtByRule && typeof stored.lastAlertAtByRule === "object"
      ? Object.fromEntries(Object.entries(stored.lastAlertAtByRule).map(([key, value]) => [key, optionalText(value)]).filter(([, value]) => Boolean(value)))
      : {}
  };
}

function eventFileName(sample: WearableHealthSample): string {
  return `${sample.startAt.slice(0, 10)}.jsonl`;
}

function appendSamples(roleDir: string, samples: WearableHealthSample[]): void {
  const byFile = new Map<string, WearableHealthSample[]>();
  for (const sample of samples) {
    const file = path.join(wearableHealthEventsDir(roleDir), eventFileName(sample));
    const bucket = byFile.get(file) ?? [];
    bucket.push(sample);
    byFile.set(file, bucket);
  }
  for (const [file, items] of byFile) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, items.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
  }
}

function sampleTime(sample: WearableHealthSample): number {
  return timestampMillis(sample.recordedAt, timestampMillis(sample.startAt));
}

function laterSample(left: WearableHealthSample | undefined, right: WearableHealthSample): WearableHealthSample {
  return !left || sampleTime(right) >= sampleTime(left) ? right : left;
}

function sleepStateFromSample(sample: WearableHealthSample | undefined, now = Date.now()): { state: WearableSleepState; reason: string } {
  if (!sample) return { state: "unknown", reason: "没有睡眠状态或睡眠时段记录。" };
  if (sample.metric === "sleep_state") {
    return { state: sample.sleepState ?? "unknown", reason: "来自最近一条睡眠状态记录。" };
  }
  if (sample.metric === "sleep_session") {
    const start = timestampMillis(sample.startAt);
    const end = sample.endAt ? timestampMillis(sample.endAt) : Number.POSITIVE_INFINITY;
    if (start <= now && now < end) return { state: "sleeping", reason: "当前时间位于最近睡眠时段内。" };
    if (end <= now) return { state: "awake", reason: "最近睡眠时段已经结束。" };
  }
  return { state: "unknown", reason: "最近睡眠记录不足以判断当前状态。" };
}

function isStale(sample: WearableHealthSample | undefined, afterMinutes: number, now = Date.now()): boolean {
  if (!sample) return true;
  return now - sampleTime(sample) > afterMinutes * 60 * 1000;
}

export function currentWearableHealthState(
  roleDir: string,
  sourceDeviceId = "",
  now = Date.now()
): WearableHealthCurrentState {
  const state = readWearableHealthState(roleDir);
  const config = readWearableHealthConfig(roleDir);
  const deviceId = optionalText(sourceDeviceId);
  const matches = (sample: WearableHealthSample | undefined): WearableHealthSample | undefined => (
    sample && (!deviceId || sample.sourceDeviceId === deviceId) ? sample : undefined
  );
  let latestHeartRate = matches(state.latestByMetric.heart_rate);
  let latestSleepSession = matches(state.latestByMetric.sleep_session);
  let latestSleepState = matches(state.latestByMetric.sleep_state);
  if (deviceId && (!latestHeartRate || !latestSleepSession || !latestSleepState)) {
    const fallback = queryWearableHealthHistory(roleDir, { sourceDeviceId: deviceId, limit: 1_000, order: "desc" });
    latestHeartRate ??= fallback.find((sample) => sample.metric === "heart_rate");
    latestSleepSession ??= fallback.find((sample) => sample.metric === "sleep_session");
    latestSleepState ??= fallback.find((sample) => sample.metric === "sleep_state");
  }
  const sleepSource = latestSleepState
    ? laterSample(latestSleepSession, latestSleepState)
    : latestSleepSession;
  const policy = config.devices[deviceId || latestHeartRate?.sourceDeviceId || sleepSource?.sourceDeviceId || ""]?.policy ?? config.defaultPolicy;
  const sleep = sleepStateFromSample(sleepSource, now);
  return {
    updatedAt: state.updatedAt,
    sourceDeviceId: deviceId || latestHeartRate?.sourceDeviceId || sleepSource?.sourceDeviceId,
    latestHeartRate,
    heartRateStale: isStale(latestHeartRate, policy.heartRateStaleAfterMinutes, now),
    sleepState: sleep.state,
    sleepStateReason: sleep.reason,
    sleepStateStale: isStale(sleepSource, policy.sleepStateStaleAfterMinutes, now),
    latestSleepSession
  };
}

function alertAllowed(state: WearableHealthState, ruleKey: string, cooldownMinutes: number, now: number): boolean {
  const previous = Date.parse(state.lastAlertAtByRule[ruleKey] || "");
  return !Number.isFinite(previous) || now - previous >= cooldownMinutes * 60 * 1000;
}

function createHeartRateAlert(
  type: "heart_rate_high" | "heart_rate_low",
  sample: WearableHealthSample,
  threshold: number,
  now: number
): WearableHealthAlert {
  const high = type === "heart_rate_high";
  const value = sample.value ?? 0;
  return {
    id: `health-alert-${randomUUID()}`,
    type,
    severity: high && value >= threshold + 20 ? "urgent" : "warning",
    message: high
      ? `用户心率过快，达到 ${value} bpm（阈值 ${threshold} bpm）。`
      : `用户心率过低，降到 ${value} bpm（阈值 ${threshold} bpm）。`,
    ruleKey: `${sample.sourceDeviceId}:${type}`,
    createdAt: new Date(now).toISOString(),
    sample
  };
}

function evaluateAlerts(
  accepted: WearableHealthSample[],
  previous: WearableHealthState,
  policy: WearableHealthPolicy,
  now: number
): WearableHealthAlert[] {
  if (!policy.enabled) return [];
  const alerts: WearableHealthAlert[] = [];
  const heartRates = accepted.filter((sample) => sample.metric === "heart_rate" && sample.value != null);
  const highest = heartRates.reduce<WearableHealthSample | undefined>((result, sample) => !result || (sample.value ?? 0) > (result.value ?? 0) ? sample : result, undefined);
  if (highest && (highest.value ?? 0) >= policy.heartRateHighBpm) {
    const ruleKey = `${highest.sourceDeviceId}:heart_rate_high`;
    if (alertAllowed(previous, ruleKey, policy.heartRateAlertCooldownMinutes, now)) {
      alerts.push(createHeartRateAlert("heart_rate_high", highest, policy.heartRateHighBpm, now));
    }
  }
  const lowest = heartRates.reduce<WearableHealthSample | undefined>((result, sample) => !result || (sample.value ?? 0) < (result.value ?? 0) ? sample : result, undefined);
  if (policy.heartRateLowBpm > 0 && lowest && (lowest.value ?? 0) <= policy.heartRateLowBpm) {
    const ruleKey = `${lowest.sourceDeviceId}:heart_rate_low`;
    if (alertAllowed(previous, ruleKey, policy.heartRateAlertCooldownMinutes, now)) {
      alerts.push(createHeartRateAlert("heart_rate_low", lowest, policy.heartRateLowBpm, now));
    }
  }
  if (policy.sleepStateAlertEnabled) {
    const sleepSamples = accepted.filter((sample) => sample.metric === "sleep_state" && sample.sleepState && sample.sleepState !== "unknown");
    const latest = sleepSamples.reduce<WearableHealthSample | undefined>((result, sample) => laterSample(result, sample), undefined);
    const prior = previous.latestByMetric.sleep_state;
    if (latest?.sleepState && prior?.sleepState && latest.sleepState !== prior.sleepState) {
      const ruleKey = `${latest.sourceDeviceId}:sleep_state_changed:${latest.sleepState}`;
      if (alertAllowed(previous, ruleKey, 1, now)) {
        alerts.push({
          id: `health-alert-${randomUUID()}`,
          type: "sleep_state_changed",
          severity: "info",
          message: latest.sleepState === "sleeping" ? "用户刚刚进入睡眠。" : "用户已经醒来。",
          ruleKey,
          createdAt: new Date(now).toISOString(),
          sample: latest
        });
      }
    }
  }
  return alerts;
}

export function ingestWearableHealthObservation(
  roleDir: string,
  input: WearableHealthObservationInput,
  options: { now?: number } = {}
): WearableHealthIngestResult {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sourceDeviceId = shortIdentifier(input.sourceDeviceId ?? input.deviceId, "unknown-wearable");
  const sourceDeviceName = shortIdentifier(input.sourceDeviceName ?? input.deviceName, "", 128);
  const sourceDeviceKind = normalizedDeviceKind(input.sourceDeviceKind ?? input.deviceKind);
  const transport = shortIdentifier(input.transport, "rabilink", 48).toLowerCase();
  const source = shortIdentifier(input.source, "rabilink-wearable", 64);
  const capturedAt = timestampMillis(input.capturedAt, now);
  const eventId = shortIdentifier(input.eventId ?? input.clientMessageId, `health-event-${randomUUID()}`, 160);
  const rawSamples = Array.isArray(input.samples) ? input.samples.slice(0, 10_000) : [];
  const normalized = rawSamples.flatMap((sample) => {
    const value = normalizeSample(sample, {
      eventId,
      capturedAt,
      source,
      sourceDeviceId,
      sourceDeviceName,
      sourceDeviceKind,
      transport
    });
    return value ? [value] : [];
  });
  if (normalized.length === 0) throw new Error("Wearable health observation has no valid samples.");

  const policy = policyForObservation(roleDir, sourceDeviceId, sourceDeviceName, sourceDeviceKind, input.policy);
  const previous = readWearableHealthState(roleDir);
  const known = new Set(previous.recentSampleIds);
  const accepted: WearableHealthSample[] = [];
  const deduplicated: WearableHealthSample[] = [];
  for (const sample of normalized) {
    if (known.has(sample.id)) {
      deduplicated.push(sample);
      continue;
    }
    known.add(sample.id);
    accepted.push(sample);
  }
  if (accepted.length > 0) appendSamples(roleDir, accepted);
  const alerts = evaluateAlerts(accepted, previous, policy, now);
  const next: WearableHealthState = {
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    latestByMetric: { ...previous.latestByMetric },
    recentSampleIds: [...previous.recentSampleIds, ...accepted.map((sample) => sample.id)].slice(-maxRecentSampleIds),
    lastAlertAtByRule: { ...previous.lastAlertAtByRule }
  };
  for (const sample of accepted) next.latestByMetric[sample.metric] = laterSample(next.latestByMetric[sample.metric], sample);
  for (const alert of alerts) next.lastAlertAtByRule[alert.ruleKey] = alert.createdAt;
  writeJsonAtomic(wearableHealthStatePath(roleDir), next);
  return {
    eventId,
    accepted,
    deduplicated,
    alerts,
    policy,
    state: currentWearableHealthState(roleDir, sourceDeviceId, now)
  };
}

function parseEventFile(filePath: string): WearableHealthSample[] {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as WearableHealthSample;
          return value && metricValues.has(value.metric) && typeof value.id === "string" ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function queryTime(value: string | number | Date | undefined, fallback: number): number {
  return value == null || value === "" ? fallback : timestampMillis(value, fallback);
}

export function queryWearableHealthHistory(roleDir: string, query: WearableHealthHistoryQuery = {}): WearableHealthSample[] {
  const from = queryTime(query.from, 0);
  const to = queryTime(query.to, Date.now());
  const limit = Math.min(10_000, Math.max(1, Math.floor(Number(query.limit) || 500)));
  const metrics = query.metrics?.length ? new Set(query.metrics.filter((metric) => metricValues.has(metric))) : undefined;
  const deviceId = optionalText(query.sourceDeviceId);
  const dir = wearableHealthEventsDir(roleDir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item.name))
    .map((item) => path.join(dir, item.name));
  const items = files.flatMap(parseEventFile).filter((sample) => {
    const time = sampleTime(sample);
    return time >= from
      && time <= to
      && (!metrics || metrics.has(sample.metric))
      && (!deviceId || sample.sourceDeviceId === deviceId);
  });
  items.sort((left, right) => sampleTime(left) - sampleTime(right) || left.id.localeCompare(right.id));
  if (query.order !== "asc") items.reverse();
  return items.slice(0, limit);
}

export function summarizeWearableHealth(
  roleDir: string,
  query: Omit<WearableHealthHistoryQuery, "metrics" | "order"> = {}
): WearableHealthSummary {
  const toMs = queryTime(query.to, Date.now());
  const fromMs = queryTime(query.from, toMs - 24 * 60 * 60 * 1000);
  const history = queryWearableHealthHistory(roleDir, {
    ...query,
    from: fromMs,
    to: toMs,
    limit: Math.min(10_000, Math.max(Number(query.limit) || 10_000, 1)),
    order: "asc"
  });
  const heartRates = history.filter((sample) => sample.metric === "heart_rate" && sample.value != null);
  const values = heartRates.map((sample) => sample.value as number);
  const sessions = history.filter((sample) => sample.metric === "sleep_session");
  const totalSleepMinutes = sessions.reduce((total, sample) => {
    if (!sample.endAt) return total;
    return total + Math.max(0, timestampMillis(sample.endAt) - timestampMillis(sample.startAt)) / 60_000;
  }, 0);
  const current = currentWearableHealthState(roleDir, optionalText(query.sourceDeviceId), toMs);
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    sourceDeviceId: optionalText(query.sourceDeviceId) || undefined,
    heartRate: {
      count: values.length,
      min: values.length ? Math.min(...values) : undefined,
      max: values.length ? Math.max(...values) : undefined,
      average: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : undefined,
      latest: current.latestHeartRate
    },
    sleep: {
      state: current.sleepState,
      stateReason: current.sleepStateReason,
      stateStale: current.sleepStateStale,
      sessionCount: sessions.length,
      totalSleepMinutes: Math.round(totalSleepMinutes),
      latestSession: current.latestSleepSession
    }
  };
}
