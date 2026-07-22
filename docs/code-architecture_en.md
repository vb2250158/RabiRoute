<!-- docs-language-switch -->
<div align="center">
English | <a href="./code-architecture.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Code Architecture

> Status: current code map. Module paths, Codex transport, and adapter maturity are aligned with the repository.

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

`src/context/rabiContextManager.ts` is the sole role-context trigger boundary. It maps `session_start`, `user_prompt`, `reasoning_pre_tool`, `reasoning_post_tool`, `message_delivery`, and side-effect-free `preview` to one recall, archival, `viewedAt`, and presentation policy. It is also the only production caller of `roleKnowledgeSnapshot()`.

`AgentPacket` adapts normal routes as `message_delivery`; `manager/codexHookContext.ts` adapts Codex lifecycle events as session, prompt, and reasoning triggers. Both render through `routing/roleKnowledgeContext.ts`. The Codex service only adds session binding, the base persona working set, and `turn_id` delta deduplication; the plugin contains no knowledge or trigger policy. `src/manager/roleKnowledgeRoute.ts` parses role-knowledge paths while `controlPlaneRoutes.ts` exposes the APIs. Role knowledge is handler context and must not affect whether `RouteDecision` matches.

## Frontend and desktop

`ribiwebgui/` is the Vue/Vuetify control surface for configuration, scans, status, logs, and documentation. It is a client of Manager APIs, not the configuration source of truth.

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

`src/shared/speechControlContract.ts` is the stable camelCase interface between Manager and WebGUI and owns Route speech defaults. `ribiwebgui/src/speech/speechControlClient.ts` is the only frontend module that knows `/api/speech/*` paths and the `{ code, data }` envelope. `ribiwebgui/src/stores/speechStore.ts` owns the speech read model, commands, and shared polling lifecycle. `src/manager/speechControl.ts` owns Route policy, RabiSpeech payload mapping, and read-model normalization. `POST /api/speech/messages` waits for the gateway child process to report a real terminal outcome: `delivered` only after the Desktop owner's start/steer succeeds, `recorded` for a keyword-policy record-only result, and a 4xx/5xx response on failure. It does not wait for the Agent answer, Outbox, or TTS playback. Python snake_case and model-runtime details must not leak into Vue pages; RabiSpeech remains an independent loopback provider runtime rather than being merged into Manager. Local providers are the defaults. External API providers require explicit machine configuration, environment-variable secrets, and expose their boundary through `local_only` / `relay_safe` capabilities.

Route `speechPushMode` is the delivery source of truth. `hot` enters the ordinary start/steer path after every completed ASR segment. `keyword` still records the segment but wakes the Agent only when the persona-owned `speechTriggerKeywords` matches. An empty keyword list never falls back to hot delivery.

Host-level waveform, five-stage pipeline, counters, runtime events, and recent transcripts live only in `SpeechHostMonitor` under **Speech Service → ASR**. A Route's **Message adapters → Speech endpoint** section displays only that Route's subscription policy: hot/persona-keyword delivery, persona TTS summary, host/persona responsibility guidance, Agent-reply autoplay, and the single-ASR broadcast explanation. It must not embed the host monitor again.

WebGUI localization is split by responsibility:

- `src/i18n/index.ts` owns the single locale state, browser preference, `<html lang>`, and locale-change event.
- `src/i18n/catalog.ts` contains manually reviewed English UI copy and dynamic-text rules.
- `src/i18n/domLocalizer.ts` applies registered copy to Vue/Vuetify DOM while skipping `data-no-i18n`, code, editable content, and input bodies.
- `src/components/LocaleSwitcher.vue` exposes the top-bar `中 / EN` control.
- `src/pages/ProjectDocsPage.vue` renders `docs/user-guide/*.md` with bilingual task navigation, full-text search, an on-page outline, and shareable `?page=` links. Deeper developer Markdown remains a separate repository source reached through links.

The `rabiroute:webgui:locale` local-storage value is only a browser-side UI preference, never a project save. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values must stay verbatim; dynamic user-data regions are marked with `data-no-i18n`.

`desktop/tray-task-window/` is the optional PySide6/Qt local panel. It reads plans/memory/status and provides role conversation UI; plan and memory views remain read-only. Desktop lifecycle uses the Manager shutdown endpoint.

The tray and RibiWebGUI use the same Manager backend. Qt-free `DesktopRefreshService` calls `/gateways?summary=1`, `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar` through `ManagerClient`, then produces read-only DTOs. The packaged tray does not import `PlanRepository` or `RoleContextRepository` and never reads `data/` directly. Business-free `qt_async` provides the generic thread-pool bridge; `tray_app` only composes UI and applies cached DTOs. Hidden panels request neither conversation/avatar data nor widget rebuilds, refresh application waits while the tray menu is visible, unchanged state does not rebuild menus or panels, and entries beyond five are created lazily. Windows keeps `setContextMenu` registration and uses `activated(Context)` → non-blocking `QMenu.popup()` as a fast path; top-level style and geometry are precomputed. Transient failures may retain a clearly stale snapshot, while a real Manager disconnect must clear live state.

## Plugin adapters

External/companion adapters live under `plugin-adapters/` or `scripts/` when they are independently deployable. They communicate through documented Manager/Relay protocols and must not import private runtime data into public examples.

`plugin-adapters/rabi-speech/` is an independent loopback TTS/ASR provider service, not a message or handler adapter. Its registry can contain local workers, OpenAI-compatible APIs, and native DashScope APIs at the same time, while keeping local defaults and forbidding silent cloud fallback. The benchmark pipeline records TTS generation, WAV output, ASR transcription, cold/load/warm timings, RTF, memory, error rates, and machine metadata; raw runtime artifacts remain ignored while the sanitized HTML report is copied through `ribiwebgui/public/reports/`. The local Manager serves `reports/` at its root, while RabiLink Relay serves the same build directory under the authenticated remote-PC prefix.

The live speech view belongs to the control plane. `src/manager/speechServiceStatus.ts` probes only a loopback RabiSpeech URL and removes private paths. `src/manager/speechControl.ts` then maps models, microphone state, playback, audio-stream selection, persistent speech records, and message commands to `speechControlContract` before the frontend speech store receives them. Audio defaults to the local sound card. When LAN `remote_audio` is enabled, `remote_audio.py` treats an authenticated remote client strictly as a microphone/speaker: the client never owns VAD, segmentation, or models, and disconnect does not trigger silent local fallback. RabiSpeech persists the host playback volume and returns it with playback status; the WebGUI global-queue card updates that `0–100` value only through Manager. Each audio item freezes the value when playback starts, so an adjustment applies from the next item that begins playing; it does not belong to a Route or persona. The host microphone, ASR model, VAD, and segmentation settings also belong only to RabiSpeech and are edited on the Speech Service page through Manager. A Route speech-endpoint toggle is only the subscription source of truth. Manager receives each host transcript once and broadcasts it to every subscribed Route; each Route independently owns hot/persona-keyword delivery and reply-playback policy. Disabling one Route removes only that subscription, and Manager stops the microphone only after the final subscription is disabled. Persona `voice/voice-profile.json` is the single source of truth for TTS model, voice binding, language, speed, and speaking instructions; legacy Route TTS fields are read-only compatibility inputs. The page describes the current PC. The static benchmark describes only its named target machine, so the two must remain separate data sources.

RabiSpeech `speech_records.py` is the single truth source for ASR/TTS text records and follows FenneNote's date-based append pattern. `tts_audio_store.py` separately owns rebuildable finalized-audio caches: resolved persona output goes to `data/roles/<RoleId>/voice/cache/tts-audio/`, while non-persona direct calls use a private RabiSpeech fallback. Both default to a 24-hour per-file mtime window. The Manager read model allows only safe POSIX-style relative references, keeps a bare filename for legacy records, and omits absolute paths, parent traversal, and backslash paths. WebGUI embeds recent persistent bidirectional records in the ASR page and shows the relative cache reference plus expected expiry without turning it into a filesystem link or adding a separate meeting selection/export workflow. Passing the cache window does not change the text record, and raw ASR input audio is still not duplicated by default.

`speaker_profiles.py` owns host-wide person metadata and manual `recordId + speakerLabel` bindings; `speaker_recognition.py` separately owns local neural embeddings, confirmed multi-prototypes, and unknown clusters. Provider `0/1` labels never inherit through a long-lived microphone `sessionId`. The WebGUI dropdown corrects only the selected recording, while also marking that recording's embedding as a confirmed prototype. Later matches require sufficient effective speech, a high best score, and a best-versus-second margin; low-confidence audio remains unknown. Enrollment audio is not copied. Vectors stay in ignored `output/speaker-embeddings.json` and never enter public APIs. A present but unvalidated model can cluster and suggest only; automatic assignment and `voiceprint.supported=true` require `validated=true` after local calibration. Native models are compatibility-probed first by `scripts/speaker_model_probe.py` in an isolated process, so the main service does not directly absorb crashes from untrusted model initialization. The embedding store separately bounds confirmed prototypes and unconfirmed samples and rejects low-RMS or materially cross-speaker-overlapping segments.

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
