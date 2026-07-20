<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-glasses-app-design.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Glasses App Primary Design

> Status: primary development route. Since 2026-07-18, AIUI feature work is paused; the glasses APK is a frontend and the phone app is its backend.

## Product boundary

```text
Glasses: capture/send PCM, receive/play PCM, show a minimal HUD, send device media
Phone: connect to glasses, own glasses settings, connect to Relay, queue audio/media, maintain cursor
Relay: app/device auth, durable mailbox, restricted speech proxy, temporary media storage
Rabi PC: ASR, TTS, Route, Agent, persona, memory, ledger, and action gates
```

The phone no longer duplicates Rabi PC Route, Agent, workspace, or thread configuration. It opens the remote RabiLink WebGUI `/manage` for PC configuration. The phone still owns Relay URL/token, selected PC, glasses connection state, and glasses transport settings. The glasses store no Relay token and do not access the public network directly.

## Primary path

```text
glasses PCM <-> phone backend <-> authenticated Relay <-> Rabi PC glasses message endpoint
Rabi PC ASR -> record-first observation -> ledger/reviewer -> PC Agent
PC Agent -> Outbox text -> phone cursor -> Rabi PC TTS -> phone -> glasses PCM playback
```

Classic Bluetooth and P2P may both carry control messages. Commands must therefore be idempotent so duplicated start/stop events cannot reset or submit a recording twice. Tagged stream data carries the audio body.

## Current implementation

- Default glasses entry: `com.rabi.link.glass.GlassAudioClientActivity`. The historical module name `glass-asr` remains only for build compatibility; no ASR/TTS runs on glasses.
- Confirm starts recording and confirm again stops/sends. The UI uses a pure-black background, one horizontal action strip, and centered explicit focus.
- The HUD uses fixed Connect, Listen, Upload, Speak, Paused, and Error state chips. Downlink PCM playback pauses capture and resumes after an audio-length-based delay to keep reply audio out of the next uplink.
- Phone `RabiGlassPcBackend` wraps PCM as WAV, calls PC ASR, publishes an observation, polls downlink, calls PC TTS, and streams PCM back to glasses.
- The phone home screen now contains only Relay/target PC, backend/install/launch controls, media status, remote configuration, and diagnostics. Route/Agent/Codex binding editors are removed.
- Photos are uploaded as message attachments. Relay and the PC worker also accept video attachments. The physical-device callback is currently wired for photos; video capture still needs its SDK callback and is not presented as live video.
- AIUI and device/system speech stacks remain only as historical diagnostics, outside the default flow.

## Media and reliability

Photos, short videos, and audio files are message attachments, not streaming video:

1. The phone uploads the binary and receives attachment metadata.
2. It publishes an observation containing `attachments`.
3. The PC worker downloads the authenticated object into the Route's private data directory before appending the ledger and invoking the Agent.
4. A failed upload must not publish a dangling observation; the phone shows failure and allows retry.

Relay defaults to 64 MiB per attachment and can be configured. The current implementation provides serialized, slow single-request transfer. Resumable upload, a phone disk-backed offline queue, delivery receipts, and retention cleanup remain production reliability work.

## Lifecycle and security

- The phone backend currently follows the foreground `RokidProbeActivity` lifecycle. Keep it open during v0.2 acceptance; migrate it to a visible, pausable Foreground Service next.
- The glasses own no app token, Route/Agent configuration, or model selection.
- The phone app token stays in private app storage and must never be logged with transcripts or audio bodies.
- The Relay speech proxy exposes only transcription and synthesis. It cannot grant WebGUI, worker API, PC microphone, or arbitrary local URL access.
- Raw audio is not retained by default. Downloaded media stays in private Route data and is never source-controlled.

## Acceptance gates

1. Both APKs build; the phone can install and launch the glasses frontend.
2. Physical previous/next/confirm input does not skip items and focus stays visible.
3. One recording produces one observation despite duplicated cross-transport controls.
4. ASR/TTS run on Rabi PC; the glasses only transport and play audio.
5. Cursor recovery does not skip unpersisted messages; delivered/played receipts follow.
6. A photo reaches the PC as an attachment; video is accepted first as a file message, not live video.
7. The phone opens remote WebGUI configuration and contains no second Route/Agent configuration surface.

## Next sequence

1. Close physical-glasses PTT, photo attachment, and reply playback acceptance.
2. Move the phone backend into a visible Foreground Service.
3. Add disk-backed retry, exponential backoff, retention cleanup, and delivered/played receipts.
4. Wire and verify physical-device video file transfer; only then assess live video.
5. Explore VAD after stability; do not promise 24-hour capture in v1.

## References

- [Three-route comparison](rabilink-glasses-route-comparison_en.md)
- [Phone edge hub](rabilink-phone-edge-hub_en.md)
- [RabiLink Relay](rabilink-relay-server_en.md)
- [RabiSpeech](rabispeech-plugin_en.md)
- [Android project](../examples/android-rabi-link-probe/README_en.md)
- [Paused AIUI route](rabilink-aiui-residency-plan_en.md)
