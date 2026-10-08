<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi mobile Android project

This directory is the RabiLink phone companion and bundled glasses frontend project. Keep the stable path `apps/rabi-mobile-android/`; look here for APKs, the Gradle project, and mobile recording/voice-capture sources.

[All-day recording integration](../../docs/rabilink-all-day-recording_en.md) is in progress: one `RabiConversationService` owner coordinates phone, glasses and health. Separate local-audio/video/device-status services have been removed; video uses an ordinary controller, audio the durable spool, and health a master-permission/window-bound controller. The [UI guide](../../docs/rabilink-mobile-recording-ui_en.md) separates source changes from historical device evidence. Video audio is derived only after stop; PC transcription-only capability/worker fencing is connected in source, with unsupported work deferred. CaptureId read-only association manually refreshes at most 200 results over the last 24 hours by processedAt; missing IDs are not guessed. Health unifies capture/status only; complete history remains on PC. Opening the app enables recording, subject to microphone permission and Android boot restrictions. Source removes the application recording-capacity limit and pauses only for insufficient physical free space. History is cached after the first read and updated incrementally on file changes, without recurring loading/update messages. Automatic phone-original cleanup requires a strong [PC archive](../../docs/mobile-recording-archive_en.md) receipt plus verified remote history and audio readback; transcription or transport ACK alone cannot authorize deletion. The installed phone version still needs an in-place upgrade. Source edits or historical tests do not establish acceptance of this refactor.

[Offline glasses recording and live preview](../../docs/rabilink-offline-recording_en.md): native glasses streaming to the phone, local preview, segmented recording and replay; implementation and device verification are in progress.

> Status: experimental app. This is the primary Android project for the RabiLink phone companion and embedded glasses frontend. Xiaomi Health, Rokid, and ADB diagnostics remain available, while several hardware paths still require real-device acceptance.

The separate `glass-video-app/` recorder is bundled with the phone debug build; automatic installation has not passed device acceptance. Read [Rokid development sources and troubleshooting](../../docs/rokid-development_en.md) and its skill entry before changes. CXR-M is excluded; commercial-integration suggestions in older research no longer apply.

Users install one phone APK. The project also builds the glasses frontend that the phone delivers through the CXR workflow. Hardware probes remain under advanced diagnostics instead of defining this project as an example:

```text
com.rabi.link
```

## Skins and appearance

Open **Messages → Settings → Skins and appearance** to choose System, Light (Clear Teal), or Dark (Night Teal). Changes apply immediately, survive restarts, and affect only this phone. Recording, the timeline, messages, settings, platform dialogs, and system bars share the selected skin; video areas keep a dark background. The current application labels are in Chinese.

During Android builds, `scripts/generate-mobile-theme.mjs` generates colors from WebGUI's `ribiwebgui/src/themes/{light,dark}/tokens.css` into `app/build/generated/mobileTheme/`. Do not edit generated files. Importing WebGUI custom skins is not currently supported on mobile.

Recording and device cards use 8dp gaps between controls; skin previews have a 12dp gap before the selection button. Shared bottom navigation includes outer padding and gaps between destinations, highlights only the current page in teal, and keeps touch targets at least 48dp tall.

## Current product route (2026-07-20)

The project now builds one phone companion and one glasses frontend:

```text
glasses com.rabi.link.glass
  <-> audio/media/status only
phone com.rabi.link
  <-> Relay, selected PC, cursor, and glasses settings
RabiLink Relay
  <-> Rabi PC glasses endpoint owns ASR, TTS, Agent, and action gates
```

- `GlassAudioClientActivity` is the default glasses entry. `glass-app/` is the glasses application module; the primary path handles audio, media, status, and HUD presentation without running ASR/TTS locally.
- Bottom navigation has Records and Messages. Records opens the timeline, with a top start/pause switch and an upper-right recording-device grid. Messages lists selectable mobile chat routes, keeping separate routes for the same persona. The Phone entry at the upper right of chat freezes the selected computer and route and reuses recording and PC transcription for voice conversations. Speech is half-duplex; natural interruption is unsupported. Late replies after hangup remain messages without automatic playback. See [mobile voice calls](../../docs/mobile-voice-call_en.md). Settings, health, and glasses remain separate surfaces.
- The recording correction is in progress, without completed tests, deployment or device acceptance: Android segments according to PC `MicrophoneConfig` rules for 100 ms frames, 1500 ms in-memory pre-roll, onset/continuation thresholds, adaptive noise estimation, minimum accumulated voiced duration, trailing silence and maximum segment duration. It saves acoustically valid segments and calls the PC only for transcription; ASR and voiceprints do not run on the phone. Empty ASR text does not mean acoustically invalid audio. Pause `finish` uses the normal minimum-validity threshold, unlike the PC stop path that can use `min=0`. Historical Agent streams retain the restricted `audio-streams/rabilink/start|chunk|stop` contract and frozen `routeProfileId`; they are not a requirement to upload all newly captured audio. Transcription-only capability/worker fencing is connected in source, pending final regression; unsupported work is deferred rather than downgraded to Agent delivery. Stream start submits stable `source_device_id` separately from transient `stream_id`, so normal replies target the real device rather than an audio-suffixed stream identity. `/api/rabilink/speech/messages` remains compatibility/debug only; spoken output is synthesized by Rabi PC TTS and streamed back as PCM when requested.
- The glasses HUD shows explicit Connect / Listen / Upload / Speak / Paused / Error states. The phone sends `PLAYBACK_BEGIN → PCM → PLAYBACK_END` over the same ordered Classic-BT channel. The playback worker does not accept PCM until the main thread has confirmed capture is paused, preventing the beginning of TTS from being recorded back into the microphone. Glasses validate message identity and PCM length and return `played` only after the `AudioTrack` playback head reaches its marker; Activity destruction reports an unfinished playback as `playback_failed`. Legacy PCM without BEGIN/END may still play for compatibility but is never reported as confirmed playback.
- Photos are wired as message attachments. [Direct phone-to-PC video](../../docs/rabilink-direct-video_en.md) now has a verified physical-phone data channel; the glasses Phone SDK Bluetooth connection still fails and no camera frames have arrived. Only explicit video builds include the video SDK. Video never uses Relay or a TURN fallback.
- Persona avatars are served through the Manager's controlled avatar endpoint and proxied by Relay. The phone caches only the proxied binary and opaque version. Conversation metadata and local messages render immediately; avatars load independently and expose loading, cache-validation, stale-cache, and unavailable states. A `persona_avatar_changed` SSE event refreshes only the matching persona.
- `RabiConversationService` owns the message cursor, notifications, and phone/glasses I/O. `RabiPhoneAudioCapture` owns the wake lock, stall detection, bounded restart, and health metrics. The in-progress correction validates audio in memory before persistence: only acoustically valid segments, not pure silence or segments below the minimum voiced duration, are fsynced into phone-private dynamic `.partial` shards and atomically sealed with a monotonic id, timestamps, byte count, SHA-256, and upload state. Capture does not wait for Relay/PC/network I/O. Transport is confirmed only after a matching `sequence + chunkId + accepted_bytes + sha256` acknowledgement. New record shards are not automatically deleted by legacy transport retention; automatic rolling deletion is not implemented.
- `AllDayRecordingSettings` is the one persisted source of truth, separating audio/audio-video/health-only, phone/glasses source and running/paused. Switching to glasses pauses the phone microphone first. Glasses PCM starts only after a real glasses Bluetooth connection event; before connection or after disconnect, capture stays paused with a visible reason and never silently falls back to dual capture. The runtime card refreshes from service broadcasts and shows connection, selected Route/persona, capture, glasses, reliable queues, and the latest error without one-second business-state polling.
- The current review correction requires the event list and timeline to show every saved recording, without filtering by nonempty ASR text. Valid segments remain playable in local-only, pending, processing, failed and empty-transcript states. Failures expose a reason; empty text never justifies hiding or deleting audio. Existing recordings remain intact without bulk deletion. Only transcription is delegated to the PC; ASR text does not determine acoustic validity. Tests and device acceptance remain pending, and offline states must not appear as live success.
- Users can choose `Agent decides / Quiet / Balanced / Proactive`. The value is durably queued as an explicit preference observation and attached to phone text, control, media, and audio-stream metadata. Neither the App nor Relay converts it into a fixed intervention rule. No interruption, preparation, prompt, recommendation, confirmation, or action remains a PC context/Route safety/target-Agent decision.
- Phone-private reliable queues use fsync plus atomic replacement. Startup removes incomplete temporary files; malformed JSON or missing media binaries are moved into quarantine with a visible error so later queue items can continue.
- AIUI feature work is paused; old speech probes remain historical diagnostics only.

The embedded glasses APK is installed by the phone CXR workflow, so the user still installs only one phone APK.

Follow-up integrity corrections are still in a local build and have not passed deployment acceptance: complete valid segments must pass `expectedBytes` / hash validation and the `prepared` / `committed` gate; partial data remains `deferred` without automatic ASR. Derived video audio uses the same splitter and stable event IDs based on source offsets. v2 freezes the policy; legacy complete work is retained, while legacy incomplete work requires explicit recovery. Idle settings update at 100 ms boundaries; active utterances retain frozen settings. A first-frame-anchored sample clock supplies event timestamps rather than back-calculating from the completion wall clock. The early deployed package's evidence from 179 unit tests and a visibility/pagination fixture test containing 205 recordings does not cover these changes; see the [segmentation and recovery contract](../../docs/rabilink-mobile-recording-ui_en.md#audio-event-splitting).

Diagnostics distinguish capture health from valid-segment persistence; see [mobile audio health evidence](../../docs/mobile-audio-health-evidence_en.md). For optional diagnostics of the always-on audio path, run:

```powershell
.\scripts\Test-RabiMobileDurableAudioSoak.ps1 -Serial <adb-serial> -Mode Offline -DurationHours 24
.\scripts\Test-RabiMobileDurableAudioSoak.ps1 -Serial <adb-serial> -Mode Online -DurationHours 72
```

Acceptance of acoustic filtering must use known input containing valid sound and silence. Persisted sequences need not advance during pure silence; that alone does not indicate stalled capture. Offline persistence acceptance uses phone-local `lastWrittenAt`, `nextSequence`, and `rejectedBytes`; online acceptance additionally requires `lastUploadedAt` and the RabiSpeech sequence to advance. The monitor reads metadata and counts only, never tokens or PCM. `Start-RabiMobileDurableSoak.ps1` runs a recoverable 24-hour offline phase followed by a 72-hour online phase and restores the captured network state in `finally`. Short fault injection does not count as either long soak.

Each app installation creates its own stable `rabi-phone-*` device id and reuses a stable audio stream id across reconnects. Several phones register automatically with RabiSpeech and may remain online together; a later phone never steals the input selected in the speech-service page. Only the selected phone feeds VAD/ASR, while a temporarily offline selection is retained and resumes after reconnect.

`AllDayRecordingSettings` unifies `mode=audio|video|health`, `source=auto` (automatic audio; glasses for video), `processingPolicy=local_only|transcribe|agent`, and `running/healthEnabled/uploadEnabled/autoResume/windowStartedAt`. Upgrades default to `running=false`; the transcription default does not start capture. The legacy startup-voice switch is no longer a second capture authority. `autoResume` persists the user switch; `running` represents the current capture request. Runtime failures preserve the switch; explicitly disabling recording cancels restoration. Boot restores background transport and posts an app-opening notification. A foreground app launch resumes enabled recording when microphone permission is granted. Vendor autostart restrictions may require enabling app autostart; the app does not force-open its UI or bypass Android microphone restrictions.

The current correction replaces full-stream persistence with Android acoustic segmentation and valid-segment-only storage. Continuous capture does not mean continuous saving; pre-roll stays in memory. The reliability and recovery rules below apply to accepted valid segments and retained historical shards, not a requirement to persist silence. The audio callback only enters a bounded receive queue, while a dedicated single writer owns `.partial`, `fsync`, atomic sealing, and explicit backpressure gaps. Each shard keeps a stable sequence, `chunkId`, source, Route, byte count, checksum, and upload state. A process restart recovers a partial only from its durable ownership sidecar. Corrupt metadata, missing PCM, and checksum failures quarantine the related pair, write a stable gap, and unblock later shards; quarantine counts toward the storage watermark and is deleted only after an explicit user confirmation in Audio & Transcripts. Android connectivity events or a restored RabiLink SSE connection wake upload immediately. While Android knows the device is offline, transport waits on the system network event gate. Each queued shard is uploaded only through a stream matching that shard's source and Route. RabiSpeech persists the processed `source + chunkId + bytes + SHA-256` tuple in a local idempotency ledger, so replay after a lost ACK and RabiSpeech process restart is acknowledged without entering ASR twice. Reliable text/media/receipt facts remain until acknowledged. PC-finalized ASR segments and Agent TTS follow the RabiSpeech contract: per-file 24-hour caching plus daily JSONL metadata with safe relative paths and expiration times.

The Devices page exposes Wearable Health settings with a Health Connect or “Xiaomi Health (PC ADB Companion)” source selector, stable device identity, sync/lookback periods, thresholds, cooldown, and sleep-state alerts. The Health Connect source collects heart rate, sleep, and steps together; steps are aggregated per local calendar day under a segment-independent stable ID, so re-reading the same day is deduplicated downstream rather than double-counted, and steps never trigger heart-rate or sleep alerts. An obtained Xiaomi authentication key is AES-GCM encrypted through Android Keystore and remains phone-local. Health Connect prefers manual, startup-recovery, or platform events. Xiaomi's ADB Provider exposes no reliable change notification, so an explicitly enabled PC Companion keeps a low-frequency poll at the phone-configured minute-scale interval. The sole `RabiRouteHost.exe` owns that Companion through the Manager plugin kernel and a generation process lease; `/meta` plus both identity headers fence the dynamic READY endpoint, with no logon task and no saved or guessed Manager port. Structured samples enter the RabiRoute health timeline instead of the conversation ledger. See [`../../docs/rabilink-wearable-health_en.md`](../../docs/rabilink-wearable-health_en.md).

### First-run setup and failure guidance

- The computer connection setup automatically scans the local network for Rabi PCs. After RabiLink login, a single online worker is selected automatically, so a first-time user does not need to understand workers, routes, or cursors.
- Connection details supplied by an installer, pairing payload, or future QR flow are filled automatically. When the RabiLink URL or mobile login code cannot be obtained safely, the page explains the security boundary and where to copy it from Rabi PC.
- The page header only summarizes overall state. When a field fails, its reason, expected value, source, and fix stay directly below that field instead of forcing users to map a separate “why” section back to the form or rely on transient toasts.
- Common fields, selectors, and actions share one Rabi mobile component scale. Device IDs, controlled polling/lookback windows, model fields, and thresholds are hidden under Advanced settings by default.
- Wearable setup prefers Health Connect and can generate a stable device ID and source name. Save and enable validates RabiLink, the system Health Connect provider, or the Xiaomi key first; if a prerequisite is missing, it saves a disabled draft instead of claiming that sync succeeded.
- The Rokid screen defaults to a six-step connection guide: automatic environment check, phone permissions, Rokid authorization, link, glasses-side installation, and launch. The SDK matrix and logs are collapsed; steps that require system confirmation explain why they cannot be completed silently.
- The test center, RabiRoute SDK, Xiaomi BLE/cloud, Provider-boundary, and OAuth screens now share the Rabi component system. They are explicitly labeled as advanced diagnostics, and raw logs stay collapsed so first-time setup never depends on developer pages.

### Everyday chat and navigation

- Settings' “电脑与 Agent 设置” (Computer and Agent settings) opens the Relay `/manage` home in a browser, not the PC currently selected on the phone. Sign in with a Relay management account, select the target computer, then open its WebGUI to configure supported Agent models, sessions and other settings. Browser management login and the phone's mobile login code are separate authorization contexts. Skill / MCP configuration and loading require support from the actual Agent host; the phone does not currently manage them directly, and opening the page does not prove tools are active. This change only corrects wording and guidance: it creates no phone-side copy of PC settings and expands no mobile proxy permissions. APK build and physical-device page acceptance for this change remain pending.

- Messages selects only actual enabled routes with an enabled `rabilink` adapter. Persona-only setup rows, disabled routes, and health routes are excluded. Configuration problems remain available in settings and conversation details.
- Rows retain two lines: an avatar at left, persona name at the left and computer name · route name at the right of the first line, latest-message excerpt at the left and message date or time at the right of the second. Avatars load independently; read positions remain scoped per route. Page and system Back return to the same list position.
- Draft and read position are scoped per conversation. Opening one persona never clears another; legacy messages without a Route migrate to one deterministic conversation.
- Normal chat no longer contains a persona dropdown or Configuration Assistant mode. Known fields are edited where they belong in Settings/remote WebGUI; unknown fields use a separate assistant launched from Settings.
- The all-day owner maintains one persistent status notification opening the recording entry. Replies use independent dismissible message notifications deep-linking to `routeProfileId`, without overwriting capture status.
- Attachment, composer, and Send controls use one 52dp action height. Text and media report queued, sending, handed to Rabi PC, or a concrete failure instead of treating queue insertion as delivery.

An embedded glasses-side test APK, `com.rabi.link.glass`, is bundled for CXR CustomApp experiments. It is a test payload installed by the phone-side workflow, not a second phone application for users.

## Current conclusions

The Xiaomi path is an evidence probe. Public BLE/GATT inspection, Health Connect empty-result verification, and Provider permission-boundary tests are useful. Real-device ADB checks now read the latest local heart rate plus a current sleep report and stages, but a stable background API for full-day or historical heart-rate lists has not been established.

The Rokid phone module uses CXR-L for authorization, connection, CustomView, audio, photos, controls, and device status. The former independent status service has been removed in the all-day refactor; device status is coordinated under the single owner, and actual battery/charging callbacks still require device acceptance.

Historical AIUI traffic reached Relay through the paired phone's network proxy; that product route is now paused. In the native-app route the phone explicitly serves as the glasses backend, while Agent ownership, the conversation ledger, and PC configuration truth remain on Rabi PC.

The shared Android SDK can publish record-first portable observations and read broadcast or targeted downstream messages by independent cursor. The probe does not silently start a microphone or pretend to be an unlimited background service.

Native Rokid speech remains unclosed. CXR CustomApp and CustomCmd work, but Glass SDK services were unavailable in the tested environment. The 32-bit glasses-side RokidAiSdk package passed asset, ABI, and permission readiness but still requires legitimate voice-product credentials and real service acceptance.

## Application structure

Records combines capture control and replay; its upper-right action opens recording devices. Messages contains conversations and chat. Device connection pages handle PC, health and glasses authorization without creating another capture owner. Hardware/API probes live in a separate Advanced Diagnostics center.

- `bridge/` defines `DeviceModule`, `Capability`, `ProbeResult`, `BridgeEvent`, storage, and module registration.
- `modules/xiaomi/` contains BLE, GATT, Health Connect, local Provider, cloud OAuth/SDK, evidence export, and related test screens.
- `modules/rokid/` contains CXR-L authorization, link state, CustomView, audio, images, controls, device status, and native-voice experiments.
- `modules/rabiroute/` exercises the shared Android SDK and RabiLink contracts.
- `glass-app/` builds the embedded `com.rabi.link.glass` test APK.

The phone app requires Android 12 or later (`minSdk 31`).

## Build

Use JDK 17 and the repository Gradle wrapper:

```powershell
.\gradlew.bat :app:assembleDebug :glass-app:assembleDebug
```

The wrapper pins Gradle 8.6, downloads it from a public China-accessible mirror, and verifies the official distribution SHA-256. Outputs are `app/build/outputs/apk/debug/app-debug.apk` and `glass-app/build/outputs/apk/debug/glass-app-debug.apk`.

The always-on phone build uses the slim package without local ASR/TTS model assets. This export entry runs JVM unit tests and a complete APK build, then verifies arm64-v8a, the 25 MiB size ceiling, absent model assets, zip alignment, and Android v2 + v3 signatures:

```powershell
.\scripts\Export-RabiLinkMobileSlimApk.ps1 -JavaHome "<JDK 17>"
```

After the same `app-debug.apk` has already completed a full build, repeat only the independent package checks with:

```powershell
.\scripts\Export-RabiLinkMobileSlimApk.ps1 -SkipBuild -JavaHome "<JDK 17>"
```

The verified output is `app/build/outputs/apk/debug/RabiLink-Android-<versionName>-verified.apk`. The script prints structured JSON containing package/version metadata, ABI, model-asset and optional-SDK-isolation checks, signatures, size, SHA-256, and the absolute output path.

Some RokidAiSdk experiments expect local AARs or assets under ignored `out/reference/` paths. Missing proprietary assets may prevent those variants from building or becoming ready. Do not commit credentials or licensed binaries without redistribution permission.

## What the probe can test

- BLE advertisements, standard device information, battery, and public GATT characteristics.
- Xiaomi Health Connect, local Provider boundaries, cloud SDK pagination, and sanitized evidence export.
- Rokid CXR-L authorization, connection, CustomView, audio capture, photos, brightness, volume, and device information.
- Glasses battery/status synchronization through Relay.
- Portable-device observations and cursor-based downstream messages through `RabiRouteSdk`.
- Multiple native and external ASR/TTS hypotheses with explicit readiness and failure evidence.

## Product boundary

This APK is a capability probe and phone companion. It is not RabiRoute itself, not a Codex Runtime, and not an MCP endpoint. Real Agent messages remain owned by the configured RabiRoute path and Codex/ChatGPT Desktop IPC.

## Research documents

- [Probe merge and module model](./docs/rabi-link-probe-merge-plan_en.md)
- [Rokid refactor closeout](./docs/rokid-refactor-closeout-plan_en.md)
- [Rokid ASR/TTS communication findings](./docs/rokid-asr-tts-communication-research_en.md)
- [Native ASR/TTS evidence ledger](./docs/rokid-native-asr-tts_en.md)
- [Official RokidAiSdk voice route](./docs/rokid-ai-sdk-official-voice-plan_en.md)
- [Phone edge-hub boundary](../../docs/rabilink-phone-edge-hub_en.md)
- [Xiaomi wearable handoff](../../docs/xiaomi-band-heart-rate-probe-handoff_en.md)

The Chinese research files retain the full chronological commands and evidence. The English companions summarize the checked conclusions so historical experiments are not mistaken for supported setup steps.
