<!-- docs-language-switch -->
<div align="center">
English | <a href="./code-architecture.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Code Architecture

> Status: current code map. Module paths, Codex transport, and adapter maturity are aligned with the repository.

## Event-driven red line

By default, the owner of a business-state change emits an event, and Routes, personas, clients, or control surfaces react to it. Where reliable events exist, fixed-interval HTTP requests, full-directory scans, and repeated JSONL reads must not be used to discover whether anything changed. A cursor exists only for gap recovery and idempotency after an event-stream reconnect, never as a polling cadence. Settle, retry, timeout, and Heartbeat use one-shot scheduled events that must have explicit work; they cannot idle-scan. Low-level audio stall watchdogs and SSE/WS transport keepalives do not read business state. A controlled exception is allowed only when the host or upstream explicitly lacks events, SSE, WebSocket, or change notifications and removing polling would break an existing function. The exception must bound its lifecycle and read scope, use a long wait or minute-scale low frequency, support stop/backoff, and document the reason. Exactly five controlled exception classes remain: while the Android foreground service is already known offline, it checks only current OS connectivity every five minutes to cover rare vendors that miss the registered default-network callback, stops immediately after recovery, and never queries Relay, messages, or cursors; DashScope remote asynchronous meeting ASR checks job completion within the request deadline; the explicitly enabled Xiaomi Health ADB Companion has no upstream push API; Rokid AIUI QuickJS uses a 25-second foreground event-backed downlink wait; and visible AIUI pages refresh glasses battery no more often than once per 60 seconds because the host exposes no verified change event.

## High-level flow

```text
src/index.ts
  -> message adapters
  -> history records
  -> src/forwarding.ts
     -> routing/routeDecision.ts
     -> routing/agentPacket.ts
     -> agentAdapters/* / Codex Runtime

src/manager.ts
  -> manager/controlPlaneRoutes.ts
  -> config repository and migration
  -> runtime registry/status
  -> message endpoint managers/scans
  -> Codex Desktop IPC bridge
  -> RibiWebGUI static/API service
```

## Client applications and shared SDK

- `apps/rabilink-android/`: one Android project containing the phone controller and the `glass-app` module.
- `apps/rabilink-aiui/`: the independent Rokid AIUI/Lingzhu client project.
- `packages/android-sdk/`: shared Android event, message, and status contracts consumed by client apps.

These directories are clients of RabiRoute, not sources of truth for Manager configuration or runtime data. Copyable integration samples stay under `examples/`; complete products belong under `apps/`, and only stable cross-app interfaces belong under `packages/`.

## Backend entries

### `src/index.ts`

One gateway subprocess. It loads normalized route configuration, starts gateway-level message adapters, records events, and invokes forwarding. Manager-level endpoints such as role panel and Remote Agent do not start duplicate listeners here.

### `src/config.ts`

Runtime configuration types and environment/default resolution used by the gateway. Shared validation and port ownership belong in `src/shared/gatewayConfigModel.ts` rather than being duplicated in adapters.

## Message path

### `src/adapters/`

Protocol translation for live gateway inputs:

- NapCat/OneBot, including non-blocking `get_msg` fallback through `napcatReplyMessages.ts` when a referenced QQ message is missing from local history.
- WeCom smart-bot WebSocket.
- Webhook-like inputs such as XiaoAI, plus legacy-only FenneNote parsing. New PC speech uses RabiSpeech.
- RabiLink compatibility/input paths.
- heartbeat/manual and other internal adapters.

An adapter should parse, normalize, record, report health, and call forwarding. It should not build handler prompts or send an immediate external reply from an inbound callback.

### `src/history.ts`

Append-only JSONL helpers and record types for protocol-specific messages, packets, Outbox results, adapter logs, and other runtime evidence. These files remain audit and compatibility evidence, but they are no longer separate sources of truth for automatic recent context.

### `src/messageContextStore.ts`

The canonical persona-scoped bidirectional conversation store:

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

`current.jsonl` has no entry-count cap. When an archive check finds any record older than 72 hours, it moves the complete contiguous prefix older than 24 hours into a sequence-range archive. Automatic Agent context reads only `current.jsonl`; archives remain explicit-query evidence. Queries match the current persona, logical endpoint, and conversation, with inbound and outbound records sharing one message-count budget. Attachment records keep only safe metadata rather than private absolute paths. `src/messageContext.ts` is a compatibility facade over this implementation.

### `src/forwarding.ts`

The orchestration center for a matched event:

1. Record the inbound event in each relevant persona's canonical conversation ledger before low-signal or rule filtering.
2. Build a `RouteDecision` for the current route profile.
3. Build an `AgentPacket` for each matched rule.
4. Record the packet.
5. Deliver through the selected handler adapter/runtime and report status/errors.

Keep handler transport and session policy behind the adapter/runtime boundary.

## Routing module

### `src/routing/routeDecision.ts`

Pure routing semantics: route kind, route text, regex, target filters, and matched rules. A decision should not read role memory, send messages, or start a handler.

### `src/routing/agentPacket.ts`

Combines a decision with role context. It creates workspace-relative template values and the generated wrapper containing recent bidirectional messages from the current persona/logical endpoint/conversation, role knowledge, logs, reply API/context, and endpoint-specific delivery instructions. Automatic recent context never reads the archive directory.

When the routed message explicitly asks the Agent to handle multi-PC persona synchronization, AgentPacket adds the one-shot loopback contract for same-application peer discovery, current-persona synchronization, and terminal conflict inspection. Ordinary messages receive no persona-sync prompt. Manager's event-driven automatic reconciler runs independently and is neither created nor owned by packet construction.

When the current message asks who spoke across a day/time range, how user speech differs from other speakers, or how to resolve a voiceprint, AgentPacket adds the current persona's `voice-transcripts` query and append-only `voice-identities` correction contract. Uncertain evidence must remain unknown; the host still makes no identity decision.

`src/routing/agentCapabilityHints.ts` owns these intent-gated capability prompts and their trigger vocabulary. It returns call contracts only: it reads no persona data, performs no HTTP, and decides neither identity nor synchronization targets. AgentPacket only presents the returned lines in the current task, keeping capability discovery out of routing and control-plane ownership.

Packet construction invokes `roleKnowledgeSnapshot`, so matched memory can refresh `viewedAt`. A memory-consolidation run is evaluated only for the explicit `triggerId=memory-consolidation` path.

### `src/routing/types.ts`

Common route-event and decision types shared by forwarding and tests.

## Handler adapters and Codex

### `src/agentAdapters/`

- `agentAdapter.ts`: registry/dispatch boundary.
- `astrbotAdapter.ts`: experimental AstrBot delivery.
- `managerApi.ts`: scan, login, deployment, and adapter-control read models.
- `stateReporter.ts` and ordering helpers: runtime status reporting.

Copilot CLI and Marvis use their dedicated modules outside this folder where appropriate.

### Codex internal boundary

- `src/codexRuntime.ts`: stable task identity, Desktop-owner delivery policy, and high-level create/read/send behavior.
- `src/codexDesktopBridge.ts`: read-only Desktop task discovery plus Desktop IPC start/steer delivery.
- `src/codexAppServerClient.ts`: short-lived metadata driver for creating and naming an empty task; it must not execute real prompts.
- `src/agentThreads.ts`: controlled local thread bridge.

Desktop IPC is the only real-message transport. The target Desktop task owns model, tools, sandbox, approvals, and turn execution. A valid saved task ID is authoritative within its workspace; a stale index title or completed goal must not create a duplicate. Do not introduce shared-port, per-route stdio, CLI, or app-server execution fallbacks.

Matched ordinary messages are delivered immediately: the Desktop bridge first attempts `steer` against an active turn and falls back to `start` only when no active turn exists. There is no general busy-skip switch for ordinary endpoint traffic. Heartbeat may explicitly skip while busy, and speech may explicitly use keyword wake-up instead of hot delivery.

## Outbox / Action Gate

`src/outbox.ts` receives handler replies and resolves:

- route/source context;
- explicit target;
- pipeline and reply-to-source behavior;
- adapter output policy and payload support;
- endpoint credentials/configuration;
- platform sender implementation.

It supports current NapCat, WeCom, RabiLink, and role-panel return paths, retains legacy FenneNote compatibility, and records `sent`, `draft`, `blocked`, or `failed`.

There is no persistent generic Action Queue. Future approval/retry work should be layered on top of this audited result model.

## Manager control plane

### `src/manager.ts`

Starts the loopback Manager, loads route/role configuration, serves WebGUI/API, and coordinates route subprocesses and shared services.

### `src/manager/controlPlaneRoutes.ts`

The current broad HTTP control-plane router. It handles gateway operations, scans, Agent replies/threads, role knowledge, shutdown, and endpoint-specific actions. Continue extracting stable domain helpers instead of growing unrelated inline logic indefinitely.

`RABIROUTE_MANAGER_READ_ONLY=1` is reserved for built-artifact acceptance. It forces Gateway, Relay, LAN discovery, Route-watcher, and persona-file-watcher autostart off, skips startup speech-microphone reconciliation and configuration-directory migration, and rejects POST, PUT, PATCH, and DELETE at the HTTP boundary. `scripts/test-built-manager-readonly.mjs` starts the current `dist/manager.js` on a temporary loopback port, waits for stdout readiness events rather than polling, and reads only the Gateway summary, persona-sync manifest/index status/conflicts, host-wide speech messages, and every manifest persona's voice-identity and voice-conversation views. Read-only reconciliation does not write the manifest cache. Evidence contains only statuses, index mode, counts, and build hashes; it never stores persona names, role IDs, file paths, transcript bodies, people, tokens, Relay URLs, or listener addresses. The existing Manager on port 8790 is not restarted.

### `src/manager/configRepository.ts`

Reads/writes route and role configuration, preserving the split between `adapterConfig.json` and `personaConfig.json`.

### `src/manager/configMigration.ts`

Compatibility normalization at the configuration boundary. Runtime and frontend code should consume canonical fields after migration.

### `src/shared/gatewayConfigModel.ts`

Shared configuration types, normalization, validation, defaults, NapCat instance resolution, port claims/conflicts, and cross-route constraints.

### `src/manager/runtimeRegistry.ts`

Owns the Manager's gateway runtime map. Avoid scattering competing `Map<string, GatewayRuntime>` sources of truth.

### `src/manager/statusPayload.ts`

Builds the Manager status read model consumed by WebGUI and diagnostics.

## Message endpoint management

`src/messageEndpoints/` supports control-plane scans and lifecycle actions:

- `napcatManager.ts`: NapCat Shell/WebUI/token/OneBot setup, launch, health, and instance operations.
- `webhookLikeScans.ts`: generic webhook, XiaoAI, and legacy FenneNote HTTP callback scans.
- `wecomManager.ts`: WeCom SDK, credential, connection/authentication, and recent-message scan.
- `remoteAgentManager.ts`: discovery, challenge authentication, connections, tasks, events, and returned files.

These modules do not replace live gateway adapter code.

## Role knowledge

`src/roleKnowledge.ts` owns:

- plans and delayed archiving;
- recent and consolidated memory;
- consolidation runs/results;
- role skills;
- metadata recall and required-read selection;
- write limits/validation;
- Agent context snapshots.

`src/roleKnowledgePresentation.ts` produces only the read-only Manager presentation DTO. It derives display-only states such as `Blocked` and `Awaiting QA` and owns plan/memory ordering. It never rewrites plan files and does not participate in RouteDecision or Agent-context selection. WebGUI and Qt must consume Manager's `presentation` fields and list order instead of duplicating this policy.

`src/planFeedback.ts` owns approval-feedback JSONL associated with `planId/stepId`, delivery-state collapsing for one `feedbackId`, and read summaries. Manager's `/api/roles/:roleId/plans/:planId/feedback` is the only write boundary: UI submissions may reuse role-panel delivery to notify the Agent, while Agents record QQ approvals or handling results as `record_only`. The module never modifies plan JSON; only a later explicit plan PATCH can advance steps or status.

`src/context/rabiContextManager.ts` is the sole role-context trigger boundary. It maps `session_start`, `user_prompt`, `reasoning_pre_tool`, `reasoning_post_tool`, `message_delivery`, and side-effect-free `preview` to one recall, archival, `viewedAt`, and presentation policy. It is also the only production caller of `roleKnowledgeSnapshot()`.

`AgentPacket` adapts normal routes as `message_delivery`; `manager/codexHookContext.ts` adapts Codex lifecycle events as session, prompt, reasoning, and plan-task `Stop` completion events. Context events render through `routing/roleKnowledgeContext.ts`. A Stop event does not enter recall: it matches the exact plan `taskBinding` stored by `roleKnowledge.ts` and persists `sessionId + turnId` deduplication state.

`manager/planTaskCompletionDelivery.ts` owns the completion handoff. It selects the plan-specified gateway or the only gateway for that persona, rejects a missing target Codex task and source-equals-target loops, writes the role-panel timeline, and invokes the control plane's existing RolePanel trigger. Forwarding, AgentPacket, the Agent adapter, and the target Desktop owner remain the only real-message path. `controlPlaneRoutes.ts` wires dependencies and HTTP; the plugin only forwards official Stop fields and neither changes plan state nor guesses completion from transcripts. The capability remains experimental until verified between two real Desktop tasks. Role knowledge is handler context and must not affect whether `RouteDecision` matches.

## Frontend and desktop

`ribiwebgui/` is the Vue/Vuetify control surface for configuration, scans, status, logs, documentation, and Plans & Memory. `ribiwebgui/src/pages/RoleKnowledgePage.vue` reads `/api/roles/:roleId/plans` and `/memory`; plan content stays read-only, while Manager-declared approval steps can append feedback through the plan-feedback API. The page is a client of Manager APIs, not the configuration source of truth.

`ribiwebgui/src/components/PersonaAvatar.vue` owns consistent WebGUI avatar presentation and initial fallback. `src/personaAvatar.ts` owns persona-directory path constraints, image validation, content-addressed files, and atomic config switching. `src/manager/personaAvatarRoutes.ts` owns `/api/roles/:roleId/avatar` and the presentation DTO; `controlPlaneRoutes.ts` only registers it. Both WebGUI and Qt read avatars through Manager HTTP; Qt no longer resolves persona files through a local `RoleContextRepository`. Avatar metadata is presentation-only and never enters AgentPacket, route matching, or handler delivery semantics.

Speech control has an explicit frontend/backend split:

```text
SpeechServicePage / SpeechHostMonitor
  -> frontend speech store
  -> frontend speech client adapter
  -> Manager speech interface
  -> manager/speechControl.ts
  -> localSpeechClient adapter
  -> RabiSpeech Python implementation
```

`src/shared/speechControlContract.ts` is the stable camelCase interface between Manager and WebGUI and owns Route speech defaults. `ribiwebgui/src/speech/speechControlClient.ts` is the only frontend module that knows `/api/speech/*` paths and the `{ code, data }` envelope. `ribiwebgui/src/stores/speechStore.ts` owns the speech read model, commands, and shared event-stream lifecycle. RabiSpeech `/v1/events` is proxied by Manager `/api/speech/events`; microphone, playback, audio-stream, and persisted-record events update only their matching read models, while an SSE reconnect performs one snapshot recovery pass. No periodic status or record requests are used. `src/manager/speechControl.ts` owns Route policy, RabiSpeech payload mapping, and read-model normalization. `POST /api/speech/messages` waits for the gateway child process to report a real terminal outcome: `delivered` only after the Desktop owner's start/steer succeeds, `recorded` for a keyword-policy record-only result, and a 4xx/5xx response on failure. It does not wait for the Agent answer, Outbox, or TTS playback. Python snake_case and model-runtime details must not leak into Vue pages; RabiSpeech remains an independent loopback provider runtime rather than being merged into Manager. Local providers are the defaults. External API providers require explicit machine configuration, environment-variable secrets, and expose their boundary through `local_only` / `relay_safe` capabilities.

`src/manager/speechEventProxy.ts` owns the one-to-one lifetime between a Manager SSE client and its RabiSpeech upstream stream. When a browser or acceptance client disconnects, only that upstream fetch is aborted. The resulting `AbortError` is a normal terminal event consumed by the proxy rather than an unhandled Node stream error that can terminate Manager. A non-`text/event-stream` upstream fails closed before Manager writes SSE response headers, so stale Manager/WebGUI HTML can never impersonate an event stream.

Route `speechPushMode` is the delivery source of truth. `hot` enters the ordinary start/steer path after every completed ASR segment. `keyword` still records the segment but wakes the Agent only when the persona-owned `speechTriggerKeywords` matches. An empty keyword list never falls back to hot delivery.

Host-level waveform, five-stage pipeline, counters, runtime events, and recent transcripts live only in `SpeechHostMonitor` under **Speech Service → ASR**. A Route's **Message adapters → Speech endpoint** section displays only that Route's subscription policy: hot/persona-keyword delivery, persona TTS summary, host/persona responsibility guidance, Agent-reply autoplay, and the single-ASR broadcast explanation. It must not embed the host monitor again.

WebGUI localization is split by responsibility:

- `src/i18n/index.ts` owns the single locale state, browser preference, `<html lang>`, and locale-change event.
- `src/i18n/catalog.ts` contains manually reviewed English UI copy and dynamic-text rules.
- `src/i18n/domLocalizer.ts` applies registered copy to Vue/Vuetify DOM while skipping `data-no-i18n`, code, editable content, and input bodies.
- `src/components/LocaleSwitcher.vue` exposes the top-bar `中 / EN` control.
- `src/pages/ProjectDocsPage.vue` renders `docs/user-guide/*.md` with bilingual task navigation, full-text search, an on-page outline, and shareable `?page=` links. Deeper developer Markdown remains a separate repository source reached through links.

The `rabiroute:webgui:locale` local-storage value is only a browser-side UI preference, never a project save. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values must stay verbatim; dynamic user-data regions are marked with `data-no-i18n`.

`desktop/tray-task-window/` is the optional PySide6/Qt local panel. It reads plans/memory/status and provides role conversation UI. Plan content and memory remain read-only, while Manager-declared approval steps can append feedback without advancing the plan. Desktop lifecycle uses the Manager shutdown endpoint.

The tray and RibiWebGUI use the same Manager backend. Manager first uses `roleKnowledgePresentation.ts` to derive plan display states, approval capability, and shared ordering; both clients render the returned DTO and order. Qt-free `DesktopRefreshService` calls `/gateways?summary=1`, `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar` through `ManagerClient`, then produces DTOs. Approval submissions use the same client's plan-feedback endpoint and wait through `qt_async`. The packaged tray does not import `PlanRepository` or `RoleContextRepository` and never reads `data/` directly. Business-free `qt_async` provides the generic thread-pool bridge; `tray_app` only composes UI, handles user events, and applies cached DTOs. Hidden panels request neither conversation/avatar data nor widget rebuilds, refresh application waits while the tray menu is visible, unchanged state does not rebuild menus or panels, and entries beyond five are created lazily. Windows does not register implicit `setContextMenu`; presentation-only `TrayMenuController` maps both left-click `Trigger` and right-click `Context` directly to non-blocking `QMenu.popup()` on the prewarmed menu, while double-click does not reopen it. Transient failures may retain a clearly stale snapshot, while a real Manager disconnect must clear live state.

## Plugin adapters

Raw speech messages carry whole-utterance RMS and peak as PCM loudness facts from RabiSpeech through `SpeechIngressStore`, Route events, persona `voice-transcripts.jsonl`, and `conversation/current.jsonl`. These fields serve thresholds, quality checks, and diagnostics only; they never contribute to a host identity or “who is the user” decision, whose interpretation remains persona-owned. Disabling pre-roll does not change audio ownership: with `pre_roll_ms=0`, the first PCM block that triggers VAD still belongs to the current utterance.

External/companion adapters live under `plugin-adapters/` or `scripts/` when they are independently deployable. They communicate through documented Manager/Relay protocols and must not import private runtime data into public examples.

`plugin-adapters/rabi-speech/` is an independent loopback TTS/ASR provider service, not a message or handler adapter. Its registry can contain local workers, OpenAI-compatible APIs, and native DashScope APIs at the same time, while keeping local defaults and forbidding silent cloud fallback. `AudioTranscoder` is the finalized-audio preparation owner shared by every provider, persona TTS, and direct HTTP call. A WAV-only sample-rate change uses local NumPy + SoundFile resampling and does not depend on the host process PATH; cross-format conversion alone invokes explicitly configured or discoverable ffmpeg. Callers and individual providers must not maintain a second output-resampling rule. The benchmark pipeline records TTS generation, WAV output, ASR transcription, cold/load/warm timings, RTF, memory, error rates, and machine metadata; raw runtime artifacts remain ignored while the sanitized HTML report is copied through `ribiwebgui/public/reports/`. The local Manager serves `reports/` at its root, while RabiLink Relay serves the same build directory under the authenticated remote-PC prefix.

The live speech view belongs to the control plane. `src/manager/speechServiceStatus.ts` probes only a loopback RabiSpeech URL and removes private paths. `src/manager/speechControl.ts` then maps models, microphone state, playback, audio-stream selection, persistent speech records, and message commands to `speechControlContract` before the frontend speech store receives them. Audio defaults to the local sound card. When LAN `remote_audio` is enabled, `remote_audio.py` treats an authenticated remote client strictly as a microphone/speaker: the client never owns VAD, segmentation, or models, and disconnect does not trigger silent local fallback. RabiSpeech persists the host playback volume and returns it with playback status; the WebGUI global-queue card updates that `0–100` value only through Manager. Each audio item freezes the value when playback starts, so an adjustment applies from the next item that begins playing; it does not belong to a Route or persona. The host microphone, ASR model, VAD, and segmentation settings also belong only to RabiSpeech and are edited on the Speech Service page through Manager. A Route speech-endpoint toggle is only the subscription source of truth. Manager receives each host transcript once and broadcasts it to every subscribed Route; each Route independently owns hot/persona-keyword delivery and reply-playback policy. Disabling one Route removes only that subscription, and Manager stops the microphone only after the final subscription is disabled. Persona `voice/voice-profile.json` is the single source of truth for TTS model, voice binding, language, speed, and speaking instructions; legacy Route TTS fields are read-only compatibility inputs. The page describes the current PC. The static benchmark describes only its named target machine, so the two must remain separate data sources.

RabiSpeech `speech_records.py` is the single truth source for ASR/TTS text records and follows FenneNote's date-based append pattern. `tts_audio_store.py` separately owns rebuildable finalized-audio caches: resolved persona output goes to `data/roles/<RoleId>/voice/cache/tts-audio/`, while non-persona direct calls use a private RabiSpeech fallback. Both default to a 24-hour per-file mtime window. The Manager read model allows only safe POSIX-style relative references, keeps a bare filename for legacy records, and omits absolute paths, parent traversal, and backslash paths. WebGUI embeds recent persistent bidirectional records in the ASR page and shows the relative cache reference plus expected expiry without turning it into a filesystem link or adding a separate meeting selection/export workflow. Passing the cache window does not change the text record, and raw ASR input audio is still not duplicated by default.

`speaker_profiles.py` owns host-wide person metadata and manual `recordId + speakerLabel` bindings; `speaker_recognition.py` separately owns local neural embeddings, confirmed multi-prototypes, and unknown clusters. Provider `0/1` labels never inherit through a long-lived microphone `sessionId` and no longer own voiceprint sample grouping. When one Provider label spans multiple disjoint time turns, the raw value remains in `speaker`, while the voiceprint layer creates per-turn `speakerLabel` values, extracts each embedding independently, and lets opaque clusters decide whether those turns contain the same or different voices. A wrong label therefore cannot concatenate different people into one sample, while genuinely repeated speech still converges to one voiceprint. The WebGUI dropdown corrects only the selected recording turn, while also marking that turn's embedding as a confirmed prototype. Later matches require sufficient effective speech, a high best score, and a best-versus-second margin; low-confidence audio remains unknown. Enrollment audio is not copied. Vectors stay in ignored `output/speaker-embeddings.json` and never enter public APIs. A present but unvalidated model can cluster and suggest only. Formal automatic assignment additionally requires `validated=true`, `real_person_private` dataset eligibility, complete dataset/policy/model SHA-256 proofs, and a passing target-engine gate; any missing or mismatched proof fails closed with `voiceprint.supported=false`. `scripts/speaker_model_probe.py` runs real inference in an isolated process. Production extraction uses an ONNX Runtime + kaldi-native-fbank 16 kHz / 80-bin / global-mean backend, avoiding the Windows sherpa native pipeline's format rejection of the official model. The embedding store separately bounds confirmed prototypes and unconfirmed samples and rejects low-RMS or materially cross-speaker-overlapping segments.

`src/speechIngressStore.ts` is RabiRoute's host-wide raw speech-message source of truth. RabiSpeech submits one stable record ID, capture start/completion/ingestion times, provider, model, language, duration, peak level, sample rate, channels, audio format, channel, stable source-device metadata, transient stream ID, complete speaker turns, and available word timing/confidence to Manager. `src/shared/speechTranscript.ts` is the common portable segment/word normalization entry for Python snake_case, HTTP responses, and persona ledgers, while `src/routing/speechIngressForwarding.ts` is the single field-mapping entry from a host raw record to a `speech/rabilink` Route event. Manager removes host person names, profile IDs, candidate-profile IDs, and verified-person flags, retaining only opaque voiceprint/cluster IDs, diarization labels, scores, decision evidence, and word timing before appending `data/speech/messages/YYYY-MM-DD.jsonl`. The same scrub runs when persona `conversation/current.jsonl` is written or read, so legacy rows cannot re-inject host identity judgments into persona context. Record-ID lookup and raw-message append share a cross-process lock, and daily Route-receipt appends are serialized, preventing duplicate replay rows or interleaved JSONL. ASR processing and logical endpoint selection are separate: the host microphone or an ordinary Rabi Voice Client emits `messageAdapterType=speech`; Android phone/glasses continuously transport ordered PCM through Relay, then emit `messageAdapterType=rabilink` only after host VAD, segmentation, ASR, and voiceprint processing. Android owns no second ASR/VAD truth source. Stable `sourceDeviceId` owns reply addressing; transient `sourceStreamId` identifies only the current PCM connection and never targets downlink. Sequences begin at 1 and remain contiguous, and Android advances only after PC acknowledgement. The pending chunk keeps a stable `chunkId` across transient stream rebuilds. For each stable `sourceDeviceId`, RabiSpeech retains the `chunkId + PCM SHA-256` of the last accepted chunk, storing identifiers and hashes only. A cross-stream retry after a lost ACK therefore does not enter VAD/ASR again, while subsequent new chunks continue under the rebuilt stream's sequence. Android's system connectivity callback and the existing RabiLink SSE `ready` event immediately wake pending PCM; only temporary service unavailability uses one-shot backoff. A bounded newest-audio buffer discards obsolete PCM during long outages so recovery catches the live stream instead of remaining permanently behind. `start` and each accepted chunk rearm one 15-second expiry event; only expiry retires the virtual client and restores the previous input, with no fixed-interval scan. Manager delivers only to Routes that enable the matching endpoint. `routeProfileId` is a generic Route selector, not a source-type marker; source identity comes from `routeKind/adapterType`, so mobile audio cannot become a role-panel event merely because it selects a profile. `forwarding.ts` still owns the Route-to-persona relationship, so different personas receive their own `voice-transcripts.jsonl` and `conversation/current.jsonl`, while multiple Routes sharing one persona do not duplicate the row. On a persona's first write, the canonical conversation ledger is initialized/appended before the compatibility raw-history file so the current event cannot be imported again as legacy history. Phone audio enters the Agent as `routeKind=rabilink`, and the reply API defaults to the originating `sourceDeviceId`. Each persona interprets who a voiceprint belongs to, who the user is, and whether to respond from its own relationships and context.

Mobile downlink follows the same ownership rule. Relay owns messages, explicit targets, and device receipts. The phone owns the cursor, reliable queues, local playback orchestration, durable message-restore intent, and the user's single requested `PAUSED / PHONE / GLASSES` mode; the foreground Service owns actual runtime mode, capture, and connection state; glasses own only peripheral state and the physical fact that their speaker reached completion. A transition releases the old capture path first, and capture stays paused before a real glasses connection event or after disconnect, never silently enabling two microphones. Activity rebuilds its runtime card from `RUNTIME_UPDATED` broadcasts rather than polling business state. Explicit proactivity is durably transported as a `rabilink.preference` observation and source metadata; neither App nor Relay owns the intervention rule. Phone-private text, control, media, receipt, and downlink queues share fsync plus atomic replacement. Startup removes temporary files and quarantines malformed JSON, missing binaries, and orphaned attachments with visible errors so one poison item cannot block later work. `/api/rabilink/events` `outbox_available` is a wake-up signal, after which Android performs one persisted-cursor delta query for gap recovery. While Android knows the device is offline, its SSE connection and reliable sender block on a Connectivity-callback event gate instead of reconnecting at a fixed interval. Only to cover a vendor missing an already registered callback, the foreground service checks current OS connectivity every five minutes while known offline, stops immediately after recovery, and returns to the SSE `ready → cursor` one-shot catch-up without querying Relay business state. Only an available network with a server failure uses one-shot 1–30 second backoff. Relay emits an SSE keepalive every 15 seconds; 45 seconds without any SSE bytes triggers a transport-stall deadline that rebuilds the half-open socket and returns to the same one-shot cursor catch-up without adding business polling. Restore intent is separate from continuous listening: a started text/media/downlink service restores its cursor and reliable queues after process or device restart, while explicit Stop clears that intent. An Outbox message with explicit `targetDeviceIds` does not TTL-expire until every explicit target returns `delivered`; broadcasts and kind-only targets retain bounded TTL behavior. `delivered` is not `played`: phone and glasses produce `played` only after their own `AudioTrack` marker, persist the receipt to a phone-private disk queue first, and replay it after reconnection. Relay only stores the fact and emits `outbox_receipt`. Glasses BEGIN, PCM, and END share one ordered Classic-BT channel so END cannot overtake audio. The playback worker waits until the main thread confirms capture is paused before accepting PCM, and Activity destruction reports unfinished playback as `playback_failed`; legacy unframed PCM may play for compatibility but cannot produce a success receipt.

`src/acceptance/speechIngressSeparation.ts` and `scripts/test-speech-ingress-separation.mjs` compose those boundaries into isolated built-artifact acceptance. In a temporary data root, the tool writes one PC-microphone record and one mobile record into the same host store and invokes the real `dist/index.js --speech-message` child process for each. It requires exactly two logical endpoints in the host store, one voice-history row and one canonical-conversation row for each of two different personas, no mobile target in the PC context, a mobile reply target derived only from stable `sourceDeviceId` rather than transient `sourceStreamId`, and no host person guess in persona files. Children use an isolated Agent adapter that opens no window or clipboard and never connect to the real Manager, Desktop, QQ, or Relay. The temporary root is removed at completion, leaving only sanitized counts, hashes, and terminal evidence.

`src/personaVoiceIdentities.ts` owns persona-scoped voice-relationship events. Host speech messages and AgentPacket provide only `sourceHostId/sourceHostName` plus opaque voiceprint evidence. Through `/api/roles/:roleId/voice-identities`, a persona appends its own `displayName/relationship/isUser/aliases/notes` to `voice/voice-identities.jsonl`. The identity key combines processing host and voiceprint ID so local cluster IDs cannot collide across PCs. Identical updates are not re-appended; corrections and deletions use new events or tombstones rather than creating a Manager-owned person source of truth. Each new event records its current heads through `supersedes`; concurrent PC branches remain present after JSONL union, the read model derives conflicting fields, and a later persona PUT explicitly converges every head instead of letting file order decide identity.

`src/personaVoiceTranscriptView.ts` is the read-only join for persona voice relationships, while `src/manager/personaVoiceTranscriptRoutes.ts` owns only the stable HTTP boundary. `GET /api/roles/:roleId/voice-transcripts` combines raw conversation-ledger voiceprint evidence with the current persona's relationships into per-segment `user/other/unknown/conflict` views at query time. It supports time, archive, and speaker filters and derives classified duration, coverage rate, and unresolved voiceprints from the complete filtered set; the detail `limit` does not truncate `matchedCount` or the summary. The layer writes no derived name, `isUser`, or statistics back to either source of truth.

RibiWebGUI reuses those two APIs through `personaVoiceIdentityClient.ts` and creates no browser-side voiceprint repository. The persona page's latest-24-hour panel requests `includeDetails=false`, receiving only the summary plus the separate relationship list and no transcript text. Loading, button-busy, error, and notice values are transient presentation state. `personaVoiceConfirmation.ts` stores only one user-initiated attempt's start time, the unresolved voiceprints' starting `lastSeenAt` baseline, waiting/found state, and candidate composite keys. Candidates are unresolved voiceprints with a stable host identity that appear or advance beyond that baseline after the next speech-record event; this changes ordering and markers only and never creates or persists an identity conclusion. The page queries once on entry, persona change, or an explicit user action, and listens for RabiSpeech `records_changed` plus Manager `persona_voice_identity_changed` and `persona_sync_manifest_changed` events. SSE reconnection performs one catch-up query rather than coverage polling.

`src/personaSync.ts` owns local persona reads, archives, merge behavior, and explicit conflict resolution. `src/personaSyncManifestIndex.ts` owns the rebuildable persistent manifest index, one startup reconciliation, and recursive runtime file events. Reconciliation reuses unchanged SHA-256 values through size, mtime, ctime, and file identity; a concrete file event rehashes only its path. Index changes emit `persona_sync_manifest_changed` through Manager SSE. Manifest queries read the index; only hosts without reliable file events reconcile once before a query, with no fixed-interval scan. `src/personaSyncCoordinator.ts` owns peer discovery, transport orchestration, and publication of resolved versions. `src/personaSyncAutoReconciler.ts` owns only event scheduling plus the durable `auto-sync-state.json` pending marker and duplicates no merge semantics. Local file changes, Relay `ready`, and `persona_sync_peer_changed` wake one coalesced full or persona-scoped Coordinator reconciliation. Offline peers wait for another event; temporary online failures use bounded one-shot backoff. `src/manager/personaSyncRoutes.ts` owns the constrained HTTP contract and exposes body-free diagnostics through loopback-only `index-status/auto-status`; `src/manager/personaSyncLanServer.ts` is a dedicated data-plane listener advertised on private IPv4 addresses. It permits only remote manifest, file, and merge operations and never exposes the full Manager/WebGUI control plane. The coordinator first tries this Relay-advertised LAN URL, then falls back to Relay `/api/rabilink/persona-sync/proxy`, which reuses the global worker to reach the target loopback Manager. Relay does not store a master persona. JSONL uses union merge, while ordinary files use common hashes scoped by the application-token hash and stable peer GUID for fast-forward. A one-sided absence with a known common baseline propagates as a deletion after archiving the removed file; concurrent delete-versus-edit carries `remoteDeleted`, peer, and baseline hash into `data/persona-sync/conflicts/`. Listing, reading evidence, and `keep_local/use_remote/use_merged` resolution are loopback-only; resolution checks the current local hash, `use_remote` confirms deletion for a deletion conflict, and old evidence plus metadata moves to `resolved-conflicts/` with an audit record. The coordinator then uses the captured remote hash as the publication base and sends the resolved result back through LAN or Relay. If either endpoint changed, it returns `not_published`, retains new pending scope, and never claims convergence. Concurrent sync for one peer/persona is single-flight; files and baseline state use locks plus atomic writes. `conversation/` merges reuse the message-context lock, while voice transcripts and persona voice relationships reuse their own file locks, preventing synchronization replacement from interleaving with live appends. Reads and merges inspect the full parent chain and reject symbolic links or Windows junctions. Locks, the manifest index, temporary files, and rebuildable TTS caches are excluded from synchronization.

`ribiwebgui/src/components/PersonaSyncCard.vue` stores only rebuildable page loading, preview, button-busy, notice, and error state. Through `personaSyncClient.ts` it reads peers, index/automatic status, and conflicts, then submits explicit synchronization or basic resolution commands. Merge, deletion, conflict, retry, and convergence semantics remain backend-owned. The page performs one catch-up query on `persona_sync_manifest_changed`, `persona_sync_auto_status`, and Relay/LAN status events and defines no business polling loop.

`src/acceptance/personaSyncDualNode.ts` and `scripts/test-persona-sync-dual-node.mjs` exercise this orchestration with two temporary persona roots, the real Relay Server, a real target worker/Manager data plane, and the dedicated LAN listener. The first phase proves LAN-first JSONL/file/deletion/voice-semantic conflict behavior and resolution publication. Then only the reachable peer URL is removed to force the real Relay fallback. Evidence retains no token, port, persona, or file body. Relay stdout and worker SSE status events own readiness sequencing instead of service-status polling.

## Tests

Tests live beside source modules as `*.test.ts`. Routing tests verify pure decision and packet behavior; Outbox tests verify policy and platform sends; Manager/endpoint tests verify control-plane contracts and security boundaries.

## Common change entry points

| Change | Start here |
| --- | --- |
| New message source | `src/adapters/`, endpoint scan/manager module, shared config model, tests, bilingual docs. |
| New handler | handler adapter/registry, scan/status API, forwarding integration, tests. |
| Route semantics | `routing/routeDecision.ts` and tests. |
| Handler context | `routing/agentPacket.ts`, role knowledge, packet tests, context docs. |
| External reply | `outbox.ts`, adapter policy/config, sender tests, interface docs. |
| Manager API | `manager/controlPlaneRoutes.ts`, extracted domain helper, frontend client, tests. |
| Plan/memory/skills | `roleKnowledge.ts`, role API parser/control plane, validation tests. |
| WebGUI form | Vue page/component plus shared config schema and bilingual user docs. |

## Red lines

- Preserve router/handler separation.
- Keep `RouteDecision` free of role-memory and external side effects.
- Keep formal Codex delivery on Desktop IPC and the target task owner.
- Route external output through Outbox.
- Treat experimental integrations as experimental until real acceptance.
- Keep public examples credential-free and runtime data out of Git.
