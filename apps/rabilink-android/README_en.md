<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Android app

> Status: experimental app. This is the primary Android project for the RabiLink phone companion and embedded glasses frontend. Xiaomi Health, Rokid, and ADB diagnostics remain available, while several hardware paths still require real-device acceptance.

Users install one phone APK. The project also builds the glasses frontend that the phone delivers through the CXR workflow. Hardware probes remain under advanced diagnostics instead of defining this project as an example:

```text
com.rabi.link
```

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
- The normal phone home is a conversation list. Tapping a persona with an enabled RabiLink message adapter opens chat; Back returns to choose another persona. Settings, health, and glasses remain separate surfaces.
- The phone sends continuous 16 kHz mono phone/glasses PCM through the restricted `audio-streams/rabilink/start|chunk|stop` endpoints to the selected Rabi PC. Android owns no VAD, utterance segmentation, ASR, or voiceprint logic. RabiSpeech segments and recognizes on the PC, then automatically writes the host-wide speech store and the RabiLink/mobile endpoint frozen by `routeProfileId`. Stream start submits stable `source_device_id` separately from transient `stream_id`, so normal replies target the real device rather than an audio-suffixed stream identity. `/api/rabilink/speech/messages` remains compatibility/debug only; spoken output is synthesized by Rabi PC TTS and streamed back as PCM when requested.
- The glasses HUD shows explicit Connect / Listen / Upload / Speak / Paused / Error states. The phone sends `PLAYBACK_BEGIN → PCM → PLAYBACK_END` over the same ordered Classic-BT channel. The playback worker does not accept PCM until the main thread has confirmed capture is paused, preventing the beginning of TTS from being recorded back into the microphone. Glasses validate message identity and PCM length and return `played` only after the `AudioTrack` playback head reaches its marker; Activity destruction reports an unfinished playback as `playback_failed`. Legacy PCM without BEGIN/END may still play for compatibility but is never reported as confirmed playback.
- Photos are wired as message attachments. Relay/worker accept video-file attachments, but the physical glasses video callback is not yet wired and live video is not complete.
- `RabiConversationService` owns the message cursor, notifications, and phone/glasses I/O. A target is frozen when work is queued, so later navigation cannot retarget it. A dedicated `RabiPhoneAudioCapture` owns the wake lock, stall detection, bounded restart, and health metrics. Text, control, media, and `delivered/played/playback_failed` receipts are persisted before transmission. A full reliable queue rejects new work with a visible error instead of silently deleting unconfirmed older items. Continuous PCM retains only one acknowledgement-sensitive chunk plus a bounded newest-audio buffer and never creates a hidden offline raw recording. Receipt generation and automatic replay are implemented, while real phone/glasses speaker acceptance remains required.
- Settings exposes one persisted `Paused / Phone mode / Glasses mode` source of truth. Switching to glasses pauses the phone microphone first. Glasses PCM starts only after a real glasses Bluetooth connection event; before connection or after disconnect, capture stays paused with a visible reason and never silently falls back to dual capture. The runtime card refreshes from service broadcasts and shows connection, selected Route/persona, capture, glasses, reliable queues, and the latest error without one-second business-state polling.
- Users can choose `Agent decides / Quiet / Balanced / Proactive`. The value is durably queued as an explicit preference observation and attached to phone text, control, media, and audio-stream metadata. Neither the App nor Relay converts it into a fixed intervention rule. No interruption, preparation, prompt, recommendation, confirmation, or action remains a PC context/Route safety/target-Agent decision.
- Phone-private reliable queues use fsync plus atomic replacement. Startup removes incomplete temporary files; malformed JSON or missing media binaries are moved into quarantine with a visible error so later queue items can continue.
- AIUI feature work is paused; old speech probes remain historical diagnostics only.

The embedded glasses APK is installed by the phone CXR workflow, so the user still installs only one phone APK.

Run the phone-side 24-hour audio acceptance with:

```powershell
.\scripts\Test-RabiMobileAudioSoak.ps1 -Serial <adb-serial> -DurationHours 24
```

The test checks foreground-service residency, latest capture time, PCM-byte growth, and automatic recovery count. The implementation continuously captures and sends ordered PCM chunks without Android-side VAD; it does not retain one raw 24-hour recording. Every acknowledgement-sensitive chunk keeps a stable `chunkId`. If an ACK is lost and Android rebuilds the transient `sourceStreamId`, the PC deduplicates by stable device, chunk ID, and PCM hash before feeding ASR. Android connectivity events or a restored RabiLink SSE connection wake upload immediately. While Android knows the device is offline, the SSE connection and reliable-queue sender wait on the system network event gate instead of waking every few seconds. To cover rare vendors that miss a registered callback, the foreground service checks only OS connectivity every five minutes while already offline and stops immediately after recovery; it never queries Relay, reads messages, or advances the cursor. Only an available network with a temporarily unavailable server uses one-shot 1–30 second backoff. Relay sends a transport keepalive every 15 seconds; if Android receives no SSE bytes for 45 seconds, it treats the socket as silently half-open, reconnects it, and still performs only the one `ready → cursor` catch-up rather than polling business state. SSE `ready/outbox_available` remains only a wake-up signal, followed by one opaque-cursor query to cover missed events. A normal Relay restart preserves the shared generation; a runtime-state rollback explicitly resets the cursor. Android then replays retained messages through `deliveryId` and local terminal-state deduplication before saving the replacement, so an old cursor cannot remain permanently ahead of the server. Message-transport restore intent is persisted independently from continuous listening: a started text/media/downlink connection restores its cursor and reliable queues after process or device restart even when microphone capture is disabled, while an explicit Stop disables later automatic restore. Both the upload executor and offline audio buffer are bounded: prolonged outages discard obsolete audio while retaining the pending chunk and newest PCM, so recovery catches up to the live stream instead of consuming memory or remaining permanently behind. Reliable text/media/receipt facts remain until acknowledged. The PC retires the old virtual input after 15 seconds without chunks. PC-finalized ASR segments and Agent TTS follow the RabiSpeech contract: per-file 24-hour caching plus daily JSONL metadata with safe relative paths and expiration times.

The phone home screen also exposes Wearable Health settings with a Health Connect or “Xiaomi Health (PC ADB Companion)” source selector, stable device identity, sync/lookback periods, thresholds, cooldown, and sleep-state alerts. An obtained Xiaomi authentication key is AES-GCM encrypted through Android Keystore and remains phone-local. Health Connect prefers manual, startup-recovery, or platform events. Xiaomi's ADB Provider exposes no reliable change notification, so an explicitly enabled PC Companion keeps a low-frequency poll at the phone-configured minute-scale interval. Structured samples enter the RabiRoute health timeline instead of the conversation ledger. See [`../../docs/rabilink-wearable-health_en.md`](../../docs/rabilink-wearable-health_en.md).

### First-run setup and failure guidance

- The home screen automatically scans the local network for Rabi PCs. After RabiLink login, a single online worker is selected automatically, so a first-time user does not need to understand workers, routes, or cursors.
- Connection details supplied by an installer, pairing payload, or future QR flow are filled automatically. When the RabiLink URL or mobile login code cannot be obtained safely, the page explains the security boundary and where to copy it from Rabi PC.
- The page header only summarizes overall state. When a field fails, its reason, expected value, source, and fix stay directly below that field instead of forcing users to map a separate “why” section back to the form or rely on transient toasts.
- Common fields, selectors, and actions share one Rabi mobile component scale. Device IDs, controlled polling/lookback windows, model fields, and thresholds are hidden under Advanced settings by default.
- Wearable setup prefers Health Connect and can generate a stable device ID and source name. Save and enable validates RabiLink, the system Health Connect provider, or the Xiaomi key first; if a prerequisite is missing, it saves a disabled draft instead of claiming that sync succeeded.
- The Rokid screen defaults to a six-step connection guide: automatic environment check, phone permissions, Rokid authorization, link, glasses-side installation, and launch. The SDK matrix and logs are collapsed; steps that require system confirmation explain why they cannot be completed silently.
- The test center, RabiRoute SDK, Xiaomi BLE/cloud, Provider-boundary, and OAuth screens now share the Rabi component system. They are explicitly labeled as advanced diagnostics, and raw logs stay collapsed so first-time setup never depends on developer pages.

### Everyday chat and navigation

- Home lists only Routes with a `rabilink` message adapter. Wearable-health Routes are never presented as chat personas; a disabled RabiLink Route explains the problem and links to the fix.
- Each row shows avatar, name, latest message, time, and unread count. Page and system Back return from detail to the same list position.
- Draft and read position are scoped per conversation. Opening one persona never clears another; legacy messages without a Route migrate to one deterministic conversation.
- Normal chat no longer contains a persona dropdown or Configuration Assistant mode. Known fields are edited where they belong in Settings/remote WebGUI; unknown fields use a separate assistant launched from Settings.
- Notifications aggregate per conversation, carry `routeProfileId`, and deep-link cold or warm launches to the correct detail. Back still returns to the list.
- Attachment, composer, and Send controls use one 52dp action height. Text and media report queued, sending, handed to Rabi PC, or a concrete failure instead of treating queue insertion as delivery.

An embedded glasses-side test APK, `com.rabi.link.glass`, is bundled for CXR CustomApp experiments. It is a test payload installed by the phone-side workflow, not a second phone application for users.

## Current conclusions

The Xiaomi path is an evidence probe. Public BLE/GATT inspection, Health Connect empty-result verification, and Provider permission-boundary tests are useful. Real-device ADB checks now read the latest local heart rate plus a current sleep report and stages, but a stable background API for full-day or historical heart-rate lists has not been established.

The Rokid phone module uses CXR-L for authorization, connection, CustomView, audio, photos, controls, and device status. The explicit foreground status service can report real glasses battery and charging state to Relay without creating a CustomView session.

Historical AIUI traffic reached Relay through the paired phone's network proxy; that product route is now paused. In the native-app route the phone explicitly serves as the glasses backend, while Agent ownership, the conversation ledger, and PC configuration truth remain on Rabi PC.

The shared Android SDK can publish record-first portable observations and read broadcast or targeted downstream messages by independent cursor. The probe does not silently start a microphone or pretend to be an unlimited background service.

Native Rokid speech remains unclosed. CXR CustomApp and CustomCmd work, but Glass SDK services were unavailable in the tested environment. The 32-bit glasses-side RokidAiSdk package passed asset, ABI, and permission readiness but still requires legitimate voice-product credentials and real service acceptance.

## Application structure

The conversation list and chat detail are the normal user entry. Settings owns Rabi PC connection, continuous conversation, wearable health, glasses, and remote configuration. Hardware/API probes live in a separate Advanced Diagnostics center.

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
