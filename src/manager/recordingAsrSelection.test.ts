import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveAsrSelection } from "./recordingAsrSelection.js";
const row = (model: string, extra = {}) => ({ id: `engine/${model}`, provider: "engine", model, capability: "asr", installed: true, enabled: true, available: true, default: true, ...extra });
const mic = (model = "engine/quality", extra = {}) => ({ config: { asr_model: model, language: "zh", prompt: null, ...extra } });
function fixture(configs: unknown[] = [mic()], models: unknown[] = [row("compact"), row("quality")], caps: unknown = { providers: { defaults: { asr: "engine" }, asr: { engine: { model: "compact" } } } }) {
  let reads = 0;
  return { get reads() { return reads; }, readJson: async (path: string) => {
    if (path === "/v1/models") return { data: models };
    if (path === "/v1/capabilities") return caps;
    return configs[Math.min(reads++, configs.length - 1)];
  } };
}
test("explicit PC model wins over different provider default", async () => {
  const result = await resolveEffectiveAsrSelection(fixture());
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.model, "engine/quality"); assert.equal(result.selectionSource, "pc-microphone-config"); assert.match(result.configFingerprint, /^[a-f0-9]{64}$/); }
});
test("uninstalled explicit model never falls back", async () => {
  assert.deepEqual(await resolveEffectiveAsrSelection(fixture([mic()], [row("quality", { installed: false }), row("compact")])), { ok: false, code: "blocked_model_configuration", reason: "model_unavailable" });
});
test("missing config and readiness fields fail closed", async () => {
  for (const value of [{}, { config: { asr_model: "engine/quality" } }, mic("engine/quality", { language: 7 }), mic("engine/quality", { asrModel: "other" })]) {
    assert.equal((await resolveEffectiveAsrSelection(fixture([value]))).ok, false);
  }
  const r = row("quality"); delete (r as Record<string, unknown>).available;
  assert.equal((await resolveEffectiveAsrSelection(fixture([mic()], [r]))).ok, false);
});
test("alias resolves only the capability default model, not all default provider rows", async () => {
  const result = await resolveEffectiveAsrSelection(fixture([mic("asr-local")]));
  assert.ok(result.ok); if (result.ok) assert.equal(result.model, "engine/compact");
  assert.equal((await resolveEffectiveAsrSelection(fixture([mic("default")], [row("quality")], {}))).ok, false);
});
test("duplicate or bare ambiguous models fail closed", async () => {
  assert.equal((await resolveEffectiveAsrSelection(fixture([mic()], [row("quality"), row("quality")]))).ok, false);
  assert.equal((await resolveEffectiveAsrSelection(fixture([mic("quality")], [row("quality"), row("quality", { provider: "other", id: "other/quality" })]))).ok, false);
});
test("configuration change retries once and selects consistent newer snapshot", async () => {
  const f = fixture([mic(), mic("engine/compact"), mic("engine/compact"), mic("engine/compact")]);
  const result = await resolveEffectiveAsrSelection(f);
  assert.ok(result.ok); if (result.ok) assert.equal(result.model, "engine/compact");
  assert.equal(f.reads, 4);
});
test("continual config changes block after four microphone reads", async () => {
  const f = fixture([mic(), mic("engine/compact"), mic(), mic("engine/compact")]);
  assert.deepEqual(await resolveEffectiveAsrSelection(f), { ok: false, code: "blocked_model_configuration", reason: "configuration_changed" });
  assert.equal(f.reads, 4);
});
test("fingerprint ignores key order and snake/camel spelling, includes prompt", async () => {
  const a = await resolveEffectiveAsrSelection(fixture());
  const b = await resolveEffectiveAsrSelection(fixture([{ config: { prompt: null, language: "zh", asrModel: "engine/quality" } }]));
  const c = await resolveEffectiveAsrSelection(fixture([mic("engine/quality", { prompt: "context" })]));
  assert.ok(a.ok && b.ok && c.ok);
  if (a.ok && b.ok && c.ok) { assert.equal(a.configFingerprint, b.configFingerprint); assert.notEqual(a.configFingerprint, c.configFingerprint); }
});
test("read failure is structured and does not leak errors", async () => {
  assert.deepEqual(await resolveEffectiveAsrSelection({ readJson: async () => { throw new Error("secret"); } }), { ok: false, code: "blocked_model_configuration", reason: "read_failed" });
});
