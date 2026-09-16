# RabiLink all-day recording: unified design, migration and acceptance

English | [简体中文](rabilink-all-day-recording.md)

> Status: **Target design / implementation contract, not accepted end to end**. This document defines the intended integration of phones, glasses and watches. It does not claim that the installed application supports every item. Writing documentation is not evidence of implementation, builds, deployment or physical-device acceptance. A phase may be marked implemented only after checking its code and evidence; items without completion evidence remain pending implementation or validation.

## 1. Purpose and existing baseline

All-day recording is a continuous information-capture feature explicitly enabled by the user. The phone coordinates and stores data reliably, glasses and watches supply different capabilities, and the PC transcribes and processes the results. Audio, audio/video and health-only are modes; running/paused is an independent state. Transcription consumes the same recording rather than starting a separate recording feature.

“All-day” describes a goal of persistent operation, recovery and verifiable coverage. It does not mean an always-on camera by default, guaranteed uninterrupted hardware operation, exemption from background restrictions, or control over every vendor's capture behavior. RabiRoute remains a message gateway and policy router; the target Agent/program performs understanding, answers and actions.

Baseline when this document was written:

- Four-page navigation, local WAV recordings, video sessions and replay have entry points. New local recordings/videos do not yet automatically enter transcription.
- Continuous-conversation audio has a separate durable PCM queue and PC RabiSpeech processing path.
- `RabiLocalAudioService`, `RabiLiveRecordingService` and `RabiConversationService` own separate runtime responsibilities. `CaptureOwnership` provides exclusion, not a unified lifecycle.
- Local audio, video, conversation and health/glasses status services have separate notification paths. Reusing the conversation notification for status, review shortcuts and replies also requires semantic separation.
- Native Rokid manual streaming to the phone has device evidence. Automatic installation/startup of the custom glasses component and full glasses interaction still have acceptance gaps.
- Health Connect and Xiaomi PC ADB Companion are experimental health paths, not universal direct watch support.

Baseline references: [mobile recording interface](rabilink-mobile-recording-ui_en.md), [mobile endpoint](mobile-message-endpoint_en.md), [offline recording](rabilink-offline-recording_en.md), [wearable health](rabilink-wearable-health_en.md), and [Android project](../apps/rabi-mobile-android/README_en.md). Older home-screen/notification descriptions may lag the UI. Check code and specific acceptance evidence; do not turn the target design into a claim of current behavior.

## 2. Single coordination owner and layers

The phone has one all-day recording coordination owner. It owns settings revisions, user intent, actual state, capture generations, device resource leases, recovery policy and the persistent notification. Implementation chooses class names and decomposition. Multiple old services sharing a notification ID do not constitute a single owner.

```text
All-day recording owner (phone)
  ├─ Serialized control and state events
  ├─ Phone audio / glasses audio / glasses audio-video adapters
  ├─ Health adapters and controlled PC Companion configuration
  ├─ Local record index, durable segments, gaps and privacy boundaries
  ├─ Synchronization/transcription task consumers
  └─ One persistent status notification
             ↓
  PC RabiSpeech / health timeline / Route / Agent
```

A unified product does not require a giant class or deep inheritance hierarchy. Use composed capability interfaces. Adapters report actual samples, connections, errors and completed shutdown; they must not independently restart microphones, change the master switch, maintain a second mode truth, or overwrite persistent status.

The phone owner does not replace PC Host/Manager process or business-data ownership. Xiaomi Companion remains owned by the PC Host's Manager plugin and generation-scoped process lease; the phone publishes revision-bound capture intent. Shared SDKs define stable contracts, not product runtime state. Manager access must use dynamic discovery and identity verification, not new fixed addresses.

## 3. Settings, modes and runtime state

### 3.1 Orthogonal settings

| Dimension | Target options | Contract |
| --- | --- | --- |
| Mode | Audio / audio-video / health-only | Pause is not a mode; resume retains the selection. |
| Sources | Audio, video and health devices | Persist stable identities and capabilities, not display-name-based ownership. |
| Processing | Save only / automatic transcription / transcription and review by a selected persona | A setting is not evidence that the processor is online; health-only produces no fake transcription tasks. |
| Network | Prefer Wi-Fi / allow mobile data / pause synchronization | Offline operation is a condition, not a separate recording feature. |
| Fallback | Automatic audio source | Prefer glasses delivering PCM; fall back to phone on disconnection/stall. Source changes create record boundaries and expose the actual source. |
| Retention | Confirmed-media age, storage cap and free-space reserve | Never silently remove unconfirmed or quarantined data. |
| Recovery | User-approved startup recovery policy | Never bypass system permissions or explicit pause. |

The suggested initial experience is audio with optional health and manually enabled video. This is a recommendation, not an assumption that the user selected defaults or authorized every sensor. Installation/migration must not silently enable new capture capabilities.

### 3.2 State and commands

Separate user intent `running/paused/stopped` from actual `starting/recording/degraded/pausing/paused/stopping/stopped/error`. Each input also has connection state and a last-actual-data time. Health-only does not require audio; one failed sensor must not hide other healthy inputs.

Serialize start, pause, resume, mode and source commands with stable command IDs. Persist intent/boundaries first, fence old-generation input, seal and save, wait for resource release, and only then start the new source. Old callbacks cannot enter a new record. Failed release remains degraded rather than falsely reporting successful capture in the new mode.

- Selecting a mode does not start capture; explicit start or an already-authorized recovery policy does.
- Pause retains the mode and devices; stop disables automatic recovery intent.
- User pause takes precedence over reconnect, alarms, network recovery, app restart and background callbacks.
- Actual coverage derives from real sample/media intervals, not service uptime masquerading as recording or continuous health coverage.
- UI consumes owner state events and one recovery snapshot after reconnection, not second-by-second business polling. Health sources without events retain only registered bounded, stoppable, low-frequency exceptions.

## 4. Screens and one persistent notification

Target navigation is “Record / Timeline / Messages / Devices.” If a transition retains “Home,” it must reach the same owner, not create another control plane.

- **Record:** master control, mode, sources, actual coverage, latest data, local storage, synchronization/processing backlog and actionable errors. Audio/video and health have separate freshness indicators.
- **Timeline:** associate audio, video, transcripts, health events, manual markers and gaps by time; filter, replay and export. Dates are view groups, not a reason to restart hardware at midnight or create a single day-long file.
- **Messages:** persona chat, attachments, normal replies and unread state, without another recording switch. Transcripts primarily belong in the timeline, not an automatic Agent wake-up or chat entry per sentence. Changes to existing Route hot-delivery/keyword policies require explicit migration, not silent behavior changes.
- **Devices:** authorization, connection, capabilities, last real data, battery, participation and advanced diagnostics. “Authorized” does not mean “receiving data.”

Normal all-day operation has one persistent notification with a stable ID/channel owned by the coordinator. Show mode, actual sources, storage/backlog or the most important error. Tapping always opens Record; actions may pause/resume, mark, or open. A marker only adds a time marker; it does not automatically deliver work to an Agent.

Ordinary Agent messages use separate, dismissible, conversation-grouped notifications. Taps open that conversation without replacing recording status. Necessary system permission prompts, urgent failures or explicitly requested advanced diagnostics are not duplicate resident services. Lock-screen content hides transcripts, health values, credentials and chat bodies by default.

Consolidate foreground lifecycle before removing old persistent notifications. Do not have services overwrite each other through the same ID or masquerade as microphone capture to keep pure messaging alive. Do not hide mandatory foreground notifications or system privacy indicators.

## 5. Record truth and durable processing pipeline

### 5.1 Frozen provenance and ownership

Capture a physical audio source once. Audio/video mode transcribes the same video's audio track where available rather than opening a second phone microphone. Mark missing tracks explicitly instead of inventing transcription tasks. An independent supplementary audio source requires explicit configuration and distinct provenance.

Freeze the following for each capture interval/segment: stable record ID, capture generation, local monotonic sequence, device ID/kind, capability/media type, source and phone receipt times, clock uncertainty, time range, byte count, checksum, processing-policy version, target PC/Route/persona and privacy-interval version. A temporary stream ID is not the stable reply device ID. Derived video audio retains its parent media ID, track, time offset and derivation version.

Changing the chat conversation cannot change capture targets. Processing-target changes apply to new boundaries. Historical forwarding/reprocessing is an explicit operation with original ownership and a separate task ID retained. A previously local-only record with no target must not be automatically shared when a persona is later selected.

Phone raw records/transport segments are the local source of capture and transfer truth. PC RabiSpeech owns successful transcripts, the health module owns its timeline, and each persona owns its conversations and semantic judgments. The mobile timeline is an associated view, not a second Manager/persona business source of truth.

### 5.2 Independent storage, synchronization and processing

```text
Actual capture → bounded input queue → single-writer durable storage → seal/check
                                                   ↓
                                         Stable synchronization task
                                                   ↓
                                        PC durable receipt confirmation
                                                   ↓
                                 Transcription / health normalization / review
                                                   ↓
                                 Results and receipts linked to the source record
```

- Capture does not wait for network, ASR or an Agent. Segment by duration, size and state boundaries.
- Reuse and preserve partial ownership, fsync, atomic sealing, ACK journals, cleanup tombstones, quarantine and gap recovery. Do not replace these with deleting originals on an HTTP success alone.
- Validate sequence, chunk ID, bytes and SHA-256 on receipt. Replays after lost ACKs use stable idempotency keys. Receipt, transcription and Route delivery are separate confirmations.
- Display storage, synchronization and transcription states separately: saved/pending synchronization, synchronized/transcription failed, or save-only/transcription disabled. Enqueued never means transcribed.
- Preserve evidence and explicitly resolve ambiguous non-transactional processing rather than blindly repeating ASR or Agent actions. Startup recovers relevant durable tasks, not repeated full-library delivery.
- Isolate and expose failed items while allowing subsequent valid work. Reject new input with a recorded gap when capacity is exhausted; never silently discard unconfirmed data.
- Confirmed caches can be reclaimed under user policy. Explicit deletion of unsynchronized records must explain the loss, cancel related tasks and retain minimal deletion evidence to prevent resurrection.
- TTS output is not new input. Playback suppression, actual playback receipts and capture resumption require device evidence; `delivered` is not `played`.

## 6. Privacy pause and no health backfill

Pause is a capture privacy boundary, not merely hidden UI or suspended upload.

1. Persist the exclusion interval and generation boundary first, stop accepting new data, seal valid pre-pause content, and stop microphones/cameras/health reads controlled by Rabi.
2. Reject or isolate late callbacks and samples within the paused interval. Resume, reconnect, restart or a larger health lookback must not import them again.
3. Evaluate both occurrence and receipt times. Split health intervals crossing pause only with trustworthy fine-grained evidence; otherwise exclude the overlapping sample as a whole and explain uncertainty. Do not interpolate data outside the gap.
4. Remote sources such as PC Companion must enforce versioned pause boundaries too. If an offline PC cannot confirm shutdown, show “Paused locally; remote stop unconfirmed,” not complete end-to-end privacy pause. Strong remote-stop guarantees require mechanisms such as expiring leases/stop acknowledgement and must not be promised before acceptance.
5. Previously saved data continues under its original processing authorization by default; the UI must explain this and offer separate pause-synchronization/processing controls. Explain already-submitted non-retractable tasks and shared copies; a switch is not remote erasure.
6. Vendor watches may continue measuring independently and native Rokid streaming may remain active. Explain external stop steps. Clock changes or unreliable source times require conservative exclusion and uncertainty, not bypassing privacy intervals.

Store raw media, health and transcripts privately and share through controlled grants; separate credentials from diagnostics. Configure raw media, text and summary retention independently. Make upload targets, permitted personas, deletion scope and third-party copy limits explicit. Enabling all-day recording does not authorize every persona or external platform to receive everything.

## 7. Android and hardware constraints

- Declare actual foreground service types and notification, microphone, camera, Bluetooth and health permissions for the device/API/target SDK. Do not keep every type enabled unconditionally.
- Revoked permissions, calls, system force-stop, boot/background-start restrictions, vendor power management and health background access can interrupt coverage. Explain recovery actions rather than repeatedly attempting prohibited restarts.
- Health-only and messaging-only operation use compliant scheduling/events. Do not invent microphone activity to justify a persistent notification. Single ownership is a responsibility contract, not a promise that every mode can run indefinitely under the same Android foreground mechanism.
- Native glasses streaming still needs a hotspot/LAN. “No internet required” is not “no wireless connection required.” Unaccepted custom-glasses automatic streaming is not the sole production path.
- Xiaomi ADB Companion depends on a PC, ADB and a vendor Provider. Health Connect samples depend on upstream writes and grants. This design does not mean persistent direct Wear OS support exists.
- 16 kHz mono 16-bit PCM consumes 32,000 bytes/second, approximately 2.7648 GB per 24 hours (decimal, excluding copies and metadata). Measure actual video bitrates. Capacity, power, heat and charging conditions must be budgeted; do not promise all-day audio/video battery life without measurement.

## 8. Lossless migration and retired-entry exit

### Phase A: unify control and notifications

Inventory services, Manifest registrations, settings keys, notification IDs, startup/recovery receivers, old Intents and background tasks. Introduce one owner, orthogonal state and versioned migration. Old services must not recover concurrently, and hardware cannot transfer before shutdown completes. Separate ordinary message notifications from status.

### Phase B: unify records and processing

Reuse the durable PCM queue. Connect new local audio and video-derived tracks to stable record/task contracts. Build an associated index for old WAVs, video sessions, transcripts and health without rewriting provenance. Mark missing old provenance as unknown rather than guessing from the current persona, nearby timestamps or filenames. Until automatic local transcription is complete, continue displaying save-only accurately.

### Phase C: device integration and privacy closure

Health/glasses adapters consume master intent and report real data freshness. PC Companion pause boundaries, shutdown confirmation and late-sample filtering require joint acceptance; disabling a phone button is insufficient. Verify modes, fallbacks, deduplication, recovery and coverage calculations.

### Phase D: remove duplicate execution paths

Migration needs a version, input summary, checkpoints, outcome, recoverable transactions and idempotency. Preserve originals and unconfirmed queues. Failure must not clear settings or run old and new owners together. Conflicting old switches migrate conservatively to pause with a confirmation prompt, not a more intrusive mode.

Retain a thin old-Intent redirect only for a real external compatibility requirement. It may enter the single owner but cannot start old capture. Record the caller, migration version, exit criteria and verification for each exception. Remove unused old Activities, Services, Manifest entries, notification producers, settings and packaged resources during the same closeout. Historical media can remain; data compatibility is not permission to keep old execution chains.

Do not manipulate unrelated pre-existing changes, deletions or other application directories. The implementation report lists all surviving compatibility entries. Unexplained duplicate runtime paths block completion.

## 9. Acceptance matrix and completion gates

Every row below is a requirement, not a passed result.

| Area | Required outcome |
| --- | --- |
| Modes and pause | Three modes remain orthogonal to runtime state; repeated/concurrent commands are idempotent; resume does not expand permissions; pause wins. |
| Single owner | Cold starts, restarts, old Intents and background recovery never start dual microphones/capture owners; failed shutdown does not steal hardware. |
| Notifications | One persistent status in normal operation; dismissible ordinary messages with stable destinations; recording facts remain visible; lock-screen redaction. |
| Independent offline use | Local capture within permission scope without an account/PC; offline storage and catch-up to original targets. |
| Atomic storage | Recovery at write/seal/ACK/cleanup crash boundaries; visible missing/corrupt quarantine; no silent loss. |
| Audio/video | Real glasses first frame, continuous stream, audio track, background save and full decode; one transcription of the video track; no false success for absent audio. |
| Provenance | Persona/device/PC/mode switches do not rewrite history; unknown sources are not guessed; stable devices and temporary streams remain distinct. |
| Privacy pause | Local/PC Companion/health lookback/late callbacks/restart/clock-change paths never backfill excluded data; unconfirmed remote stops are visible. |
| Health | Empty results do not create samples; stale data is marked; normal samples do not wake Agents individually; vendor limits remain visible. |
| Android | Revocation, calls, Bluetooth loss, lock screen, power management, force-stop and boot recovery reflect actual restrictions. |
| Resources | Low space, full queues, low battery, overheating and configured fallbacks have explicit outcomes; preserve unconfirmed data and gaps. |
| Migration | Preserve originals/queues/receipts/provenance; idempotent re-entry; recoverable failure; retire old execution paths. |
| Soak | Separate 24-hour offline and 72-hour online runs verify real coverage, sequences, bytes, SHA, gaps, duplicates, battery, temperature and storage growth. |

Existing `Test-RabiMobileDurableAudioSoak.ps1`, `Start-RabiMobileDurableSoak.ps1` and short fault scripts can provide an audio evidence foundation, but must be checked against the new owner. Old-script success does not replace video, health or privacy integration testing. Automation covers state/migration/idempotency; physical tests cover Android, real glasses and health sources. Synthetic streaming does not replace glasses evidence; short tests do not replace soak runs.

Completion reports separately list source, automation, Android/APK build, installed-package identity, phone, glasses, health sources, 24/72-hour soak and legacy-exit status. Evidence retains necessary metadata/hashes/redacted logs, not tokens, raw media or health content. Manager/Web changes also follow repository-wide builds, Host-managed lifecycle, dynamic identity and current-resource verification. Documentation-only work must not claim build/deployment verification.

## 10. Current implementation alignment and status maintenance

Latest source closeout: old standalone local-audio/video/device-status services have been removed. `RabiConversationService` is the sole owner, with an ordinary video controller, durable audio spool and master-permission/window-bound health controller. Video audio is derived after stop, not transcribed live. New record ACKs do not trigger transport-cache retention deletion; automatic rolling deletion is not implemented. PC transcription-only capability/worker fencing and captureId read-only association are connected in source; unsupported work is deferred. The phone manually refreshes a processedAt-based query for the last 24 hours, at most 200 results; missing captureId never causes guessed attribution. This is not full history browsing. Health integration covers capture/status only; complete history remains on the PC. Final source regression includes 131 Android tests with zero failures and successful assemble (development APK 0.3.23-dev / versionCode 26), plus a passing root npm run build. PC speech Python tests: 66 passed, 1 skipped; Manager speech tests: 22 passed; health worker tests: 10 passed; Relay health and mobile audit mutation tests: 5 passed. These results do not replace actual deployment, device or all-day acceptance.

The implementation coordinator confirmed that the following direction is underway. These are **in-progress interface agreements**, not build or acceptance results:

- Reuse and refactor `RabiConversationService` as the sole owner rather than adding another resident service. Video becomes an ordinary controller; audio uses the durable spool with frozen record/source/route/policy; the health controller obeys master permission and allowed capture windows.
- The new model is `AllDayRecordingSettings`: `mode=audio|video|health` (audio/audio-video/health-only in the UI), `source=mobile|glasses`, `processingPolicy=local_only|transcribe|agent`, plus `running`, `healthEnabled`, `uploadEnabled`, `autoResume` and `windowStartedAt`.
- The intended default policy is `transcribe`, but upgrades set `running=false` and must not automatically record. A transcription default does not itself authorize upload/persona sharing. Health-only creates no audio transcription tasks.
- `running=false` means capture is currently disallowed, not permission to erase historical pause intervals. `windowStartedAt` marks the current allowed window; this single field cannot replace historical exclusion intervals needed for restart and late health samples.
- `uploadEnabled` gates synchronization; `autoResume` remains an internal false field; its nonfunctional UI was removed and boot explicitly pauses capture. Automatic resume is not implemented. Proposed Wi-Fi options, independent video sources and detailed runtime states still need individual implementation verification rather than being assumed from this field list.
- The PC protocol for `transcribe` without automatic Agent delivery and worker fencing are connected in source; final regression and deployment acceptance remain pending. An unsupported PC must produce an explicit unsupported/upgrade-required state, not silently fall back to `agent` or claim a complete transcription loop.

Additional implementation limits: positive and negative PC-capability caches are invalidated by endpoint changes, network recovery or manual retry; there is no periodic capability query. An offline PC upgrade requires manual retry to recheck support, not a promise of automatic upgrade discovery. Durable video binding, persistent enqueue after stop and dead-process identity recovery are implemented, but physical-device acceptance is pending. Real Relay health tests pass: only a new worker explicitly advertising the capability is supported, old workers receive no fabricated support, and a changed target returns a conflict. `transcribe` stores health records without Agent delivery; legacy unbound records or records without a Route stay local and never bind automatically.

This document currently marks no integration phase complete. Implementation commits must add phase, code entry points, test commands/results, installation/device evidence and remaining gaps, then synchronize this English version and affected current guides. Adding a coordinator class, changing buttons or passing a build is not sufficient to remove acceptance boundaries.
