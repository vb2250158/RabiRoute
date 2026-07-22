<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiSpeech plugin

RabiSpeech is Rabi's independent host-local service plugin and a TTS/ASR provider gateway bound to loopback by default. Ordinary manual speech APIs do not enter an Agent or pass through message routing. Whenever the resident microphone completes an ASR segment, Manager broadcasts the same text to every Route whose speech endpoint is enabled, and each Route independently applies hot delivery or persona-keyword policy:

- RabiSpeech directly manages local ONNX-VITS, GPT-SoVITS, IndexTTS2, Qwen3-TTS, and CosyVoice3 TTS workers.
- Local ASR support includes faster-whisper, Qwen3-ASR, SenseVoiceSmall, and FireRedASR2.
- A Rabi persona owns its reference audio, voice index, and caches under `data/roles/<RoleId>/voice/`. Use the persona directory name as `voice`; no Route or Agent is required.
- Playback from every model, persona, Route, session, and Agent shares one host-wide FIFO.
- RabiLink Relay proxies raw HTTP requests and responses without interpreting personas, voices, or transcript content.

## Install and start

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\start.ps1
```

Register the plugin as a local service that starts when the current user signs in:

```powershell
.\scripts\install-service.ps1 -StartNow
```

The scheduled task runs as the current user so it can read plugins and models stored on a NAS. It does not use SYSTEM privileges or change the `127.0.0.1` listening boundary.

The default address is `http://127.0.0.1:8781`. On first start, `config.example.json` is copied to the machine-local `config.json`, which is not committed to Git.

On Windows, the installer places NVIDIA's official CUDA 12 cuBLAS and cuDNN 9 Python wheels in the plugin-private `.deps` directory. Startup adds only those wheel `bin` directories to the RabiSpeech process PATH and does not change the system CUDA PATH. If a DLL or GPU runtime is unavailable, ASR records the capability state and falls back to CPU.

When RabiLink relay is enabled, any HTTP client with an application token can call:

```text
https://<relay>/api/rabilink/speech/v1/audio/speech
https://<relay>/api/rabilink/speech/v1/audio/transcriptions
```

The caller receives the final audio or transcript for that request and does not need to understand the PC's internal claim queue. OpenAPI is available at `https://<relay>/api/rabilink/speech/openapi.json`.

## API

Common compatibility surface:

```text
GET  /health
GET  /v1/models
GET  /v1/models/{provider}/{model}
GET  /v1/capabilities
GET  /v1/records
GET  /v1/speaker-profiles
PUT  /v1/speaker-identities
PUT  /v1/speaker-bindings
GET  /v1/microphone/status
GET  /v1/microphone/devices
POST /v1/audio/speech
POST /v1/audio/transcriptions
POST /v1/microphone/start
PUT  /v1/microphone/settings
POST /v1/microphone/stop
GET  /v1/playback/status
PUT  /v1/playback/settings
POST /v1/playback/stop
```

`/v1/microphone/*` is the host device control plane. It is available only to loopback RabiPC/Manager and is not included in the public RabiLink speech allowlist. After startup, the RabiSpeech process owns the capture stream; closing the browser does not stop it. `microphone.json` persists the host device, thresholds, ASR model, and internal session; a legacy `route_id` migrates to `null`. Manager reconciles capture from Route subscriptions: any subscription keeps listening active, and the microphone stops only after the last subscription is disabled. Runtime settings can be updated through `PUT /v1/microphone/settings`, which restores listening automatically.

LAN remote audio is a separate network sound-card channel. When `remote_audio` is enabled, the lightweight Windows client continuously uploads 16 kHz mono PCM over TCP `8782` and receives WAV files from the host FIFO; UDP `8783` is discovery-only. The client never performs VAD, segmentation, ASR, TTS, or Route delivery. Loopback endpoints `GET /v1/audio-streams` and `PUT /v1/audio-streams/selection` own the selection, which defaults to local and never silently falls back after a remote disconnect. See [`../../desktop/rabi-voice-client/README_en.md`](../../desktop/rabi-voice-client/README_en.md). RabiLink is not a configuration dependency for this LAN path.

`PUT /v1/playback/settings` is also loopback-only and accepts `{"volume": 0..100}`. This is the single host playback volume, persisted in the Git-ignored `output/playback-settings.json`, rather than a Route or persona setting; each FIFO item freezes the value when it begins playback. Windows playback uses SoundFile / PortAudio so streamed WAV headers are decoded using the actual audio data. Windows 11 Volume Mixer uses the process image for application identity, so `scripts/install.ps1` builds and `scripts/start.ps1` prefers `runtime/RabiSpeech.exe` with RabiSpeech product resources. At service startup, RabiSpeech opens a persistent silent shared-mode render session, resets a stale `1%` multiplier to `100%` once, and then keeps the session alive without rewriting its volume. The Windows mixer slider stays adjustable. Silent keepalive audio does not enter the FIFO or trigger microphone feedback suppression.

DashScope-compatible surface:

```text
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

TTS example:

```powershell
$body = @{
  model = "local-tts/gpt-sovits"
  input = "This is the local speech service."
  voice = "Rabi"
  response_format = "wav"
  speed = 1.0
  play = $false
} | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8781/v1/audio/speech `
  -ContentType "application/json" -Body $body -OutFile .\output.wav
```

ASR example:

```powershell
curl.exe -X POST http://127.0.0.1:8781/v1/audio/transcriptions `
  -F "file=@sample.wav" -F "model=asr-local" -F "response_format=verbose_json"
```

To preserve local privacy, the DashScope-style ASR endpoint accepts only `data:audio/...;base64,...` and does not download arbitrary public URLs for the caller.

## Speech records and TTS cache

`GET /v1/records` queries date-persisted ASR/TTS text metadata and supports filters for `kind`, `session_id`, `route_id`, and time windows. Text records and finalized-audio caches are independent; passing the audio retention window does not delete the text record.

Finalized TTS audio for a resolved persona is fixed under `data/roles/<RoleId>/voice/cache/tts-audio/`. `server.tts_audio_dir` (or `RABISPEECH_TTS_AUDIO_DIR`) controls only the fallback used when no persona resolves. Its default physical location is `plugin-adapters/rabi-speech/output/tts-audio/`; it cannot redirect persona caches outside their role directories.

Each finalized file uses its own mtime and defaults to a `1440`-minute (24-hour) retention window rather than natural-day batch deletion. Service startup, every newly retained TTS file, and a 60-second background check clean persona and fallback caches that have passed the window. Actual deletion may lag by at most one check interval, so the expected expiry in a record is not an exact-to-the-second deletion promise.

Record APIs expose only safe POSIX-style logical relative paths: `<RoleId>/voice/cache/tts-audio/<file>` for persona output and `output/tts-audio/<file>` for fallback output. Legacy records may keep a bare filename. Absolute paths, parent traversal, backslashes, URI/encoded pseudo-paths, and control characters do not enter the Manager/WebGUI read model.

## Speaker labeling

Person profiles and `record_id + speaker_label` bindings share the host-wide `output/speaker-profiles.json`. Provider labels such as `0/1` or `Speaker 1/2` are valid only inside one ASR recording and never inherit through a long-lived microphone `session_id`. The human entry is under **Speech Service → ASR → Speaker / voiceprint settings**, where each recorded turn can be confirmed or corrected from the dropdown.

An Agent can call `PUT /api/speech/speaker-identities`; a direct host-local caller can use `PUT /v1/speaker-identities`. Both forms require the session, recording, and provider label. The idempotent transaction reuses an explicit profile ID or performs a case-insensitive display-name/alias lookup, creates a profile when needed, merges aliases, and binds only the selected recording label. A dropdown confirmation also marks that recording's local embedding as a confirmed prototype. Later recordings are judged by multiple confirmed prototypes, the best-versus-second margin, and effective speech duration; low-confidence cases remain in an unknown cluster instead of being forced onto a person.

The default recommendation is the Chinese 16 kHz 3D-Speaker ERes2NetV2 model, with CAM++ as a lighter fallback. Models and dependencies stay local, enrollment audio is not copied, and embeddings live only in ignored `output/speaker-embeddings.json`; Manager/WebGUI never returns the vectors. Model installation is explicit: `scripts\install_models.ps1 -Model speaker-eres2netv2-zh` downloads about 68 MiB. Before that, the service keeps the manual dropdown workflow. With a model present and `speaker_recognition.validated=false`, the default remains clustering and suggestions only. Local configuration must explicitly set `experimental_auto_assign=true` to permit clearly labeled experimental automatic matches, and that mode still does not claim `voiceprint.supported=true`. Set `validated=true` only after same/different-speaker local benchmarking and threshold calibration.

Startup first probes model compatibility with the current `sherpa-onnx` runtime in an isolated child process. An incompatible model format or native runtime may terminate that probe, but the RabiSpeech service must remain online and expose the reason through capabilities; an experimental voiceprint model must not take down TTS, ASR, microphone capture, or manual bindings. `max_samples_per_profile` bounds manually confirmed prototypes per person, while `max_unconfirmed_samples` bounds all samples that have not been manually confirmed. Frames below the configured RMS floor and segments with material cross-speaker overlap are not admitted as voiceprint samples.

Voiceprint matching is not speaker diarization. RabiSpeech can extract separate embeddings only when ASR returns reliable `speaker + start/end` turns. When an ordinary ASR result has no speaker labels, one VAD utterance is still treated as one temporary `voice`; it cannot separate alternating or overlapping speakers inside that utterance.

`scripts/benchmark_speaker_models.py` evaluates the FenneNote 68-dimensional spectral baseline, ERes2NetV2, and CAM++ on the same private WAV set. It reports EER, FAR, FRR, known-speaker identification, unknown retention, and p50/p95 latency. See `benchmarks/speaker-cases.example.json` for the manifest shape. Real recordings must remain under an ignored private directory and out of public reports.

## Extend providers

1. Implement the `TtsProvider` or `AsrProvider` protocol.
2. Expose a `register(registry, settings)` function that registers the provider.
3. Add `package.module:register` to `providers.extensions` in the machine-local `config.json`.
4. Keep model invocation in the provider. Authentication, upload limits, API shapes, subtitle formats, and Relay transport remain framework responsibilities.

Extension modules load only from local configuration. Remote APIs cannot select or inject Python modules. Provider IDs must be unique; models can be selected explicitly as `provider/model` or `provider:model`.

Model switching is restricted by default. Remote requests cannot make faster-whisper silently download a new model; install and configure it locally before explicitly allowing it.

## Model benchmark and HTML report

Report results apply only to the target machine and environment named in the report. After deployment to another computer, rerun the same corpus and scripts; performance on that computer is authoritative.

The project uses one closed-loop script to generate TTS first and then send every WAV to each ASR:

```text
benchmarks/cases.zh-CN.json
  -> scripts/benchmark_models.py tts
  -> scripts/benchmark_models.py asr
  -> summarize
  -> render-html
```

The fixed corpus, feature metadata, and HTML template live under `benchmarks/`. See `../../skills/benchmark-rabispeech-models/SKILL.md` for the full workflow and `../../docs/rabispeech-plugin_en.md` for the service guide. After building WebGUI, open:

```text
http://127.0.0.1:8790/#/docs
http://127.0.0.1:8790/reports/rabispeech-model-benchmark.html
```

Runtime WAV, JSON, CSV, and logs remain in ignored `output/benchmarks/`. The public HTML embeds only sanitized metrics and sentence-level results.
