export type SpeechProviderStatus = {
  id: string;
  kind: "tts" | "asr";
  enabled: boolean;
  model?: string;
  transport?: string;
  formats: string[];
  voiceBinding?: string;
  loaded?: boolean;
  loadedDevice?: string;
  preload?: boolean;
  localFilesOnly?: boolean;
  warmupError?: string;
};

export type SpeechServiceStatus = {
  state: "online" | "offline" | "invalid";
  checkedAt: string;
  configuredUrl: string;
  latencyMs?: number;
  service?: string;
  localOnly?: boolean;
  relaySafe?: boolean;
  streaming?: boolean;
  defaults: { tts?: string; asr?: string };
  providers: { tts: SpeechProviderStatus[]; asr: SpeechProviderStatus[] };
  error?: string;
};

import { normalizeLocalSpeechServiceUrl } from "../speech/localSpeechClient.js";
export { normalizeLocalSpeechServiceUrl } from "../speech/localSpeechClient.js";

type FetchLike = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeProvider(id: string, kind: "tts" | "asr", value: unknown): SpeechProviderStatus {
  const detail = asRecord(value);
  const status: SpeechProviderStatus = {
    id,
    kind,
    enabled: detail.enabled !== false,
    formats: stringArray(detail.formats)
  };
  if (typeof detail.model === "string" && detail.model.trim()) status.model = detail.model.trim();
  if (typeof detail.transport === "string" && detail.transport.trim()) status.transport = detail.transport.trim();
  if (typeof detail.voice_binding === "string" && detail.voice_binding.trim()) status.voiceBinding = detail.voice_binding.trim();
  if (typeof detail.loaded === "boolean") status.loaded = detail.loaded;
  if (typeof detail.loaded_device === "string" && detail.loaded_device.trim()) status.loadedDevice = detail.loaded_device.trim();
  if (typeof detail.preload === "boolean") status.preload = detail.preload;
  if (typeof detail.local_files_only === "boolean") status.localFilesOnly = detail.local_files_only;
  if (typeof detail.warmup_error === "string") status.warmupError = detail.warmup_error.trim();
  return status;
}

function providerRows(value: unknown, kind: "tts" | "asr"): SpeechProviderStatus[] {
  return Object.entries(asRecord(value))
    .map(([id, detail]) => normalizeProvider(id, kind, detail))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function requestJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return asRecord(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLocalSpeechService(
  configuredUrl: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<SpeechServiceStatus> {
  const checkedAt = new Date().toISOString();
  const empty = { tts: [] as SpeechProviderStatus[], asr: [] as SpeechProviderStatus[] };
  let baseUrl: string;
  try {
    baseUrl = normalizeLocalSpeechServiceUrl(configuredUrl);
  } catch (error) {
    return {
      state: "invalid",
      checkedAt,
      configuredUrl: String(configuredUrl || ""),
      defaults: {},
      providers: empty,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = performance.now();
  try {
    const health = await requestJson(fetchImpl, `${baseUrl}/health`, options.timeoutMs ?? 5000);
    let capabilities: Record<string, unknown> = {};
    try {
      capabilities = await requestJson(fetchImpl, `${baseUrl}/v1/capabilities`, options.timeoutMs ?? 5000);
    } catch {
      // Older RabiSpeech versions expose the same provider data from /health.
    }
    const providers = asRecord(health.providers || capabilities.providers);
    const defaults = asRecord(providers.defaults);
    return {
      state: "online",
      checkedAt,
      configuredUrl: baseUrl,
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      service: typeof health.service === "string" ? health.service : "RabiSpeech",
      localOnly: health.local_only === true,
      relaySafe: capabilities.relay_safe === true,
      streaming: capabilities.streaming === true,
      defaults: {
        tts: typeof defaults.tts === "string" ? defaults.tts : undefined,
        asr: typeof defaults.asr === "string" ? defaults.asr : undefined
      },
      providers: {
        tts: providerRows(providers.tts, "tts"),
        asr: providerRows(providers.asr, "asr")
      }
    };
  } catch (error) {
    return {
      state: "offline",
      checkedAt,
      configuredUrl: baseUrl,
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      defaults: {},
      providers: empty,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
