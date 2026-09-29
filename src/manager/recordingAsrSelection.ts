import { createHash } from "node:crypto";

/** Must read raw JSON from one fixed, trusted loopback RabiSpeech instance.
 * The caller owns URL validation, timeouts and generation fencing. Never inject a
 * peer/phone-selected endpoint or a transport envelope ({status,data}) here.
 */
export type RecordingAsrSelectionDependencies = {
  readJson(path: "/v1/microphone/status" | "/v1/models" | "/v1/capabilities"): Promise<unknown>;
};
export type EffectiveAsrSelection = {
  provider: string;
  /** Canonical request model ID from /v1/models, including provider prefix. */
  model: string;
  language: string | null;
  prompt: string | null;
  selectionSource: "pc-microphone-config";
  /** Content fingerprint, NOT an official configuration revision. */
  configFingerprint: string;
};
export type AsrSelectionResult = ({ ok: true } & EffectiveAsrSelection) | {
  ok: false;
  code: "blocked_model_configuration";
  reason: "invalid_config" | "invalid_catalog" | "ambiguous_model" | "model_unavailable" | "configuration_changed" | "read_failed";
};
type Row = Record<string, unknown>;
type Config = { requestedModel: string; language: string | null; prompt: string | null };
const object = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const blocked = (reason: Extract<AsrSelectionResult, { ok: false }>["reason"]): AsrSelectionResult => ({ ok: false, code: "blocked_model_configuration", reason });
function config(value: unknown): Config | undefined {
  const c = object(object(value)?.config);
  if (!c) return undefined;
  const model = c.asr_model ?? c.asrModel;
  if (!text(model) || model.length > 200) return undefined;
  if (c.asr_model !== undefined && c.asrModel !== undefined && c.asr_model !== c.asrModel) return undefined;
  if (!(c.language === null || typeof c.language === "string") || !(c.prompt === null || typeof c.prompt === "string")) return undefined;
  if ((c.language?.length ?? 0) > 100 || (c.prompt?.length ?? 0) > 10000) return undefined;
  return { requestedModel: model.trim(), language: c.language, prompt: c.prompt };
}
const fingerprint = (c: Config) => createHash("sha256").update(JSON.stringify({ language: c.language, prompt: c.prompt, requestedModel: c.requestedModel })).digest("hex");

function select(c: Config, catalog: unknown, capabilities: unknown): AsrSelectionResult {
  const raw = object(catalog)?.data;
  if (!Array.isArray(raw)) return blocked("invalid_catalog");
  const rows = raw.map(object).filter((r): r is Row => !!r && r.capability === "asr");
  const aliases = new Set(["default", "asr-local", "asr-api", "whisper-1"]);
  let candidates: Row[];
  if (!aliases.has(c.requestedModel)) {
    candidates = rows.filter(r => r.id === c.requestedModel);
    // Bare concrete model names are supported only when unambiguous across providers.
    if (!candidates.length && !c.requestedModel.includes("/")) candidates = rows.filter(r => r.model === c.requestedModel);
  } else {
    // `default` on model rows denotes the default PROVIDER, not its selected model.
    const providers = object(object(capabilities)?.providers);
    const providerId = object(providers?.defaults)?.asr;
    const detail = text(providerId) ? object(object(providers?.asr)?.[providerId]) : undefined;
    if (!text(providerId) || !text(detail?.model)) return blocked("ambiguous_model");
    candidates = rows.filter(r => r.provider === providerId && r.model === detail.model);
  }
  if (candidates.length !== 1) return blocked("ambiguous_model");
  const row = candidates[0]!;
  if (!text(row.provider) || !text(row.model) || row.id !== `${row.provider}/${row.model}`) return blocked("invalid_catalog");
  if (row.installed !== true || row.enabled !== true || row.available !== true) return blocked("model_unavailable");
  return { ok: true, provider: row.provider, model: row.id as string, language: c.language, prompt: c.prompt,
    selectionSource: "pc-microphone-config", configFingerprint: fingerprint(c) };
}

/** No phone settings enter this resolver. One retry bounds concurrent PC config changes. */
export async function resolveEffectiveAsrSelection(dependencies: RecordingAsrSelectionDependencies): Promise<AsrSelectionResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = config(await dependencies.readJson("/v1/microphone/status"));
      if (!before) return blocked("invalid_config");
      const catalog = await dependencies.readJson("/v1/models");
      const capabilities = await dependencies.readJson("/v1/capabilities");
      const after = config(await dependencies.readJson("/v1/microphone/status"));
      if (!after) return blocked("invalid_config");
      if (fingerprint(before) !== fingerprint(after)) continue;
      return select(before, catalog, capabilities);
    }
    return blocked("configuration_changed");
  } catch { return blocked("read_failed"); }
}
