<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabispeech-plugin.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiSpeech TTS / ASR provider service

RabiSpeech is RabiRoute's loopback-hosted speech provider service. Ordinary manual TTS/ASR HTTP calls do not enter an Agent or read a conversation. After the resident microphone completes a non-empty ASR segment, Manager broadcasts the same text to every Route whose speech endpoint is enabled. Each Route then independently applies `speechPushMode=hot|keyword`, so one host transcription can reach multiple personas without duplicate capture or ASR work. Local models remain the defaults. OpenAI-compatible and Alibaba Cloud Model Studio (DashScope) providers appear only after explicit local configuration, with no silent local-to-cloud fallback.

Provider secrets are read only from named environment variables such as `OPENAI_API_KEY` and `DASHSCOPE_API_KEY`; they are never stored in public config, capabilities, logs, or examples.

## Installed model families

TTS: ONNX-VITS, GPT-SoVITS, Qwen3-TTS 0.6B/1.7B Base, IndexTTS2, and CosyVoice3 0.5B.

ASR: faster-whisper tiny/small/large-v3-turbo, Qwen3-ASR 0.6B/1.7B, SenseVoiceSmall, and FireRedASR2-AED.

When explicitly enabled, API models join the same `/v1/models` discovery list. Examples include OpenAI GPT-4o mini TTS/transcription and Whisper API, DashScope Qwen3 instruct/voice-clone TTS, and `dashscope-qwen/paraformer-v2` for non-real-time meeting transcription with speaker diarization. Persona voice profiles store only a `voice_env` environment-variable name, never the real provider voice ID. RabiSpeech keeps its local silence segmentation and submits each meeting segment to the asynchronous file-transcription API. The selected language is sent through `language_hints`; pass `speaker_count` when the participant count is known. Results contain per-turn `speaker`, `start`, `end`, and `text`. `SUCCESS_WITH_NO_VALID_FRAGMENT` is treated as an empty segment rather than a service failure and is not retried.

The published Paraformer file-transcription contract accepts publicly reachable HTTP / HTTPS URLs in `file_urls` and explicitly does not support Base64 audio, local files, or binary streams. When no proper uploader is configured, the current implementation still has a data-URI compatibility path; some DashScope environments temporarily copy it into OSS, but that behavior is not a public production contract. Stable deployments should provide a controlled temporary upload or signed OSS URL. Until then, this compatibility path remains experimental and is not a reliability guarantee for high-volume meeting workloads.

`GPT-SoVITS` is the local open-source voice-cloning project, not OpenAI's cloud GPT TTS. Persona voices live under `data/roles/<RoleId>/voice/`. `voice/voice-profile.json` is the single source of truth for the persona's TTS model, voice binding, language, speed, and speaking instructions. Routes own only speech subscription, hot/keyword delivery, and reply-playback policy; the host owns microphone, ASR model, VAD, and segmentation. A persona can be addressed directly without creating a Route or Agent binding. Legacy Route TTS/ASR/VAD fields remain readable only as compatibility fallbacks and are no longer created or shown by WebGUI. A global FIFO serializes playback across Routes, sessions, Agents, personas, and models.

## Install

```powershell
cd plugin-adapters\rabi-speech
.\scripts\install.ps1
.\scripts\install_models.ps1 -List
.\scripts\test.ps1
.\scripts\start.ps1
.\scripts\install-service.ps1 -StartNow
```

The default listener is `http://127.0.0.1:8781`. See [local model downloads](local-speech-model-downloads_en.md) for isolated environments and per-model validation.

The meeting-room network sound card does not change that control-plane boundary. After `remote_audio` is enabled in the private `config.json`, RabiSpeech opens only an independently authenticated TCP `8782` audio WebSocket and UDP `8783` LAN discovery. The client continuously sends PCM and receives WAV; VAD, segmentation, ASR, Route broadcast, persona TTS, FIFO playback, and feedback suppression all stay on the host. See [Rabi Voice Client](../desktop/rabi-voice-client/README_en.md). LAN direct connection does not require RabiLink configuration.

## Discover and call APIs

Call `GET /v1/models` first. It returns models, installation states, languages, features, request schemas, required/optional fields, and examples.

```http
GET  /health
GET  /v1/models
GET  /v1/capabilities
GET  /v1/personas
GET  /v1/microphone/status
GET  /v1/microphone/devices
GET  /v1/records
GET  /openapi.json
POST /v1/audio/speech
POST /v1/audio/transcriptions
POST /v1/microphone/start
PUT  /v1/microphone/settings
POST /v1/microphone/stop
```

Minimal TTS body:

```json
{"model":"local-tts/gpt-sovits","input":"Hello.","voice":"Rabi","response_format":"wav"}
```

Common TTS fields are `model`, `input`, `voice`, `language`, `instructions`, `response_format`, `speed`, `sample_rate`, `play`, `session_id`, and `route_id`. ASR uses multipart form data with required `file` and optional `model`, `language`, `response_format`, `speaker_count`, `session_id`, and `route_id`.

DashScope-shaped compatibility aliases remain for existing clients. The explicitly selected provider/model determines whether execution is local or external:

```http
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

## RabiPC and RabiLink

The RibiWebGUI speech page uses top-level TTS/ASR tabs. TTS selects a persona and reads its model, voice, language, speed, and speaking instructions without creating a second editable copy, then submits synthesis to the host FIFO. The global playback queue card exposes a `0–100` slider plus exact numeric input for the host volume. RabiSpeech persists the setting, and each audio item reads it when playback starts, so a new value applies from the next item that begins playing; it does not belong to a Route or persona. ASR owns the host microphone stream, model, dynamic RMS, record/transcribe thresholds, pre-roll, and silence segmentation. Runtime edits restore listening automatically. The page shows the subscriber count and no longer exposes a delivery-Route selector or a user-editable session ID. Like FenneNote, the ASR area shows only the current run's recent transcript preview while the complete record is written by date in the background; there is no separate meeting-record selection or export card.

Windows remembers the previous Core Audio session multiplier per executable. At startup, RabiSpeech opens one persistent silent shared-mode render session, normalizes a stale `1%` value to `100%` once, and then keeps the session alive without rewriting its volume. The RabiSpeech slider therefore remains adjustable in Windows Volume Mixer for the lifetime of the service, and real playback reuses the same session. Silent keepalive audio does not enter the FIFO or trigger microphone feedback suppression.

The FenneNote-style host pipeline now lives only under **Speech Service → ASR**, showing `host microphone → VAD segmentation → ASR transcription → broadcast delivery → reply/playback`, counters, recent events, and transcript previews. A Route's **Message adapters → Speech endpoint** section keeps only that Route's hot/persona-keyword policy, persona TTS summary, and automatic reply-playback switch. It no longer duplicates host waveform, counters, runtime logs, or recent transcripts. The speech-endpoint toggle remains the Route subscription source of truth; disabling one Route removes only its subscription, and the host microphone stops only after the final subscription is disabled.

A `voice_transcript` delivered by the speech message endpoint puts that Agent turn into `character-tts-dialogue` state. `AgentPacket` injects `characterTtsDialogue=true` plus mandatory reply instructions. After the handler returns a short spoken line, semantically identical to its visible reply, through `/api/agent/replies`, Outbox binds the current Route persona ID and `sessionId`. RabiSpeech then resolves the model, voice, language, speed, and speaking instructions from that persona's `voice-profile.json` before entering the host-wide FIFO. This automatic state applies only to `speech` / RabiSpeech ingress; QQ, the role panel, and ordinary text messages remain silent unless explicitly configured otherwise.

### Hot delivery and persona keywords

The Route's **Hot delivery** switch maps directly to `adapterConfig.json.speechPushMode`:

- On (`hot`): every completed ASR segment is delivered immediately to the bound Agent. The Desktop owner uses `steer` when a turn is active and `start` otherwise.
- Off (`keyword`): every ASR segment is still written to speech records and the persona conversation ledger, but the Agent is notified only when the text matches a persona name, common address, or wake phrase in `personaConfig.json.speechTriggerKeywords`.
- An empty keyword list remains record-only. It never silently falls back to hot delivery.

Keywords belong to the persona because one persona can be reused by several Routes. Hot-versus-keyword mode belongs to the Route because it controls immediate delivery for that speech ingress path.

### Bidirectional ASR/TTS context

RabiSpeech keeps its daily ASR/TTS diagnostic text records. Once speech enters a persona through a Route, RabiRoute also normalizes inbound ASR and successful outbound TTS into:

```text
data/roles/<RoleId>/conversation/current.jsonl
```

Automatic context reads only records for the current persona, logical `speech` endpoint, and the same `sessionId`. ASR and TTS share the `recentMessageLimits.speech` message-count budget. Its range is `0–200`, the schema default is `100`, and `0` disables automatic injection without stopping recording. Other speech sessions are excluded from the current `AgentPacket`.

The defaults migrate the previous FenneNote workstation profile: `faster-whisper/small`, Chinese, the system-default 16 kHz input, adaptive RMS, `0.01` record threshold, `0.015` transcription threshold, `500 ms` completion silence, `1000 ms` minimum, `60000 ms` maximum, `1500 ms` pre-roll, and `1.0` input gain. The adaptive multiplier and margin remain `2.5` and `0.004`. These values are a workstation baseline, not a universal microphone calibration.

When speech does not reach a Route, inspect the five stages under **Speech Service → ASR** from left to right: confirm that at least one speech endpoint is subscribed if the microphone is stopped; tune the host device or thresholds if the level moves but no segment is captured; inspect ASR events if captured segments are not recognized; verify the affected Route's subscription and runtime if recognition succeeds but that Route has no terminal receipt; when Hot delivery is off, also check whether the transcript matched that persona's keyword. Another Route's success never impersonates success for the current Route. Then inspect Agent delivery and the TTS/playback queue if delivery succeeds without a reply. Runtime events remain process-scoped diagnostics. Following FenneNote's date-based recording approach, ASR/TTS text metadata is appended to ignored `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl` and survives restarts. WebGUI embeds a recent persistent bidirectional-record view inside the ASR page rather than exposing a separate meeting selector, speaker-excerpt workflow, or export card. Raw ASR input audio is not copied by default. Finalized persona TTS audio is retained under the matching `data/roles/<RoleId>/voice/cache/tts-audio/`; direct TTS that does not resolve to a persona uses a private RabiSpeech fallback cache. Both use each file's own mtime and default to `1440` minutes (24 hours). Record APIs and WebGUI expose only safe POSIX-style logical references: `<RoleId>/voice/cache/tts-audio/<file>` for persona output and `output/tts-audio/<file>` for fallback output. Legacy records may keep a bare filename, while absolute paths, `..`, and backslash traversal are omitted. The displayed value is an expected expiry, not proof that cleanup ran at that exact second. Text records remain independent, so passing the audio retention window does not delete them; `GET /api/speech/records` remains a diagnostic query only.

Speaker identity has two local sources of truth. `output/speaker-profiles.json` stores people and manual `recordId + speakerLabel` bindings; `output/speaker-embeddings.json` stores neural embeddings, manually confirmed prototypes, and unknown clusters. Temporary diarization labels never inherit through a long-lived `sessionId`. Enrollment audio is not copied and vectors are never returned by APIs. A dropdown confirmation still changes only the selected recording, while adding that sample to the person's multi-prototype set. Later automatic decisions must pass effective-duration, best-score, and best-versus-second-margin gates; low-confidence audio remains unknown.

Before entering the main process, a speaker model is compatibility-probed in an isolated child process. If the model format, ONNX/sherpa runtime, or native dependency is incompatible, the main service keeps its other speech capabilities online and exposes the failure through `voiceprint.reason`. Confirmed prototypes are bounded by `max_samples_per_profile`, while clusters and automatic matches that have not been manually confirmed are bounded by `max_unconfirmed_samples`. Frames below `min_voiced_rms` and segments with material cross-speaker overlap do not enter the embedding store. Automatic matches never become training prototypes by themselves; only manually confirmed samples own prototype truth.

Voiceprint matching and multi-speaker diarization are separate capabilities: one answers “whose voice does this resemble,” while the other answers “who spoke when.” Separate embeddings are possible only when ASR has already returned reliable `speaker + start/end` turns. Ordinary ASR without diarization labels treats one VAD utterance as one temporary `voice` and cannot resolve alternating or overlapping speakers within that utterance.

The loopback RabiSpeech and Manager endpoints remain unchanged. The ASR page groups recent utterances by known person or cross-recording unknown voice cluster and keeps its per-recording correction dropdown. ERes2NetV2 installation is explicit. A missing model falls back to the manual workflow. With `validated=false`, the default remains clustering and suggestions only; local configuration must explicitly set `experimental_auto_assign=true` to allow labeled experimental automatic identification, and capabilities still do not claim formal support. Set `validated=true` only after local benchmark calibration.

`POST /api/speech/messages` no longer returns an ambiguous `202 Accepted`. The resident microphone omits `routeId`; Manager broadcasts one transcript to every subscribed Route and returns each independent terminal receipt in `deliveries[]`. An explicit `routeId` remains only for debugging and compatibility calls. Manager waits for gateway child processes to report Desktop-delivery terminal states (up to 40 seconds), but it does not wait for the Agent answer, Outbox return, or TTS playback:

- `200` with `status=delivered`: the target Desktop owner accepted `start` or `steer`.
- `200` with `status=recorded`: keyword mode did not match; the transcript was fully recorded without waking the Agent.
- `200` with `status=recorded` and `reason=no_enabled_speech_routes`: no Route is subscribed, so the transcript remains only in RabiSpeech records.
- `4xx/5xx`: an explicit Route is invalid/disabled, or every subscribed Route fails because of owner loading, IPC, timeout, or equivalent terminal errors.

The UI therefore distinguishes **Desktop delivered** from **Recorded only**. A generic “Route accepted” label must not impersonate Desktop receipt.

`server.tts_audio_dir` (or `RABISPEECH_TTS_AUDIO_DIR`) now controls only the fallback used when no persona resolves; its default physical location remains `plugin-adapters/rabi-speech/output/tts-audio/`. Persona TTS cache roots are fixed under their matching role directories and are not redirected by this setting.

### RabiPC frontend/backend contract

RibiWebGUI never connects to port `8781` directly. It talks only to Manager `/api/speech/*`, whose browser contract uses camelCase fields such as `routeId`, `recordThreshold`, `dynamicThreshold`, and `lastSubmitError`. `src/manager/speechControl.ts` maps those fields inside the local adapter to the snake_case payload used by RabiSpeech `/v1/*`. Frontend requests, polling, error envelopes, and shared state live in `ribiwebgui/src/speech/speechControlClient.ts` and `ribiwebgui/src/stores/speechStore.ts`; Vue pages should not add their own `fetch("/api/speech/...")` calls.

Direct RabiSpeech `/v1/*` callers continue to use the OpenAI-compatible snake_case fields shown in this document. RabiPC Manager `/api/speech/*` callers use the camelCase contract in `src/shared/speechControlContract.ts`. Do not mix the two interfaces.

VAD also finishes every candidate when the silence window expires. A candidate shorter than the configured minimum voiced duration is discarded immediately and listening resumes, so a short bump or noise spike no longer occupies the full maximum utterance duration.

Closing the browser does not stop capture. The ignored `plugin-adapters/rabi-speech/microphone.json` persists host configuration. Manager reconciles subscriptions at startup, Route save, and configuration reload: any subscribed Route starts or keeps listening active, while no subscriptions stop it. Legacy `route_id` is migrated to `null`, and the session ID is host-generated/persisted rather than user-configured. Microphone control is loopback-only and is intentionally excluded from the public RabiLink generic-token allowlist; remote clients may call normal TTS/ASR APIs but cannot control the PC microphone with that token.

For remote use, enable the global RabiLink connection and **Allow speech relay**. Keep the local target at `http://127.0.0.1:8781`. Public calls use the common application token at `https://<relay>/api/rabilink/speech/*` through either `Authorization: Bearer <token>` or `X-RabiLink-Token: <token>`.

The public base URL is `https://<relay>/api/rabilink/speech`, so the common complete paths are:

```http
GET  https://<relay>/api/rabilink/speech/health
GET  https://<relay>/api/rabilink/speech/v1/models
POST https://<relay>/api/rabilink/speech/v1/audio/speech
POST https://<relay>/api/rabilink/speech/v1/audio/transcriptions
```

Do not give a remote client the local `http://127.0.0.1:8781/v1/...` URL. See [Call TTS and ASR remotely](user-guide/speech-api_en.md) for copyable PowerShell calls, success criteria, and error recovery.

The Relay selects the application's online PC, queues bytes only in short-lived memory, and synchronously returns the local result. It does not enter an Agent, persona, Route, or message ledger.

## Extension and security boundary

Providers implement `TtsProvider` or `AsrProvider` and register locally through `providers.extensions`. Remote clients may select only allowlisted installed models; they cannot install models, load code, or alter provider configuration.

Enabling an external provider changes `/health.local_only` and `/v1/capabilities.relay_safe` accordingly. RabiLink speech relay remains a separate explicit user opt-in.

The API currently returns complete audio/results rather than a streaming first chunk. The default upload limit is 25 MiB. On the tested 16 GiB GPU, large GPU workers load on demand and the global FIFO prevents concurrent model contention.

## Performance and Windows CUDA

The first report covers six TTS and five main ASR models, including cold start/warm-up, warmed requests, model size, capability, test hardware, recommended hardware, smoke accuracy, and Windows CUDA DLL issues:

- [Performance and capability report](rabispeech-performance-report_en.md)
- [Standalone HTML report](../ribiwebgui/public/reports/rabispeech-model-benchmark.html)

An NVIDIA driver does not provide every Python runtime DLL. RabiSpeech installs official NVIDIA wheels into private plugin dependencies and adds their directories only to the service process. Validate with an actual inference and `/v1/capabilities`, not only an import test.
