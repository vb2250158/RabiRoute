# RabiSpeech local TTS / ASR service

RabiSpeech is RabiRoute's local speech service. Ordinary HTTP calls do not enter an Agent or read a conversation. A transcript enters a Route only when the user explicitly selects **Submit Route** in RabiPC.

Cloud speech providers, including paid Alibaba Cloud and OpenAI APIs, are outside the active runtime. Legacy cloud files are archival only and never participate in model discovery or fallback.

## Installed model families

TTS: ONNX-VITS, GPT-SoVITS, Qwen3-TTS 0.6B/1.7B Base, IndexTTS2, and CosyVoice3 0.5B.

ASR: faster-whisper tiny/small/large-v3-turbo, Qwen3-ASR 0.6B/1.7B, SenseVoiceSmall, and FireRedASR2-AED.

`GPT-SoVITS` is the local open-source voice-cloning project, not OpenAI's cloud GPT TTS. Persona voices live under `data/roles/<RoleId>/voice/` and can be addressed directly without creating a Route or Agent binding. A global FIFO serializes playback across Routes, sessions, Agents, personas, and models.

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

## Discover and call APIs

Call `GET /v1/models` first. It returns models, installation states, languages, features, request schemas, required/optional fields, and examples.

```http
GET  /health
GET  /v1/models
GET  /v1/capabilities
GET  /v1/personas
GET  /v1/microphone/status
GET  /v1/microphone/devices
GET  /openapi.json
POST /v1/audio/speech
POST /v1/audio/transcriptions
POST /v1/microphone/start
POST /v1/microphone/stop
```

Minimal TTS body:

```json
{"model":"local-tts/gpt-sovits","input":"Hello.","voice":"Rabi","response_format":"wav"}
```

Common TTS fields are `model`, `input`, `voice`, `language`, `instructions`, `response_format`, `speed`, `sample_rate`, `play`, `session_id`, and `route_id`. ASR uses multipart form data with required `file` and optional `model`, `language`, and `response_format`.

DashScope-shaped compatibility aliases remain for existing clients, but execute only local models:

```http
POST /api/v1/services/audio/tts/SpeechSynthesizer
POST /api/v1/services/audio/asr/transcription
```

## RabiPC and RabiLink

The RibiWebGUI speech page uses top-level TTS/ASR tabs. TTS manages direct persona synthesis and the host FIFO. ASR configures a microphone stream owned by the resident RabiSpeech process, including dynamic RMS, separate record/transcribe thresholds, pre-roll, silence segmentation, local transcription, and optional Route delivery.

The Route page also provides a FenneNote-style live pipeline for `microphone → VAD segmentation → local ASR → Route delivery → reply/playback`, with real status, counters, recent events, and a local transcript preview. Its bar waveform renders the latest 120 RabiSpeech RMS samples at 100 ms intervals, colors quiet/record/transcribe levels separately, and overlays record, transcribe, and adaptive dynamic thresholds. Enabling the speech adapter only permits that Route to use speech; it does not start microphone capture. Capture starts only after **Start voice chat** is pressed in this panel or on the speech page.

A `voice_transcript` delivered by the speech message endpoint puts that Agent turn into `character-tts-dialogue` state. `AgentPacket` injects `characterTtsDialogue=true` plus mandatory reply instructions. After the handler returns a short spoken line, semantically identical to its visible reply, through `/api/agent/replies`, Outbox freezes the current Route persona, voice, TTS model, language, instructions, and `sessionId` before entering the host-wide RabiSpeech FIFO. This automatic state applies only to `speech` / RabiSpeech ingress; QQ, the role panel, and ordinary text messages remain silent unless explicitly configured otherwise.

The defaults migrate the previous FenneNote workstation profile: `faster-whisper/small`, Chinese, the system-default 16 kHz input, adaptive RMS, `0.01` record threshold, `0.015` transcription threshold, `500 ms` completion silence, `1000 ms` minimum, `60000 ms` maximum, `1500 ms` pre-roll, and `1.0` input gain. The adaptive multiplier and margin remain `2.5` and `0.004`. These values are a workstation baseline, not a universal microphone calibration.

When speech does not reach a Route, inspect the five stages from left to right: start the microphone if it is stopped; tune the device or thresholds if the level moves but no segment is captured; inspect ASR events if captured segments are not recognized; verify Route binding, auto-submit, and Route runtime if recognition succeeds but delivery does not; then inspect Agent delivery and the TTS/playback queue if Route delivery succeeds without a reply. Runtime events keep diagnostic metadata but do not duplicate transcript text; the transcript preview remains local and process-scoped.

`POST /api/speech/messages` now implements actual `202 Accepted` semantics: once Manager validates the Route and starts the delivery task, it responds immediately while Agent/Codex processing continues in the background. “Route accepted” means the message endpoint accepted the transcript, not that the Agent already completed its reply. This avoids the former false `ReadTimeout` when initial Codex delivery exceeded RabiSpeech's 15-second HTTP timeout even though delivery completed later.

### RabiPC frontend/backend contract

RibiWebGUI never connects to port `8781` directly. It talks only to Manager `/api/speech/*`, whose browser contract uses camelCase fields such as `routeId`, `recordThreshold`, `dynamicThreshold`, and `lastSubmitError`. `src/manager/speechControl.ts` maps those fields inside the local adapter to the snake_case payload used by RabiSpeech `/v1/*`. Frontend requests, polling, error envelopes, and shared state live in `ribiwebgui/src/speech/speechControlClient.ts` and `ribiwebgui/src/stores/speechStore.ts`; Vue pages should not add their own `fetch("/api/speech/...")` calls.

Direct RabiSpeech `/v1/*` callers continue to use the OpenAI-compatible snake_case fields shown in this document. RabiPC Manager `/api/speech/*` callers use the camelCase contract in `src/shared/speechControlContract.ts`. Do not mix the two interfaces.

VAD also finishes every candidate when the silence window expires. A candidate shorter than the configured minimum voiced duration is discarded immediately and listening resumes, so a short bump or noise spike no longer occupies the full maximum utterance duration.

Closing the browser does not stop capture. The ignored `plugin-adapters/rabi-speech/microphone.json` persists the configuration, and an enabled stream is restored after a service restart. Stop it explicitly from the ASR tab to persist the disabled state. Microphone control is loopback-only and is intentionally excluded from the public RabiLink generic-token allowlist; remote clients may call normal TTS/ASR APIs but cannot control the PC microphone with that token.

For remote use, enable the global RabiLink connection and **Allow speech relay**. Keep the local target at `http://127.0.0.1:8781`. Public calls use the common application token at `https://<relay>/api/rabilink/speech/*` through either `Authorization: Bearer <token>` or `X-RabiLink-Token: <token>`.

The Relay selects the application's online PC, queues bytes only in short-lived memory, and synchronously returns the local result. It does not enter an Agent, persona, Route, or message ledger.

## Extension and security boundary

Providers implement `TtsProvider` or `AsrProvider` and register locally through `providers.extensions`. Remote clients may select only allowlisted installed models; they cannot install models, load code, or alter provider configuration.

The API currently returns complete audio/results rather than a streaming first chunk. The default upload limit is 25 MiB. On the tested 16 GiB GPU, large GPU workers load on demand and the global FIFO prevents concurrent model contention.

## Performance and Windows CUDA

The first report covers six TTS and five main ASR models, including cold start/warm-up, warmed requests, model size, capability, test hardware, recommended hardware, smoke accuracy, and Windows CUDA DLL issues:

- [Performance and capability report](rabispeech-performance-report_en.md)
- [Standalone HTML report](../ribiwebgui/public/reports/rabispeech-model-benchmark.html)

An NVIDIA driver does not provide every Python runtime DLL. RabiSpeech installs official NVIDIA wheels into private plugin dependencies and adds their directories only to the service process. Validate with an actual inference and `/v1/capabilities`, not only an import test.

<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabispeech-plugin.md">简体中文</a>
</div>
<!-- /docs-language-switch -->
