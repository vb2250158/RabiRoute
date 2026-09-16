# Rabi mobile: all-day recording, messages and devices

English | [简体中文](rabilink-mobile-recording-ui.md)

> Status: 0.3.30-dev is installed. Two-page recording navigation, the top switch, unified review, phone recording and waveforms have current physical-device evidence. Glasses audio, PC transcription end-to-end and all-day soak remain pending. Historical evidence and current acceptance scope are separated below. See the [design, migration and acceptance contract](rabilink-all-day-recording_en.md).


The continuous ruler displays the selected clock time at a fixed cursor. Drag with inertia across days, pinch to zoom, or double-tap to zoom in. Reaching the latest time enters live mode; Return to live is also available. Green marks saved audio, teal marks video, and blanks indicate gaps. Events refresh for the visible time window. Selecting an event positions the ruler and player at that record; playback updates the ruler. Historical audio loads by time window without the previous latest-500 limit.

The preview keeps a fixed height across live, loading, empty, audio and video states, preserving the position of the date row, ruler and events. Playback controls sit inside the bottom of the preview and elapsed time at the top. Sharing is available in the overflow record menu rather than an extra full-width row.

Audio and video share one player overlay and a single mixed timeline. Controls start hidden when opening or switching records. Tap once to show them and again to hide them; they hide after 3.5 seconds during playback, except when using touch exploration. Playback synchronizes the ruler below without a separate clip seek bar. Controls overlay the content without changing preview height.

## Automatic source and unified review (0.3.26-dev)

Audio mode no longer exposes a manual source selector. After explicit start, the phone records first. Authorized CXR-L glasses take priority once they deliver PCM; disconnection or five seconds without data falls back to the phone. The owner seals the old capture before creating a record with the new physical source. Reconnection never overrides pause. Initial glasses authorization is still required.

The timeline page fixes the preview, date and draggable timeline above chronological video thumbnails, recordings and associated ASR text. The far right is live; dragging left reviews history. Audio-only playback shows measured bars matching WebGUI ASR capture. Live bars use PCM levels from the existing capture owner; saved bars use the WAV and mark playback position. With neither sound nor picture, the preview shows “No picture”. Clicking a card seeks the same player. Original video parts remain separate files but support cross-part seeking. Phone audio maps retained shard timestamps and byte durations; missing coverage remains a visible gap.

Visible live mode refreshes owner state and queries the verified PC for transcripts at most every 30 seconds, still limited to the last 24 hours and 200 results. Leaving the page stops refresh. Provider speaker labels are retained. The current transcript contract lacks sentence offsets within a full capture: text clicks seek to the owning record, without invented word alignment. Derived video audio is associated through its parent captureId rather than displayed as a duplicate recording. Historical video wall-clock mapping uses session time; frame-level wall-clock synchronization is unverified.

Fragmented MP4 duration is derived from sample timestamps. Playback builds a seekable local cache while preserving originals. Pending-audio byte totals are maintained by the queue, avoiding a full historical metadata reread on each write.

See acceptance evidence below for source, installation and device checks. Entering live view does not start capture.

## Unified daily entry

Bottom navigation has only Records and Messages. Records opens the timeline by default; its top Start recording switch controls capture. The upper-right action opens the second page, Recording devices, with two-column cards for the phone, glasses, watch/band and PC. Back returns to the timeline. Cards expose necessary connection and authorization only, without routine mode, source or processing settings forms.

This navigation change preserves stored capture and processing policies and historical records. Opening a device page never starts capture. The single owner still chooses audio sources automatically. Legacy home launch extras resolve to the timeline; separate home/device tabs and duplicate preview entries were removed. Retained records follow their original policy. Glasses video and health acceptance limits remain documented below.

## Storage, transcription and replay

- `RabiConversationService` is the sole runtime owner. The separate local-audio, recording and device-status services have been removed from this source refactor. Video uses an ordinary receiver controller, audio writes the durable spool, and the health controller obeys master permission and allowed windows.
- New records freeze `captureId`, physical source, Route and processing policy. Switching chat personas does not retarget queued records. Associate media and transcripts by record rather than assigning history to the currently open conversation.
- New transcripts are linked read-only by `captureId`. Refresh queries the last 24 hours by `processedAt`, at most 200 results; live mode refreshes while visible, history requires manual refresh; missing IDs never trigger guessed attribution. This is not full history browsing. Health currently unifies capture/status only; complete history remains on the PC.
- The nonfunctional `autoResume` UI was removed; the internal field remains false. Boot explicitly pauses capture; automatic capture recovery is not implemented.
- `local_only` submits no processing. `transcribe` requires PC support for transcription without Agent delivery. Capability and worker fencing are connected in source, pending final acceptance; unsupported work stays `deferred`, never falls back to Agent delivery. Queued, received and transcribed are separate states.
- A video has one record and ordered original segments for replay. Sharing exports originals rather than claiming a merged file. Preserve old WAVs, videos, PCM queues and received transcripts without rewriting provenance.
- Even after transport ACK, new records **are not automatically deleted using old transport-cache retention settings**. Complete automatic rolling deletion is not implemented; all-day capacity management cannot be called complete. Never silently delete unconfirmed/quarantined data; low space stops input with an error.

## State, privacy and device boundaries

Starting reception is not proof of glasses publishing. Only received video counts as coverage. Authorization, connection, actual input and PC processing are separate facts. Mode/source changes and write failures expose gaps; service uptime is not audio coverage.

Pausing the phone does not necessarily stop a vendor glasses camera or watch measurement. End manual Rokid streaming in Rokid. If PC health Companion has not confirmed shutdown, expose that remote uncertainty. Allowed windows and historical privacy intervals must prevent late health samples from being imported after resume.

Native manual Rokid streaming retains its existing device evidence. Custom-glasses automatic installation/streaming still needs separate acceptance; CXR-M is excluded. Any necessary legacy recorder redirect may reach only the unified owner, never restart an old standalone service.

## Failures and acceptance

Version 0.3.27-dev (versionCode 30) passed 139 Android tests, two theme checks and assemble. Device checks covered the default timeline, upper-right device grid, return navigation, top start/pause switch and saved shutdown. Capture is paused after testing.

Capture uses bounded queues, one writer, durable provenance, atomic sealing and independent upload. Queue recovery must not block the UI thread. Preserve evidence on save failure; force-stop/power loss is not normal saved shutdown. Preview errors must not stop otherwise healthy recording. FileProvider grants temporary read access for sharing; export important files before uninstalling.

On 2026-09-16, 0.3.25-dev (versionCode 28) passed 137 Android tests, assemble and root npm run build, then was installed. The phone saved approximately 70 seconds of audio. A historical 72-second two-part video displayed the correct duration and matched the burned-in frame time after seeking to 9 seconds. Glasses connected but supplied no PCM in this run. Version 0.3.26-dev (versionCode 29) passed 139 Android tests, assemble and root npm run build, and was installed. A 65-second phone recording was saved. Live and historical waveforms, playback cursor, seeking and dragging to the far right to return live passed device checks. Capture is paused after testing; processing remains local-only with upload paused. Revalidate the single owner, notifications, provenance, privacy windows, transcription-only policy, video audio, health integration and 24/72-hour soak under the new architecture.

### Historical evidence, not acceptance for this refactor

The old UI version on 2026-09-08 passed Android build/unit, exclusion and WAV-content checks. The phone completed 80.46 seconds of recording/background/replay and 49.42 seconds of offline recording with saved output. A 72-second LAN test stream verified preview/background video and full decoding of 60.064/12.014-second segments. Preserve this evidence, but it does not validate the new owner, glasses microphone or custom-glasses publishing. See [offline recording](rabilink-offline-recording_en.md).

0.3.28-dev (versionCode 31): all 140 Android unit tests, assemble and root npm run build passed. Device checks confirmed event selection at 21:50:42, recorded waveforms, event refresh while scrolling, crossing September 8 to September 7, and return to live. Pinch zoom is implemented but physical multi-touch acceptance was not performed in this run.

0.3.30-dev (versionCode 33): 140 Android tests, assemble and root build passed. Device checks confirmed stable layout after record selection, tap-to-toggle controls and automatic hiding during playback. Audio and video use the same overlay; this run validated overlay interactions with audio.

Moving the ruler changes position while preserving playback/pause intent, speed and control visibility, including after loading another record.

0.3.31-dev (versionCode 34) is installed. All 140 Android tests and packaging passed. Device checks confirmed initially hidden controls, tap-to-show, continued playback after ruler seeking and record changes, and preserved pause/control visibility when seeking while paused. Root build was attempted but blocked by unrelated concurrent WebGUI type errors in RoleKnowledgePage.vue and planFeedbackFocus.ts; those files were not changed by this work.

After an app update or process exit, the recording page clears stale running intent when the actual service no longer exists and asks the user to restart recording. Service startup has a short grace window. Without recent audio, the toggle says Waiting for sound rather than treating cached status as current capture.

0.3.32-dev (versionCode 35) is installed; all 140 Android tests and packaging passed. Device evidence confirmed stale enabled intent without a service, corrected interruption status, and fresh PCM, live waveforms, saved audio and green ruler coverage after restart. Capture remains enabled as requested. Root build was blocked by an unrelated duplicate property in WebGUI catalog.ts.


### Audio event splitting

From 0.3.33, newly captured audio persists separate event boundaries. After at least one second of accumulated sound, 500 ms below the energy threshold ends an event; a 60-second cap also applies to silence. These defaults follow PC ASR, but mobile energy detection is not speech recognition. All PCM, including silence, is retained without duplicated pre-roll. Reliable five-second storage shards remain separate from events; one event can contain multiple shards.

The recording device page, opened at the top right, includes Recording settings: a 200–3000 ms silence slider (50 ms steps) and a 3–120 second maximum slider (1-second steps), with reset defaults. Changes apply to the next event. Event IDs persist in shard and recovery metadata; historical events are unchanged after restart. Legacy captures without event IDs keep their original grouping. New events support individual playback, sharing, and timeline navigation. Capture controls, source selection and processing policy remain independent. PC capture-level transcripts without reliable event offsets appear once on the first event with an explicit scope label. Splitting does not enable upload or ASR.

Validation: all 145 Android unit tests passed, including pause/cap boundaries, lossless PCM concatenation, next-event settings and event identity after recovery. Version 0.3.33-dev (code 36) was installed on a physical phone. Continuous capture produced multiple events; selecting a 38-second event positioned the timeline and playback advanced while recording continued. Settings read back as 500/60000; local_only and uploadEnabled=false remained unchanged. Two root npm builds invalidated their Web candidates because other source files changed during compilation; the complete root release build remains unverified. Android build and device validation passed independently.

Version 0.3.34-dev replaces numeric fields with sliders matching the ranges and steps in RabiPC `SpeechServicePage.vue`. Defaults remain 500 ms silence and 60 seconds maximum. Values and units update while dragging; reset defaults still requires Save. Legacy settings are individually clamped and aligned to the new steps, without changing historical events.

Slider validation: 145 Android tests and APK assembly passed. Device version 0.3.34-dev (37) persisted dragged values of 1900 ms/94 s, then reset and saved 500 ms/60 s. The root build again invalidated its candidate due to concurrent Web source changes; no full release was published.


Version 0.3.35-dev (38) shows a gold dashed transcription reference line at 0.015 in live audio-only previews, following the RabiPC waveform style. Bars above the threshold turn green. The line shares the mobile event splitter sound threshold; it indicates sound level, not submission to ASR or completed transcription. Historical playback omits the current reference line. Open the recording page top-right menu → Recording settings to hide it and save. Reset defaults enables it again. Visibility does not affect capture or splitting.

Validation: all 145 Android tests, APK assembly and the root npm build passed. Version 0.3.35-dev was installed on the phone; default visibility, hiding and resetting were checked. The 500 ms/60 s parameters remained unchanged and recording continued.


Version 0.3.36-dev (39) adds a sound threshold slider: 0.001–0.300, step 0.001, default 0.015, matching the RabiPC transcription threshold range. Saving immediately updates the live reference line and bar colors; event splitting adopts it at the next event. Reset restores 0.015. This controls mobile sound detection and does not change PC ASR settings.

Threshold validation: 146 Android tests and APK assembly passed. On-device dragging saved 0.108 and the reference line showed 0.108; reset restored 0.015 while recording continued. Two root build attempts encountered a missing generated file and an occupied Web build lock; the full root build did not complete for this change.


Version 0.3.37-dev (40) builds each live bar from 1600 PCM samples (100 ms at 16 kHz), independent of callback arrival buckets. Callback jitter and batching no longer create missing bars. Zero levels show a thin gray baseline without inventing sound. After one second without audio the waveform clears; resumed capture discards stale display samples. Recorded files are unaffected.

Waveform validation: 148 Android tests and APK assembly passed, including callback batching/jitter equivalence, real gaps and silence. Version 0.3.37-dev is installed on the phone; live bars render continuously, the current threshold is preserved, and recording continues.


0.3.38-dev (41) supports multiple saved computers in the device center, each with its own card. Existing connections migrate automatically; reconnecting updates the original card. Opening a card verifies and selects that computer. Returning refreshes the list. One computer is the active message and recording target. Scalar connection settings remain the current transport projection; the list stores saved connections.

Multiple-computer validation: 152 Android unit tests and the APK build passed. USB disconnected before installation, so this build has not been installed or validated with multiple computers on the phone. Recording paused before installation has not yet resumed.
