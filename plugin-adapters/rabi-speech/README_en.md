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

Loopback control-state changes are pushed through `GET /v1/events` SSE. Manager forwards the stream as `GET /api/speech/events`; `microphone_event`, `playback_changed`, and `audio_stream_changed` refresh only their matching state, while `records_changed` refreshes the records panel only after an ASR/TTS row has been persisted. Throttled `microphone_level` events update the meter directly. SSE reconnect performs one snapshot recovery pass; no fixed-interval status or record polling remains.

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
  sample_rate = 16000
  speed = 1.0
  play = $false
} | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8781/v1/audio/speech `
  -ContentType "application/json" -Body $body -OutFile .\output.wav
```

When both input and output are WAV, the shared RabiSpeech audio-preparation layer applies `sample_rate` locally with NumPy and SoundFile and does not require ffmpeg. Cross-format conversion from WAV to MP3, FLAC, Opus, AAC, or raw PCM still requires `server.ffmpeg` or `RABISPEECH_FFMPEG`.

ASR example:

```powershell
curl.exe -X POST http://127.0.0.1:8781/v1/audio/transcriptions `
  -F "file=@sample.wav" -F "model=asr-local" -F "response_format=verbose_json"
```

To preserve local privacy, the DashScope-style ASR endpoint accepts only `data:audio/...;base64,...` and does not download arbitrary public URLs for the caller.

## Speech records and TTS cache

After a resident microphone utterance completes, RabiSpeech computes whole-utterance RMS and peak and submits them with capture timing, audio format, source-device metadata, and ASR/voiceprint turns. The host raw record, persona voice history, and conversation context retain these audio facts, but the host never uses them to decide speaker identity or who is the user. When pre-roll is disabled, the first PCM block that triggers VAD still belongs to the utterance and must not be dropped.

`GET /v1/records` queries date-persisted ASR/TTS text metadata and supports filters for `kind`, `session_id`, `route_id`, and time windows. Text records and finalized-audio caches are independent; passing the audio retention window does not delete the text record.

Finalized TTS audio for a resolved persona is fixed under `data/roles/<RoleId>/voice/cache/tts-audio/`. `server.tts_audio_dir` (or `RABISPEECH_TTS_AUDIO_DIR`) controls only the fallback used when no persona resolves. Its default physical location is `plugin-adapters/rabi-speech/output/tts-audio/`; it cannot redirect persona caches outside their role directories.

Each finalized file uses its own mtime and defaults to a `1440`-minute (24-hour) retention window rather than natural-day batch deletion. Startup removes expired files and calculates the earliest remaining expiry. A newly retained TTS file rearms one cleanup deadline only when it expires sooner; RabiSpeech no longer scans every persona and fallback cache every 60 seconds. Process downtime and operating-system scheduling can still make deletion later than the displayed expected expiry, so it is not a hard real-time promise.

Record APIs expose only safe POSIX-style logical relative paths: `<RoleId>/voice/cache/tts-audio/<file>` for persona output and `output/tts-audio/<file>` for fallback output. Legacy records may keep a bare filename. Absolute paths, parent traversal, backslashes, URI/encoded pseudo-paths, and control characters do not enter the Manager/WebGUI read model.

## Speaker labeling

Person profiles and `record_id + speaker_label` bindings share the host-wide `output/speaker-profiles.json`. Provider labels such as `0/1` or `Speaker 1/2` are valid only inside one ASR recording and never inherit through a long-lived microphone `session_id`. The human entry is under **Speech Service → ASR → Speaker / voiceprint settings**, where each recorded turn can be confirmed or corrected from the dropdown.

An Agent can call `PUT /api/speech/speaker-identities`; a direct host-local caller can use `PUT /v1/speaker-identities`. Both forms require the session, recording, and provider label. The idempotent transaction reuses an explicit profile ID or performs a case-insensitive display-name/alias lookup, creates a profile when needed, merges aliases, and binds only the selected recording label. A dropdown confirmation also marks that recording's local embedding as a confirmed prototype. Later recordings are judged by multiple confirmed prototypes, the best-versus-second margin, and effective speech duration; low-confidence cases remain in an unknown cluster instead of being forced onto a person.

The default recommendation is the Chinese 16 kHz 3D-Speaker ERes2NetV2 model, with CAM++ as a lighter fallback. Models and dependencies stay local, enrollment audio is not copied, and embeddings live only in ignored `output/speaker-embeddings.json`; Manager/WebGUI never returns the vectors. Model installation is explicit: `scripts\install_models.ps1 -Model speaker-eres2netv2-zh` downloads about 68 MiB. Before that, the service keeps the manual dropdown workflow. With a model present and `speaker_recognition.validated=false`, the default remains clustering and suggestions only. Local configuration must explicitly set `experimental_auto_assign=true` to permit clearly labeled experimental automatic matches, and that mode still does not claim `voiceprint.supported=true`. Set `validated=true` only after same/different-speaker local benchmarking and threshold calibration.

Run the isolated inference probe from the configuration source of truth with `py -3.10 scripts\speaker_model_probe.py --config config.json`; this avoids manually resolving a relative model path. The script loads RabiSpeech and its private dependencies relative to its own location, independent of the caller's working directory. A passing probe proves only that the model, feature pipeline, and ONNX Runtime can emit an embedding. It does not prove real multi-speaker calibration.

Startup first performs real embedding inference against the official 3D-Speaker model in an isolated child process using ONNX Runtime plus kaldi-native-fbank. An incompatible model format or runtime may terminate that probe, but the RabiSpeech service must remain online and expose the reason through capabilities; an experimental voiceprint model must not take down TTS, ASR, microphone capture, or manual bindings. `max_samples_per_profile` bounds manually confirmed prototypes per person, while `max_unconfirmed_samples` bounds all samples that have not been manually confirmed. Frames below the configured RMS floor and segments with material cross-speaker overlap are not admitted as voiceprint samples.

Voiceprint matching is not speaker diarization. ASR must at least return reliable `start/end` turn boundaries before RabiSpeech can extract separate multi-speaker embeddings. Provider `speaker` labels may still be wrong: when one label appears across multiple disjoint turns, the voiceprint layer preserves the raw `speaker`, assigns a per-turn `speaker_label`, and clusters each turn independently so voiceprints can correct a Provider merge. Ordinary ASR without time turns still treats one VAD utterance as one temporary `voice` and cannot separate alternating or overlapping speakers inside it.

`scripts/benchmark_speaker_models.py` evaluates selected local voiceprint models on one private WAV set and can optionally include the legacy 68-dimensional spectral baseline for historical comparison. It reports EER, FAR, FRR, known-speaker identification, unknown retention, and p50/p95 latency. See `benchmarks/speaker-cases.example.json` for the manifest shape. Real recordings must remain under an ignored private directory and out of public reports. Like the model probe, the benchmark loads RabiSpeech and `.deps` relative to its own file, so it runs from the repository root or any working directory without a manual `PYTHONPATH`.

Use the collector to create the private dataset before formal calibration. Its default directory is the Git-ignored `benchmarks/private/speaker-validation/`. It writes only WAV files, atomically updates `speaker-cases.json`, and archives the previous manifest under the local `archive/` directory; it never changes speaker profiles, persona relationships, or `validated`. New, legacy, or undeclared datasets default to `dataset_kind=unspecified` and `formal_validation_eligible=false`. Only after confirming that every sample in the directory is a real-person recording may an operator explicitly run `init --confirm-real-person-recordings`, which marks the manifest as `real_person_private`. Audio is standardized to 16 kHz mono, while clips shorter than one second, below the RMS floor, or materially clipped are rejected by default:

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py init `
  --confirm-real-person-recordings
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py devices
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py record `
  --speaker user-a --role enroll --count 3 --seconds 5
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py record `
  --speaker user-a --role test --count 3 --seconds 5
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py add `
  --speaker unknown-a --role test --file <private-wav>
py -3.10 plugin-adapters\rabi-speech\scripts\collect_speaker_validation.py status `
  --policy plugin-adapters\rabi-speech\benchmarks\speaker-validation-policy.example.json
```

The public example policy requires at least 32 clips, four enrolled speakers, and two unknown test speakers. A practical starting set is three enroll plus three test clips for each enrolled speaker and four test clips for each of two unknown speakers, covering the real PC, phone/glasses microphones, distances, and room noise. A private `speaker` label is only a benchmark class and never becomes the persona's user identity automatically.

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\benchmark_speaker_models.py `
  --manifest plugin-adapters\rabi-speech\benchmarks\private\speaker-validation\speaker-cases.json `
  --model 3dspeaker-eres2netv2-zh-16k=<absolute-model.onnx> `
  --threshold 0.72 --margin 0.06 `
  --policy <private-policy.json> --require-pass `
  --output <private-validation-report.json>
```

For formal calibration, copy and tune `benchmarks/speaker-validation-policy.example.json` for the real microphones, rooms, speakers, and risk tolerance, then pass both `--policy <private-policy.json>` and `--require-pass`. The gate checks real-person dataset eligibility, dataset scale, and every accuracy metric, and records the dataset-manifest SHA-256, policy SHA-256, model SHA-256, hard threshold, minimum margin, and selected-engine policy result. Synthetic TTS, legacy manifests, datasets without explicit real-person confirmation, or any failed metric still produce a report but exit with code `2`. After a pass, configure the report as `speaker_recognition.validation_report_path` before setting `validated=true`; runtime rechecks those proof fields instead of trusting an isolated boolean.

## TTS → ASR → voiceprint event smoke

`scripts/test_multivoice_voiceprint.py` covers the “multiple TTS voices in one WAV” voiceprint preflight. It can either accept existing audio through repeated `--source anonymous-label=<tts-wav>` values or ask an already-running RabiSpeech instance to create anonymous `source-N.wav` files through repeated `--tts-voice` values. The script normalizes them to 16 kHz mono, inserts short silence, records explicit composition boundaries, and runs the real local voiceprint model per boundary. Optional `--asr-model` sends the same composite WAV through a real meeting-ASR model and checks voiceprints again over the returned time turns. Even when the Provider reuses a speaker label, the voiceprint layer can still separate distinct voices if the turns remain independent; missing turns or fewer voiceprints than expected fail with exit code `2`. The report retains only source SHA-256 values, anonymous ordinals, model IDs, loudness, decisions, and counts—never test text, voice names, absolute paths, or raw voiceprint IDs. Explicit boundaries are not evidence of automatic ASR diarization, and the report always keeps `formalValidationEligible=false`:

```powershell
py -3.10 plugin-adapters\rabi-speech\scripts\test_multivoice_voiceprint.py `
  --source voice-a=<tts-a.wav> `
  --source voice-b=<tts-b.wav> `
  --source voice-c=<tts-c.wav>

py -3.10 plugin-adapters\rabi-speech\scripts\test_multivoice_voiceprint.py `
  --tts-model dashscope-qwen/qwen3-tts-instruct-flash `
  --tts-voice <voice-a> --tts-voice <voice-b> --tts-voice <voice-c> `
  --asr-model dashscope-qwen/paraformer-v2 --speaker-count 3
```

Generation mode calls only the normalized loopback RabiSpeech API rather than duplicating a Provider protocol, so external models must already be explicitly enabled in private machine configuration. The script first queries `/v1/models`: a full model ID is accepted directly, while a unique short model name resolves to the current full ID. A short name that is ambiguous across Providers or currently unavailable fails explicitly instead of submitting a guessed legacy ID. TTS and ASR wait for the current request terminal result and do not poll status; a DashScope asynchronous meeting task retains only the Provider's bounded request-deadline query exception.

`scripts/test-rabispeech-tts-loop.mjs` at the repository root turns one real closed loop into a reproducible acceptance check. It expects RabiSpeech and Manager to be already running, subscribes to SSE `records_changed` first, discovers the actual `/v1/models` capabilities, generates a 16 kHz mono WAV, sends that same WAV to ASR, checks opaque voiceprint evidence, and then queries the matching TTS/ASR session once through both RabiSpeech and Manager. It never starts or stops services or the microphone, never plays audio, and never calls `/api/speech/messages`, so it cannot deliver to a Route or change persona relationships. Record queries happen only after both terminal events arrive; there is no status or record polling.

Automatic selection prefers an installed available local provider. A configured HTTPS API Provider is allowed only with the explicit `--allow-api-provider` flag; local failure never causes a hidden cloud fallback:

```powershell
npm run check:rabispeech:tts-loop

npm run check:rabispeech:tts-loop -- `
  --tts-model dashscope-qwen/qwen3-tts-instruct-flash `
  --asr-model dashscope-qwen/paraformer-v2 `
  --allow-api-provider
```

The sanitized report and WAV default to the Git-ignored `plugin-adapters/rabi-speech/output/acceptance/` directory. Evidence omits the test text, voice/persona value, and raw voiceprint IDs, retaining only hashes, model IDs, audio metrics, events, and query checks. It is always marked `datasetKind=synthetic_tts_smoke` and `formalValidationEligible=false`; it proves mechanism execution only and must never become `validation_report_path` or replace real-person calibration.

After building, `npm run check:speech-ingress-separation` validates the other half of the boundary without invoking a model. In a temporary data root, real `dist/index.js --speech-message` children process one PC `speech` host record and one mobile `rabilink` host record. Acceptance covers one common host store, independent histories for two personas, removal of host identity fields, and mobile reply targeting through the stable device ID only. It never touches the real Manager, Desktop, QQ, Relay, microphone, or persona directories; this message/persona routing check complements the model closed-loop smoke above.

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
