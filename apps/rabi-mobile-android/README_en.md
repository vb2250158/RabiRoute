<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi mobile Android project

[Phone location recording](../../docs/mobile-location-recording_en.md): offline system GPS tracks, a phone-entered Amap Android key, query throttling/monthly limits and daily export. It shares the all-day start/pause service; PC/Relay upload is not automatic.

This directory is the RabiLink phone companion and bundled glasses frontend project. Keep the stable path `apps/rabi-mobile-android/`; look here for APKs, the Gradle project, and mobile recording/voice-capture sources.

## Voice assistant

Open **Voice assistant** from Messages. Enable it, tap **Start live voice**, and grant microphone permission. In the foreground, utterance recognition shows a live waveform and streaming recognition shows live text. A finished transcript sends automatically. Replies play on the phone. Leaving the page or sending the app to the background releases the phone’s audio resources. The PC continues work it already accepted.

Enable the assistant on the selected PC and choose a persona, a recognition service, and local TTS. The phone uses the paired RabiLink connection and the persona’s persistent conversation.

Configure wake words in the PC persona settings. On the phone, choose keyword start mode and arm the listener while the page is visible. Builds that include the wake model detect Mandarin and English keywords on the phone CPU. On a match, live recognition uses the same microphone and receives the audio after the wake word. Enabling **PC standby transcription** sends audible utterances to the selected PC's local recognizer. The first turn after waking can include up to six background transcripts from the preceding 90 seconds. Ending the conversation or leaving it idle returns to keyword standby.

When the PC confirms its local recognizer is ready, it can transcribe speech buffered during wake-up if the phone's sample rate is incompatible with live recognition. The phone displays the check in progress and refreshes its controls when the recognizer becomes available.

For an offline build with handset wake detection, pass both `-PmobileWakeAar=<official sherpa-onnx 2.0.2 AAR>` and `-PmobileWakeModelDir=<locally provisioned bilingual Zipformer model directory>`. Gradle verifies the runtime, weights, and token-table hashes. Standard builds support manual live voice and opt-in PC-transcription wake. [Official Android runtime](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.2) · [Bilingual keyword model](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/)

For emulator acceptance, assemble :app:assembleDebug and :app:assembleDebugAndroidTest with -PmobileSlim -PmobileAssistantAcceptance -PmobileTestRunner=com.rabi.link.test.MobileAssistantInstrumentation. Install both APKs on the test emulator and run adb shell am instrument -w com.rabi.link.assistantacceptance.test/com.rabi.link.test.MobileAssistantInstrumentation. The instrumented test uses Android’s actual permission, browser capture and playback with a generated input and fixture recognition, model and synthesis responses.

## Recording and devices

[All-day recording integration](../../docs/rabilink-all-day-recording_en.md) is in progress: one `RabiConversationService` owner coordinates phone, glasses and health. Separate local-audio/video/device-status services have been removed; video uses an ordinary controller, audio the durable spool, and health a master-permission/window-bound controller. The [UI guide](../../docs/rabilink-mobile-recording-ui_en.md) separates source changes from historical device evidence. Video audio is derived only after stop; PC transcription-only capability/worker fencing is connected in source, with unsupported work deferred. CaptureId read-only association manually refreshes at most 200 results over the last 24 hours by processedAt; missing IDs are not guessed. Health unifies capture/status only; complete history remains on PC. Opening the app restores capture only when the saved recording switch is enabled, subject to microphone permission and Android boot restrictions. A disabled switch remains disabled. Source removes the application recording-capacity limit and pauses only for insufficient physical free space. History is cached after the first read and updated incrementally on file changes, without recurring loading/update messages. Automatic phone-original cleanup requires a strong [PC archive](../../docs/mobile-recording-archive_en.md) receipt plus verified remote history and audio readback; transcription or transport ACK alone cannot authorize deletion. 0.3.72-dev (75) has been installed in place; see the recording UI acceptance scope below. These UI checks do not establish acceptance of every hardware or archive path.

[Offline glasses recording and live preview](../../docs/rabilink-offline-recording_en.md): native glasses streaming to the phone, local preview, segmented recording and replay; implementation and device verification are in progress.

> Status: experimental app. This is the primary Android project for the RabiLink phone companion and embedded glasses frontend. Xiaomi Health, Rokid, and ADB diagnostics remain available, while several hardware paths still require real-device acceptance.

The separate `glass-video-app/` recorder is bundled with the phone debug build; automatic installation has not passed device acceptance. Read [Rokid development sources and troubleshooting](../../docs/rokid-development_en.md) and its skill entry before changes. CXR-M is excluded; commercial-integration suggestions in older research no longer apply.

Users install one phone APK. The project also builds the glasses frontend that the phone delivers through the CXR workflow. Hardware probes remain under advanced diagnostics instead of defining this project as an example:

```text
com.rabi.link
```

## Skins and appearance

Open the third bottom tab, **Settings → Skins and appearance**, to choose System, Light (Clear Teal), or Dark (Night Teal). Changes apply immediately, survive restarts, and affect only this phone. Recording, the timeline, messages, settings, platform dialogs, and system bars share the selected skin; video areas keep a dark background. The current application labels are in Chinese.

Common actions use consistent vector outline icons: search, back, calls, attachments, send, record navigation/live/refresh and conversation actions. Icon-only controls retain accessibility labels and touch targets of at least 48dp. All three bottom tabs show icons and names. Settings groups appearance, recording devices, connections/computers, speech/messages, diagnostics and advanced tools. Connection forms and diagnostics are initially collapsed, with connection expanded for first-time setup. Device tools use two rows on narrow screens.

Bottom navigation contains Records, Messages and Settings. The Messages header contains only its title and search, without chat instructions or a settings button. Long-press a conversation for a bottom action sheet offering pin/unpin, mark read/unread and copy conversation ID. Pinned conversations appear as full rows at the top, retaining their latest-message preview, timestamp and unread badge; unpinning returns them to the ordinary list sorted by latest activity. Unread badges and local pin state survive reopening. Routes with identical persona names retain computer/route hints to distinguish their targets. Android `0.3.71-dev` (74) replaces the earlier three-column grid with full conversation rows.

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
- Bottom navigation has Records, Messages and Settings. Records opens the timeline, with a top start/pause switch and an upper-right recording-device grid. Messages lists all personas from the selected PC, including unconfigured or disabled chat entries, while retaining distinct routes for the same persona. Persona configuration, names and avatars remain owned by the PC; the phone caches presentation metadata. Catalog placeholders do not duplicate configured routes, and send availability follows the actual PC configuration. The Phone entry at the upper right of chat freezes the selected computer and route and reuses recording and PC transcription for voice conversations. Speech is half-duplex; natural interruption is unsupported. Late replies after hangup remain messages without automatic playback. See [mobile voice calls](../../docs/mobile-voice-call_en.md). Settings, health, and glasses remain separate surfaces.
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

`AllDayRecordingSettings` unifies `mode=audio|video|health`, `source=auto` (automatic audio; glasses for video), `processingPolicy=local_only|transcribe|agent`, and `running/healthEnabled/uploadEnabled/autoResume/windowStartedAt`. Upgrades default to `running=false`; the transcription default does not start capture. Version 0.3.57-dev (60) removes the former app-entry behavior that enabled recording. Refreshing the conversation directory preserves original message ownership; messages without a persona remain in their original legacy group and are not assigned to the newly selected persona. The legacy startup-voice switch is no longer a second capture authority. `autoResume` persists the user switch; `running` represents the current capture request. Runtime failures preserve the switch; explicitly disabling recording cancels restoration. Boot restores background transport and posts an app-opening notification. A foreground app launch resumes enabled recording when microphone permission is granted. Vendor autostart restrictions may require enabling app autostart; the app does not force-open its UI or bypass Android microphone restrictions.

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

## AIUI persona settings

The phone uses the PC's unified `bootstrap-application` contract for Manager connections. The `manager`, `speech` and `resources` services all sign the `rabi-application-bootstrap-v1` domain. A first connection needs no cached Manager grant, and future APIs use the same connection without per-API authorization. The signature regression invokes the actual PC Tunnel Runtime and rejects a changed source or expired request; transport selection and device receipt still need hardware acceptance.

“Phone direct connection / glasses pairing” in glasses settings starts a local bridge owned by the existing phone connection service. AIUI pairs with the displayed address and five-minute code to obtain a short-lived local credential. The phone keeps an independent Eye key and registers a PC delegation lasting at most 45 seconds using the actual Eye device credential. Native Agent session, claim, response and ordinary API calls preserve that Eye identity. Buffered HTTP, streaming/SSE and the original WebSocket upgrade share the transport without replaying dispatched writes. Protocol regressions use actual PC encrypted handshakes and sockets. The current HTTP address is a development entry; production HTTPS/domain allowlisting and actual glasses network access still await acceptance.

The Rokid CXR diagnostic page also provides an experimental two-finger AIUI wake test. Configure the gesture to open AIUI in the Rokid app, then explicitly connect, query and start the bundled component before testing. Receipts describe broadcast stages; hardware wakeup and automatic Route delivery await verification. See the [wake probe](../rabilink-aiui/docs/aiui-wake-probe_en.md).

Open All-day recording → Devices → Glasses → Glasses settings to select the persona source PC, persona and preloaded Skills. Persona selection does not change credential permissions; unbound devices can call APIs. Device configuration has one owner on the connection-registered PC; tools and history use the selected persona's source PC. The phone uses one generic Manager transport for configuration, APIs and history, reusing LAN → P2P → Relay connections without replay after dispatch. Source regression and APK builds are verified; installation, actual paths, automatic Route wakeup and Rokid model continuation require hardware acceptance. See [AIUI implementation and boundaries](../rabilink-aiui/docs/persona-agent_en.md) and [generic API transport](../rabilink-aiui/docs/generic-api-transport_en.md).

Opening the phone glasses settings refreshes a five-minute pairing code while reusing the same connection service and preserving paired glasses. The private local connection credential lasts fifteen minutes. An active client checks it every minute and calls local `/session/renew` when five minutes remain. The phone re-authenticates the original stored device credential against Relay, verifies the actual device ID and checks the original connection scope and session before and after that request. Success extends only the same private access credential. The PC forty-five-second delegation continues to renew independently through its original device-token chain. Failed authentication, revocation, scope changes or an already expired credential stop the connection, including streams; they never revive an old session or resend a business operation.

Messages place timestamps and unread counts on the right, keep pinned rows above regular rows, and highlight only the selected bottom-tab icon. Settings use one rounded group and a compact connection card based on the actual selected computer state.


Android 0.3.61-dev (64) brings the Records page into the shared teal theme. The Records title and devices action remain visible above a capture-status card. Compact live waveforms use measured audio levels and honor the transcription-reference-line setting. Date, adjacent-event and refresh actions share a row; scope, type and source use three dropdowns. Event rows preserve real timestamps, duration, source, transcripts and archival status, with review opening the existing player. The ruler and bottom navigation remain separate. Scrubbing, zooming, paging, capture consent and persistence keep their existing owners. Missing input displays the actual starting, recovery, paused or error state, without demo waveforms or records. Landscape uses a preview/list split and both themes use existing tokens.

Android 0.3.62-dev (65): Messages reads the full PC persona catalog and sorts by the latest synchronized chat activity, newest first. Personas without messages follow active conversations; names provide a stable tie-breaker. Pinned and regular sections each preserve that order, and unpinning restores the conversation to its chronological position.

A subtle computer badge follows each persona name and remains visible in pinned shortcuts. It uses the persona-source computer name when provided and marks an unresolved source explicitly.

Android 0.3.64-dev (67) further matches the Records visual reference: compact cards, a pale timeline, a bold status with a separate source subtitle, a pill switch, measured symmetric waveforms, a centered timer and a Return to live action. Event rows show time, type, then duration/source with circular play controls. Selecting an event expands its transcript, thumbnail and markers; blocked states remain visible. Missing input uses a flat placeholder and an unstarted timer, without demo levels or records. Bottom-tab labels and selection geometry are refined consistently.

Generic Manager connections consume `android.manager.identity` (12 seconds by default) and `android.manager.request` (45 seconds) from authenticated `/meta.timeoutOverrides`. Snapshots are cached locally per account and target PC. First connection or mutation preflight refreshes settings for subsequent requests. Compilation and configuration unit tests pass; physical-device acceptance remains pending.

The WebGUI timeout page also configures SDK HTTP, LAN/P2P/Relay tunnels, recording drain/shutdown, location, glasses text/video startup, and native voice handshakes through `android.*`. Direct SDK discovery adopts the verified endpoint snapshot; the phone uses its verified account/PC selection cache for Relay HTTP and sends the per-request budget. Missing overrides retain each operation’s defaults, including duration-based playback waits. Source compilation and unit tests are not physical-device acceptance.

## Mobile interaction update (0.3.71-dev / 74)

- Recording status uses capture evidence. A saved enabled switch alone does not establish capture success. Waiting, failures and low storage show a local explanation and recovery/check action.
- Messages and Settings → Connections and computers share the computer picker with recording devices. Connection settings also offer Open messages.
- Pinned conversations use full rows with previews, timestamps and unread badges, replacing the earlier three-column avatar grid. Chat refresh preserves the reading position; a new-message button returns to the latest messages.
- Failed outgoing messages offer retry and failure details beside the message. Retry reuses the original queued payload, message ID and conversation. Text supports selection, copying and web links.
- Calls emphasize listening, waiting, playback, mute and offline states. Granting microphone permission resumes the pending call for the same conversation. Speech remains turn based.
- Everyday voice settings retain automatic playback and contact preference. Model identifiers, voice and storage parameters are collapsed under advanced settings.

Build, installation and device interaction evidence are recorded separately. Real multi-turn voice and network recovery still require their dedicated acceptance checks.

Select the UI runner explicitly for interaction acceptance without sending messages or creating recording fixtures:

```powershell
.\gradlew.bat :app:assembleDebugAndroidTest -PmobileSlim '-PmobileTestRunner=com.rabi.link.test.MobileUxInstrumentation'
adb shell am instrument -w com.rabi.link.test/com.rabi.link.test.MobileUxInstrumentation
```

The scroll check uses existing, already-read local history and reports missing coverage when history is insufficient. Instrumentation restarts the target application: pause and save ongoing recording first, then restore the original recording switch afterward.

## Record browsing layout (0.3.72-dev / 75)

The fixed toolbar keeps capture status, the start/pause switch and overflow actions visible. Overflow retains recording devices, capture settings, transcription settings and storage management. The live pane shows actual input for the selected mode and has no playback seek bar. The timer represents the current enabled window, not recorded-media coverage.

Dragging the records list folds the live pane continuously and gives history its space. At today's newest local record, pulling farther down expands the live pane and releasing returns to live. Pulling within older records, another date or PC archives does not trigger this transition. The Return to live button remains available. Tapping a row opens details; the separate audio/video play action starts replay. Location details show the available address, timestamp, coordinates, accuracy and provider, without invented activities or a demonstration map.

Replay dialogs provide play/pause, a draggable seek bar and measured media duration. Overflow retains seek-by-time, playback speed and sharing. Audio displays raw transcription or its actual processing state; unrequested, failed and completed-without-text states remain distinct. Complete source audio can play independently of transcription. Long text scrolls inside the dialog; closing stops replay and preserves the history anchor. Media failures can retry the same record, without asserting that missing files still exist.

Filters separately select scope (local/computer archive), type and phone/glasses source, then apply or reset. Dates use local calendar-day boundaries, and pages retain the same date and filters. Empty days do not fall through to another date, and refresh/date changes never automatically open replay. Local pages append up to 100 rows with a 1,000-row window. Archive history retains its current ascending-per-page protocol and explicit next-page action; pending uploads are only a bounded preview. Unconfigured, unavailable, cached and stale directories have separate notices. Cached metadata does not guarantee playable media.

Saved capture intent, recent input and save completion are independent. Stopping/saving does not prematurely become paused, and the current save failure remains visible. Loading, empty results, permissions, recovery and low storage have distinct presentations. Health mode exposes current collection status; complete health history is not part of the local mixed-media list.

2026-11-16: 0.3.72-dev (75) was installed in place. All 327 Android unit tests and the APK/device-test builds passed. Physical-device checks passed for full live-pane collapse with continued scrolling in the same gesture, retained top actions, 205 isolated paged records, modal list-position preservation, local playback while capture is paused, scrubbing without resuming, and one-tap replay. See the [UI acceptance scope](../../docs/rabilink-mobile-recording-ui_en.md); glasses video, PC archives, and long-running stability still require separate acceptance.
