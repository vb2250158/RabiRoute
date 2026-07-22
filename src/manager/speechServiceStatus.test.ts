import assert from "node:assert/strict";
import test from "node:test";
import { inspectLocalSpeechService, normalizeLocalSpeechServiceUrl } from "./speechServiceStatus.js";

test("speech status only accepts loopback service URLs", () => {
  assert.equal(normalizeLocalSpeechServiceUrl("http://127.0.0.1:8781/"), "http://127.0.0.1:8781");
  assert.equal(normalizeLocalSpeechServiceUrl("http://localhost:8781"), "http://localhost:8781");
  assert.throws(() => normalizeLocalSpeechServiceUrl("https://speech.example.test"), /回环地址/);
  assert.throws(() => normalizeLocalSpeechServiceUrl("file:///tmp/speech"), /HTTP/);
});

test("speech status exposes only normalized runtime capabilities", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({
        ok: true,
        service: "RabiSpeech",
        local_only: true,
        config: "C:/private/config.json",
        providers: {
          tts: { oumuq: { enabled: true, transport: "http", base_url: "http://127.0.0.1:8780", formats: ["wav"], voice_binding: "character" } },
          asr: { "faster-whisper": { enabled: true, model: "small", model_root: "C:/private/models", loaded: true, loaded_device: "cuda", preload: true, local_files_only: true, warmup_error: "", formats: ["wav", "mp3"] } },
          defaults: { tts: "oumuq", asr: "faster-whisper" }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      relay_safe: true,
      streaming: false,
      speaker_identity: {
        scope: "loopback-only",
        mode: "manual_record_label_binding",
        manual_binding: true,
        binding_scope: "record_speaker_label",
        aliases_are_metadata_only: true,
        diarization_labels_are_biometric_identity: false,
        stores_raw_enrollment_audio: false,
        voiceprint: { supported: false, experimental: false, reason: "No validated matcher." }
      }
    }), { status: 200 });
  }) as typeof fetch;

  const result = await inspectLocalSpeechService("http://127.0.0.1:8781", { fetchImpl });
  assert.equal(result.state, "online");
  assert.equal(result.providers.tts[0]?.id, "oumuq");
  assert.equal(result.providers.asr[0]?.model, "small");
  assert.equal(result.providers.asr[0]?.loadedDevice, "cuda");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.relaySafe, true);
  assert.equal(result.speakerIdentity?.manualBinding, true);
  assert.equal(result.speakerIdentity?.voiceprint.supported, false);
  assert.equal(result.speakerIdentity?.storesRawEnrollmentAudio, false);
});

test("speech status keeps offline state inspectable", async () => {
  const fetchImpl = (async () => { throw new Error("connect refused"); }) as typeof fetch;
  const result = await inspectLocalSpeechService("http://127.0.0.1:8781", { fetchImpl });
  assert.equal(result.state, "offline");
  assert.match(result.error || "", /connect refused/);
  assert.deepEqual(result.providers, { tts: [], asr: [] });
});
