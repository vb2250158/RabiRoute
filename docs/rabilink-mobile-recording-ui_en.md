# Rabi mobile: all-day recording, messages and devices

English | [简体中文](rabilink-mobile-recording-ui.md)

> Status: all-day integration is being implemented in source; installed-package and end-to-end acceptance remain unconfirmed. Current source direction and historical device evidence are separated below. Passing tests for an old version does not validate the new coordinator. See the [design, migration and acceptance contract](rabilink-all-day-recording_en.md).

## Unified daily entry

Home configures and starts all-day recording, Records provides replay, Messages provides chat, and Devices handles connections. Local storage does not require a PC connection first.

1. Select Audio / Audio-video / Health-only. Running/paused is independent of mode and retains the selection; Pause is no longer a third media mode.
2. Select phone or glasses audio and add supported health sources. Glasses need authorization and a real connection; health requires a working Provider. Health-only does not open a microphone.
3. Select Save only / Transcribe / Send to Agent and upload permission, then explicitly start. A default transcription policy does not start capture; upgrades set `running=false` and do not automatically open the microphone.
4. Pause stops permitted capture and saves its boundary. Source/mode changes finish previous input shutdown and storage first. Reconnect, restart and health lookback cannot bypass user pause by backfilling.
5. Audio-video retains preview, fullscreen and streaming setup. Preview is muted; originals retain received audio. Video audio is derived for processing **after recording stops**, not transcribed live.
6. Messages no longer owns a separate capture system. Ordinary replies use dismissible message notifications. The all-day owner maintains one persistent status notification that opens the recording entry.

## Storage, transcription and replay

- `RabiConversationService` is the sole runtime owner. The separate local-audio, recording and device-status services have been removed from this source refactor. Video uses an ordinary receiver controller, audio writes the durable spool, and the health controller obeys master permission and allowed windows.
- New records freeze `captureId`, physical source, Route and processing policy. Switching chat personas does not retarget queued records. Associate media and transcripts by record rather than assigning history to the currently open conversation.
- New transcripts are linked read-only by `captureId`. Manual refresh queries the last 24 hours by `processedAt`, at most 200 results; missing IDs never trigger guessed attribution. This is not full history browsing. Health currently unifies capture/status only; complete history remains on the PC.
- The nonfunctional `autoResume` UI was removed; the internal field remains false. Boot explicitly pauses capture; automatic capture recovery is not implemented.
- `local_only` submits no processing. `transcribe` requires PC support for transcription without Agent delivery. Capability and worker fencing are connected in source, pending final acceptance; unsupported work stays `deferred`, never falls back to Agent delivery. Queued, received and transcribed are separate states.
- A video has one record and ordered original segments for replay. Sharing exports originals rather than claiming a merged file. Preserve old WAVs, videos, PCM queues and received transcripts without rewriting provenance.
- Even after transport ACK, new records **are not automatically deleted using old transport-cache retention settings**. Complete automatic rolling deletion is not implemented; all-day capacity management cannot be called complete. Never silently delete unconfirmed/quarantined data; low space stops input with an error.

## State, privacy and device boundaries

Starting reception is not proof of glasses publishing. Only received video counts as coverage. Authorization, connection, actual input and PC processing are separate facts. Mode/source changes and write failures expose gaps; service uptime is not audio coverage.

Pausing the phone does not necessarily stop a vendor glasses camera or watch measurement. End manual Rokid streaming in Rokid. If PC health Companion has not confirmed shutdown, expose that remote uncertainty. Allowed windows and historical privacy intervals must prevent late health samples from being imported after resume.

Native manual Rokid streaming retains its existing device evidence. Custom-glasses automatic installation/streaming still needs separate acceptance; CXR-M is excluded. Any necessary legacy recorder redirect may reach only the unified owner, never restart an old standalone service.

## Failures and acceptance

Capture uses bounded queues, one writer, durable provenance, atomic sealing and independent upload. Queue recovery must not block the UI thread. Preserve evidence on save failure; force-stop/power loss is not normal saved shutdown. Preview errors must not stop otherwise healthy recording. FileProvider grants temporary read access for sharing; export important files before uninstalling.

Final source regression passed 131 Android tests with zero failures plus assemble, and root npm run build. The development APK is 0.3.23-dev (versionCode 26). Successful builds do not imply installation or physical-device acceptance. Revalidate the single owner, notifications, provenance, privacy windows, transcription-only policy, video audio, health integration and 24/72-hour soak under the new architecture.

### Historical evidence, not acceptance for this refactor

The old UI version on 2026-09-08 passed Android build/unit, exclusion and WAV-content checks. The phone completed 80.46 seconds of recording/background/replay and 49.42 seconds of offline recording with saved output. A 72-second LAN test stream verified preview/background video and full decoding of 60.064/12.014-second segments. Preserve this evidence, but it does not validate the new owner, glasses microphone or custom-glasses publishing. See [offline recording](rabilink-offline-recording_en.md).
