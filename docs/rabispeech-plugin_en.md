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

Android phone/glasses follow the same “remote side transports PCM; host owns speech processing” boundary through restricted Relay HTTP streaming. `start` attaches a virtual remote microphone, `chunk` sends 16 kHz mono PCM s16le with a contiguous sequence beginning at 1, and `stop` restores the previous input. The dedicated endpoint forces the logical `rabilink` message type; a client cannot disguise phone audio as `speech`. RabiSpeech runs the normal host VAD, segmentation, ASR, and voiceprint pipeline, then automatically submits a host-wide message with `messageAdapterType=rabilink`. Android commits a chunk sequence only after PC acknowledgement. Same-stream retries remain idempotent by sequence and PCM hash. If an ACK is lost and Android rebuilds the transient stream, the stable `chunkId` is deduplicated across streams by `sourceDeviceId + chunkId + PCM SHA-256`, so the PCM is not fed to ASR again; reusing a chunk ID with different bytes is rejected. For each stable source device, the host retains only the ID and hash of the last accepted chunk, not another raw recording. `start` and every accepted `chunk` rearm one 15-second expiry event; only that event retires an inactive stream, with no fixed-interval age scan. Android neither needs nor exposes VAD, segmentation, or ASR settings.

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
POST /v1/audio-streams/rabilink/start
POST /v1/audio-streams/rabilink/chunk?streamId=...&sequence=1&chunkId=...
POST /v1/audio-streams/rabilink/stop
POST /v1/microphone/start
PUT  /v1/microphone/settings
POST /v1/microphone/stop
```

Minimal TTS body:

```json
{"model":"local-tts/gpt-sovits","input":"Hello.","voice":"Rabi","response_format":"wav"}
```

Common TTS fields are `model`, `input`, `voice`, `language`, `instructions`, `response_format`, `speed`, `sample_rate`, `play`, `session_id`, and `route_id`. When WAV output specifies `sample_rate`, the shared RabiSpeech audio-preparation layer resamples locally without requiring the running process to discover ffmpeg; only cross-format audio conversion still depends on explicit ffmpeg configuration. ASR uses multipart form data with required `file` and optional `model`, `language`, `response_format`, `speaker_count`, `session_id`, and `route_id`.

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

The resident-ASR host record keeps whole-utterance RMS, peak, capture timing, source, audio format, model, complete speaker turns, and available word timing; the same fields continue into persona voice history and conversation context. RMS/peak are audio facts only, never host evidence for identity or who is the user. `pre_roll_ms=0` disables extra look-behind buffering but must not discard the onset PCM block that triggered VAD.

Synthetic multi-speaker voiceprint preflight uses `scripts/test_multivoice_voiceprint.py`. It can consume existing TTS WAV files or generate anonymous clips through the loopback RabiSpeech API with multiple voice selectors, then combine them into one recording. The script first reads the current `/v1/models` contract: full IDs pass through, unique short names resolve to full IDs, and ambiguous or unavailable names fail closed. Explicit composition boundaries first exercise the real local voiceprint model; optional meeting-ASR mode then validates returned time turns and per-turn voiceprints. When Provider speaker labels are fewer than expected but turns remain intact, distinct local voiceprints explicitly correct that merge; missing turns or voiceprints still fail closed. The script never presents known boundaries as automatic diarization, omits text, voice names, and raw voiceprint IDs, always marks its output synthetic, and can never unlock formal `validated` mode.

RabiSpeech keeps its daily ASR/TTS diagnostic text records. Once speech enters a persona through a Route, RabiRoute also normalizes inbound ASR and successful outbound TTS into:

```text
data/roles/<RoleId>/conversation/current.jsonl
```

After resident ASR completes, RabiRoute first appends one host-wide message to `data/speech/messages/YYYY-MM-DD.jsonl`. It preserves the stable `recordId`, capture start/completion/ingestion times, provider, model, language, duration, peak level, sample rate, channels, audio format, channel type, physical transport, stable source device, transient `sourceStreamId`, `sourceHostId/sourceHostName`, complete speaker turns, and—when supplied by the provider—word start/end times, probability/confidence, and word-level speaker labels. One recording is stored once even when several Routes consume it. Stable `sourceDeviceId` owns reply targeting, while `sourceStreamId` identifies only the current PCM connection; the two must not be conflated. Distribution then follows `messageAdapterType`: the host microphone and ordinary Rabi Voice Clients use the `speech` endpoint, while phone audio streams use the `rabilink` mobile endpoint. A Route consumes only an endpoint it has enabled. Each bound persona writes its own `voice-transcripts.jsonl` and `conversation/current.jsonl`; both files preserve source, stream, audio format, provider/model, processing-host, speaker-turn, and word-timing evidence, while multiple matching Routes bound to the same persona do not duplicate the context row. Host diagnostic person names are still removed at ingress and cannot re-enter persona identity judgment through word metadata.

The host voiceprint layer exposes only opaque stable voiceprint IDs, unknown clusters, diarization labels, scores, and decision evidence. It stores no person names and does not decide who a voiceprint belongs to or which speaker is “the user.” The bound persona interprets each voiceprint through its own relationships, memory, and conversation context, and may use `/api/roles/:roleId/voice-identities` to append its own `voice/voice-identities.jsonl`. Equal voiceprint strings are scoped by `sourceHostId`, preventing local-cluster collisions across PCs. Multi-speaker turns keep their structure when entering persona context instead of collapsing into text that has lost speaker attribution.

A persona may query the read-only join through `GET /api/roles/:roleId/voice-transcripts`. Its summary is computed from the complete time/speaker-filtered set and reports user, other, unknown, and conflict segment counts and speaker duration, plus `coverageRate` and `unresolvedVoiceprints`; the detail `limit` does not truncate `matchedCount` or the summary. Summary-only callers can pass `includeDetails=false`: the server still computes the summary from the complete filtered set but sends no transcript detail or text to the caller. Coverage is derived only at read time, is never written back to host messages, the persona ledger, or the relationship file, and is never polled by active intelligence. Concurrent `isUser` or deletion decisions for one voiceprint on different PCs retain multiple append-event heads and are reported as `conflict`; a later persona confirmation converges every current branch with one new event.

RibiWebGUI's **Persona configuration → Persona voiceprint classification** panel uses that summary-only mode for the latest 24-hour coverage, user/other/unknown/conflict statistics, abbreviated unresolved voiceprints, and current classified relationships. It neither fetches nor displays transcript text. Its actions only call the persona `voice-identities` API to append an explicit `isUser=true`, `isUser=false`, or unset event; the browser owns no second decision source. When a first-time user cannot tell which opaque ID is theirs, **Mark the next recording** stores only the attempt start time plus the current unresolved voiceprints' last-seen baseline. After the next `records_changed` event, unresolved voiceprints newly observed or observed again after that baseline, with a stable `sourceHostId`, are highlighted as candidates. Even one candidate is never written as `isUser` automatically, and simultaneous speakers remain multiple candidates for the user to judge. The page queries once on entry, persona change, or a user action. New recordings use the RabiSpeech `records_changed` event, while relationship writes and multi-PC file merges use Manager SSE to trigger one refresh, with no coverage polling. An SSE reconnect also performs one catch-up query for changes that may have occurred while disconnected.

Host-record `recordId` lookup and append share one cross-process lock, so concurrent submissions, HTTP retries, and RabiSpeech replay create only one raw ingress record. Manager also persists a terminal receipt for every successful or record-only `recordId + Route` under `data/speech/deliveries/YYYY-MM-DD.jsonl`; daily receipt appends are serialized as well, preventing interleaved JSONL. Existing receipts are reused instead of waking the same persona again. Failed terminal attempts do not create a success receipt, so delivery can be retried after the owner or IPC is repaired.

Automatic context for host/standalone speech reads the current persona, logical `speech` endpoint, and matching `sessionId`; phone audio uses the current persona, logical `rabilink` endpoint, and source device. The two sources use their own `recentMessageLimits` budgets, and `0` disables injection without stopping recording. `AgentPacket` and `replyContext` preserve the Route, endpoint, `sourceDeviceId/sourceDeviceKind`, and `channelType`. A normal reply to phone audio goes through `/api/agent/replies` into the RabiLink downlink and defaults to the originating phone device unless the caller explicitly changes the target.

The defaults migrate the previous FenneNote workstation profile: `faster-whisper/small`, Chinese, the system-default 16 kHz input, adaptive RMS, `0.01` record threshold, `0.015` transcription threshold, `500 ms` completion silence, `1000 ms` minimum, `60000 ms` maximum, `1500 ms` pre-roll, and `1.0` input gain. The adaptive multiplier and margin remain `2.5` and `0.004`. These values are a workstation baseline, not a universal microphone calibration.

When speech does not reach a Route, inspect the five stages under **Speech Service → ASR** from left to right: confirm that at least one speech endpoint is subscribed if the microphone is stopped; tune the host device or thresholds if the level moves but no segment is captured; inspect ASR events if captured segments are not recognized; verify the affected Route's subscription and runtime if recognition succeeds but that Route has no terminal receipt; when Hot delivery is off, also check whether the transcript matched that persona's keyword. Another Route's success never impersonates success for the current Route. Then inspect Agent delivery and the TTS/playback queue if delivery succeeds without a reply. Runtime events remain process-scoped diagnostics. Following FenneNote's date-based recording approach, ASR/TTS text metadata is appended to ignored `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl` and survives restarts. WebGUI embeds a recent persistent bidirectional-record view inside the ASR page rather than exposing a separate meeting selector, speaker-excerpt workflow, or export card. Raw ASR input audio is not copied by default. Finalized persona TTS audio is retained under the matching `data/roles/<RoleId>/voice/cache/tts-audio/`; direct TTS that does not resolve to a persona uses a private RabiSpeech fallback cache. Both use each file's own mtime and default to `1440` minutes (24 hours). Startup performs one scan, after which RabiSpeech maintains only the earliest one-shot cleanup deadline; a new artifact rearms it only when it expires sooner, with no fixed directory scan. Record APIs and WebGUI expose only safe POSIX-style logical references: `<RoleId>/voice/cache/tts-audio/<file>` for persona output and `output/tts-audio/<file>` for fallback output. Legacy records may keep a bare filename, while absolute paths, `..`, and backslash traversal are omitted. Process downtime or operating-system scheduling may still delay deletion beyond the displayed expected expiry. Text records remain independent, so passing the audio retention window does not delete them; `GET /api/speech/records` remains a diagnostic query only.

RabiSpeech may still retain operator annotations and voiceprint prototypes in its local diagnostic UI, but those person names are compatibility diagnostics rather than Route or persona identity truth. `output/speaker-embeddings.json` stores neural embeddings, manually confirmed prototypes, and unknown clusters. Every eligible segment explicitly emits a stable opaque `voiceprint_id` derived from that host's cluster. The same unknown voice continues matching its stored cluster after a service restart, and bounded day-long pruning retains at least one prototype for each still-active unknown cluster so a quieter speaker is not completely displaced by frequent voices. Before a record enters RabiRoute's host-wide store, `speakerName/speakerSuggestionName` are removed. Host profile `speaker_id` and candidate `speaker_suggestion_id` may remain diagnostic fields, but persona `user/other` classification and AgentPacket identity injection use only `sourceHostId + voiceprintId`; host profiles never substitute for persona judgment. Temporary diarization labels never inherit through a long-lived `sessionId`; enrollment audio is not copied and vectors are never returned by APIs.

Before entering the main process, a speaker model is compatibility-probed in an isolated child process. RabiSpeech has one production voiceprint extraction backend: ONNX Runtime plus kaldi-native-fbank with 16 kHz audio, 80-bin FBank, global-mean normalization, and a 192-dimensional embedding. It performs real inference in the probe process first. The former Windows sherpa-onnx native feature pipeline is no longer part of the production path because it cannot load the current official 3D-Speaker model. If the active backend is unavailable, the main service keeps its other speech capabilities online and exposes the failure through `voiceprint.reason`; it does not silently switch runtimes. Confirmed prototypes are bounded by `max_samples_per_profile`, while clusters and automatic matches that have not been manually confirmed are bounded by `max_unconfirmed_samples`. Frames below `min_voiced_rms` and segments with material cross-speaker overlap do not enter the embedding store. Automatic matches never become training prototypes by themselves; only manually confirmed samples own prototype truth.

Operators or Agents can run `py -3.10 scripts\speaker_model_probe.py --config config.json`, which resolves configuration and relative model paths exactly like the service. The script loads RabiSpeech and its private dependencies relative to its own location, so the caller does not need to switch working directories first. A returned 192-dimensional embedding proves only that local extraction runs; it does not replace a real same/different-speaker threshold report.

Voiceprint matching and multi-speaker diarization are separate capabilities: one answers “whose voice does this resemble,” while the other answers “who spoke when.” Separate embeddings are possible only when ASR has already returned reliable `speaker + start/end` turns. Ordinary ASR without diarization labels treats one VAD utterance as one temporary `voice` and cannot resolve alternating or overlapping speakers within that utterance.

The loopback RabiSpeech and Manager endpoints remain unchanged. The ASR page groups recent utterances by known person or cross-recording unknown voice cluster and keeps its per-recording correction dropdown. ERes2NetV2 installation is explicit. A missing model falls back to the manual workflow. With `validated=false`, the default remains clustering and suggestions only; local configuration must explicitly set `experimental_auto_assign=true` to allow labeled experimental automatic identification, and capabilities still do not claim formal support. Formal mode requires both `validated=true` and `validation_report_path`. Runtime checks the report schema, `dataset_kind=real_person_private`, `formal_validation_eligible=true`, dataset-manifest SHA-256, policy SHA-256, the complete gate result, target model ID and SHA-256, hard threshold, and minimum margin. Any mismatch disables formal auto-identification and is exposed through `voiceprint.reason`.

Formal calibration must run `scripts/benchmark_speaker_models.py` against private same-speaker and different-speaker recordings with an explicit `--policy` and `--require-pass`. The gate checks real-person dataset eligibility, minimum dataset size, EER, FAR/FRR at the configured threshold, known-speaker identification accuracy, and unknown retention, then writes dataset-manifest, policy, and model SHA-256 values together with the actual threshold/margin and per-engine policy results into a schema-v1 report. Synthetic, legacy, undeclared, or otherwise failed datasets still produce a report but exit with code `2`. The benchmark now bootstraps exactly like the model probe and can run from the repository root or any working directory without preconfiguring `PYTHONPATH`. After a pass, configure that private report as `speaker_recognition.validation_report_path` before setting `validated=true`. The public example policy alone is never proof.

`scripts/collect_speaker_validation.py` provides the missing private-corpus entry point. `devices` lists inputs, `record` captures directly, `add` imports existing WAVs, and `status --policy ...` checks clip, speaker, unknown-speaker, and same/different-pair minimums before model execution. New, legacy, or undeclared manifests are formally ineligible by default. Only after the operator confirms that every sample in the directory is a real-person recording may `init --confirm-real-person-recordings` write `dataset_kind=real_person_private` and `formal_validation_eligible=true`. The default dataset stays in Git-ignored `benchmarks/private/speaker-validation/`; manifest writes are atomic and archive the previous version first. The tool neither reads personas nor writes relationships or enables `validated`, and a dataset label must never be interpreted by the host as “the user.” See the plugin [README](../plugin-adapters/rabi-speech/README_en.md) for complete commands.

Synthetic TTS is only a mechanism preflight before real-person collection. A local preflight on 2026-07-23 used the explicitly enabled `dashscope-qwen/qwen3-tts-instruct-flash`: four known system voices supplied three enrollment and three test clips each, while two unknown system voices supplied four test clips each, for 32 distinct Chinese utterances. After the collector standardized everything to 16 kHz mono, the current ERes2NetV2 at threshold `0.72` and margin `0.06` produced `2.804%` EER, `0.236%` FAR, `5.556%` FRR, `100%` known identification accuracy, and `100%` unknown retention. This proves only that embedding extraction, same/different-voice separation, known identification, and unknown rejection mechanisms execute. Provider system voices are not real people and do not cover real microphones, rooms, noise, overlapping speech, cross-day drift, or similar family voices. Keep the run Git-ignored and label it with `dataset_kind=synthetic_tts` plus `formal_validation_eligible=false`; never use its report as `validation_report_path`, enable `validated=true` from it, or claim that the host can identify the user.

`npm run check:rabispeech:tts-loop` is a runtime closed-loop smoke separate from the local-model performance report. It connects to already-running loopback RabiSpeech/Manager services, subscribes to `/api/speech/events` first (`/v1/events` when Manager checks are skipped), and then runs TTS → 16 kHz mono WAV → ASR → voiceprint evidence → same-session record queries. It performs exactly one record query only after SSE has delivered both terminal `records_changed` events; a one-shot deadline ends missing events without polling. The script never starts or stops the microphone, never plays audio, and never calls `/api/speech/messages`, so no Route is awakened. Automatic model selection prefers local providers, while any API Provider requires explicit `--allow-api-provider`. Output stays in Git-ignored `output/acceptance/`; the report omits text, voice values, and raw voiceprint IDs and always keeps `formalValidationEligible=false`. See the plugin [README](../plugin-adapters/rabi-speech/README_en.md) for all options.

After building, `npm run check:speech-ingress-separation` validates the host-wide message/persona relationship without touching real personas or endpoints. It uses a temporary data root and real `dist/index.js` children for one `speech` PC-microphone record and one `rabilink` mobile record. Acceptance requires exactly two rows in one host store, exactly one `voice-transcripts.jsonl` row and one `conversation/current.jsonl` row in each of two isolated personas, removal of host person fields, and a mobile reply target derived only from the stable device rather than the transient PCM stream. There is no interval check: child exit events plus one-shot deadlines terminate the run. The tool never contacts the existing port 8790, Desktop, QQ, Relay, a microphone, or real `data/roles`.

`GET /api/speech/messages?limit=200` reads recent host-wide speech ingress records. `GET /api/speech/messages?recordId=<id>` returns one raw record plus its latest per-Route terminal receipts. This read-only endpoint is for local Agents, diagnostics, and future management UI; it does not replace each persona's `conversation/current.jsonl`.

`POST /api/speech/messages` no longer returns an ambiguous `202 Accepted`. Resident ASR omits `routeId` and explicitly submits `messageAdapterType`, `channelType`, `source/transport`, source-device metadata, sample rate, and complete turns. Manager broadcasts only to Routes that enable the corresponding endpoint and returns each independent terminal receipt in `deliveries[]`. An explicit `routeId` remains only for debugging and compatibility calls. Manager waits for gateway child processes to report Desktop-delivery terminal states (up to 40 seconds), but it does not wait for the Agent answer, Outbox return, or TTS playback:

- `200` with `status=delivered`: the target Desktop owner accepted `start` or `steer`.
- `200` with `status=recorded`: keyword mode did not match; the transcript was fully recorded without waking the Agent.
- `200` with `status=recorded` and `reason=no_enabled_speech_routes`: no Route is subscribed, so the transcript remains in both RabiSpeech diagnostics and RabiRoute's host-wide speech message store without entering any persona.
- `200` with `status=recorded` and `reason=no_enabled_rabilink_routes`: phone audio was recognized and stored host-wide, but no Route enables the RabiLink/mobile endpoint.
- `4xx/5xx`: an explicit Route is invalid/disabled, or every subscribed Route fails because of owner loading, IPC, timeout, or equivalent terminal errors.

The UI therefore distinguishes **Desktop delivered** from **Recorded only**. A generic “Route accepted” label must not impersonate Desktop receipt.

`server.tts_audio_dir` (or `RABISPEECH_TTS_AUDIO_DIR`) now controls only the fallback used when no persona resolves; its default physical location remains `plugin-adapters/rabi-speech/output/tts-audio/`. Persona TTS cache roots are fixed under their matching role directories and are not redirected by this setting.

### RabiPC frontend/backend contract

RibiWebGUI never connects to port `8781` directly. It talks only to Manager `/api/speech/*`, whose browser contract uses camelCase fields such as `routeId`, `recordThreshold`, `dynamicThreshold`, and `lastSubmitError`. `src/manager/speechControl.ts` maps those fields inside the local adapter to the snake_case payload used by RabiSpeech `/v1/*`. RabiSpeech `/v1/events` is proxied through Manager `/api/speech/events` and pushes microphone level/state, playback-queue, audio-stream, and persisted-record changes. `records_changed` refreshes the records panel only after an ASR/TTS row has been written; unrelated state events do not query records. SSE reconnect performs one snapshot recovery pass. Frontend commands, event streams, error envelopes, and shared state live in `ribiwebgui/src/speech/speechControlClient.ts` and `ribiwebgui/src/stores/speechStore.ts`; Vue pages must not add periodic `fetch("/api/speech/...")` calls.

Manager SSE lifetime is owned by `src/manager/speechEventProxy.ts`. Client disconnect aborts the matching upstream fetch and consumes the resulting AbortError as a normal close, so an unhandled `Readable.fromWeb().pipe()` error can no longer terminate Manager. If a stale running instance returns WebGUI HTML for `/api/speech/events`, both the proxy and closed-loop acceptance fail on Content-Type without falling back to record polling.

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
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/start
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1&chunkId=...
POST https://<relay>/api/rabilink/speech/v1/audio-streams/rabilink/stop
```

Do not give a remote client the local `http://127.0.0.1:8781/v1/...` URL. Ordinary TTS and file-ASR calls are synchronous model requests and do not enter an Agent. Android streaming is different: after PC recognition, RabiSpeech automatically enters the host-wide speech store and `rabilink` Route. `POST /api/rabilink/speech/messages` is compatibility/debug only. See [Call TTS and ASR remotely](user-guide/speech-api_en.md) for copyable PowerShell calls, success criteria, and error recovery.

## Extension and security boundary

Providers implement `TtsProvider` or `AsrProvider` and register locally through `providers.extensions`. Remote clients may select only allowlisted installed models; they cannot install models, load code, or alter provider configuration.

Enabling an external provider changes `/health.local_only` and `/v1/capabilities.relay_safe` accordingly. RabiLink speech relay remains a separate explicit user opt-in.

The API currently returns complete audio/results rather than a streaming first chunk. The default upload limit is 25 MiB. On the tested 16 GiB GPU, large GPU workers load on demand and the global FIFO prevents concurrent model contention.

## Performance and Windows CUDA

The first report covers six TTS and five main ASR models, including cold start/warm-up, warmed requests, model size, capability, test hardware, recommended hardware, smoke accuracy, and Windows CUDA DLL issues:

- [Performance and capability report](rabispeech-performance-report_en.md)
- [Standalone HTML report](../ribiwebgui/public/reports/rabispeech-model-benchmark.html)

An NVIDIA driver does not provide every Python runtime DLL. RabiSpeech installs official NVIDIA wheels into private plugin dependencies and adds their directories only to the service process. Validate with an actual inference and `/v1/capabilities`, not only an import test.
