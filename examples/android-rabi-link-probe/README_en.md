<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Link device probe

> Status: experimental hardware research tool. The repository contains buildable Android probes and real-device evidence paths, but not a stable product API for Xiaomi health history, native Rokid ASR/TTS, or a persistent Wear OS bridge.

This project packages Android, ADB, Xiaomi, and Rokid investigations into one phone APK:

```text
com.rabi.link
```

## Current product route (2026-07-19)

The project now builds one phone companion and one glasses frontend:

```text
glasses com.rabi.link.glass
  <-> audio/media/status only
phone com.rabi.link
  <-> Relay, selected PC, cursor, and glasses settings
RabiLink Relay
  <-> Rabi PC glasses endpoint owns ASR, TTS, Agent, and action gates
```

- `GlassAudioClientActivity` is the default glasses entry. `glass-asr` is only a historical module name; no ASR/TTS runs on glasses.
- The phone home screen is now the RabiLink glasses companion. It no longer duplicates Route, Agent, workspace, or thread settings; it opens remote WebGUI `/manage` instead.
- The phone sends glasses PCM to Rabi PC ASR, publishes the observation, requests PC TTS for downlink, and streams PCM back to glasses.
- The glasses HUD now shows explicit Connect / Listen / Upload / Speak / Paused / Error states. During Rabi playback, capture pauses and resumes after a PCM-length-based delay so downlink speech is not recorded back into uplink audio.
- Photos are wired as message attachments. Relay/worker accept video-file attachments, but the physical glasses video callback is not yet wired and live video is not complete.
- The backend currently follows the foreground `RokidProbeActivity`; a Foreground Service, disk-backed offline retry, and delivered/played receipts are next.
- AIUI feature work is paused; old speech probes remain historical diagnostics only.

The embedded glasses APK is installed by the phone CXR workflow, so the user still installs only one phone APK.

The phone home screen also exposes Wearable Health settings with a Health Connect or “Xiaomi Health (PC ADB Companion)” source selector, stable device identity, sync/lookback periods, thresholds, cooldown, and sleep-state alerts. An obtained Xiaomi authentication key is AES-GCM encrypted through Android Keystore and remains phone-local. The current Xiaomi real-device path is a logon-resident PC Companion driven by phone-owned settings; it normalizes Provider heart rate, sleep reports/stages, and current sleep state into Relay or trusted local Manager observations. Structured samples enter the RabiRoute health timeline instead of the conversation ledger. See [`../../docs/rabilink-wearable-health_en.md`](../../docs/rabilink-wearable-health_en.md).

### First-run setup and failure guidance

- The home screen automatically scans the local network for Rabi PCs. After RabiLink login, a single online worker is selected automatically, so a first-time user does not need to understand workers, routes, or cursors.
- Connection details supplied by an installer, pairing payload, or future QR flow are filled automatically. When the RabiLink URL or mobile login code cannot be obtained safely, the page explains the security boundary and where to copy it from Rabi PC.
- The page header only summarizes overall state. When a field fails, its reason, expected value, source, and fix stay directly below that field instead of forcing users to map a separate “why” section back to the form or rely on transient toasts.
- Common fields, selectors, and actions share one Rabi mobile component scale. Device IDs, polling windows, model fields, and thresholds are hidden under Advanced settings by default.
- Wearable setup prefers Health Connect and can generate a stable device ID and source name. Save and enable validates RabiLink, the system Health Connect provider, or the Xiaomi key first; if a prerequisite is missing, it saves a disabled draft instead of claiming that sync succeeded.
- The Rokid screen defaults to a six-step connection guide: automatic environment check, phone permissions, Rokid authorization, link, glasses-side installation, and launch. The SDK matrix and logs are collapsed; steps that require system confirmation explain why they cannot be completed silently.
- The test center, RabiRoute SDK, Xiaomi BLE/cloud, Provider-boundary, and OAuth screens now share the Rabi component system. They are explicitly labeled as advanced diagnostics, and raw logs stay collapsed so first-time setup never depends on developer pages.

An embedded glasses-side test APK, `com.rabi.link.glass`, is bundled for CXR CustomApp experiments. It is a test payload installed by the phone-side workflow, not a second phone application for users.

## Current conclusions

The Xiaomi path is an evidence probe. Public BLE/GATT inspection, Health Connect empty-result verification, and Provider permission-boundary tests are useful. Real-device ADB checks now read the latest local heart rate plus a current sleep report and stages, but a stable background API for full-day or historical heart-rate lists has not been established.

The Rokid phone module uses CXR-L for authorization, connection, CustomView, audio, photos, controls, and device status. The explicit foreground status service can report real glasses battery and charging state to Relay without creating a CustomView session.

Historical AIUI traffic reached Relay through the paired phone's network proxy; that product route is now paused. In the native-app route the phone explicitly serves as the glasses backend, while Agent ownership, the conversation ledger, and PC configuration truth remain on Rabi PC.

The shared Android SDK can publish record-first portable observations and read broadcast or targeted downstream messages by independent cursor. The probe does not silently start a microphone or pretend to be an unlimited background service.

Native Rokid speech remains unclosed. CXR CustomApp and CustomCmd work, but Glass SDK services were unavailable in the tested environment. The 32-bit glasses-side RokidAiSdk package passed asset, ABI, and permission readiness but still requires legitimate voice-product credentials and real service acceptance.

## Application structure

The home screen is the normal user entry point for Rabi PC connection, continuous conversation, wearable health, glasses, and remote configuration. Hardware/API probes live in a separate Advanced Diagnostics center.

- `bridge/` defines `DeviceModule`, `Capability`, `ProbeResult`, `BridgeEvent`, storage, and module registration.
- `modules/xiaomi/` contains BLE, GATT, Health Connect, local Provider, cloud OAuth/SDK, evidence export, and related test screens.
- `modules/rokid/` contains CXR-L authorization, link state, CustomView, audio, images, controls, device status, and native-voice experiments.
- `modules/rabiroute/` exercises the shared Android SDK and RabiLink contracts.
- `glass-asr/` builds the embedded `com.rabi.link.glass` test APK.

The phone app requires Android 12 or later (`minSdk 31`).

## Build

Use JDK 17 and Gradle 8.6 or a compatible Android toolchain:

```powershell
gradle.bat :app:assembleDebug
```

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
