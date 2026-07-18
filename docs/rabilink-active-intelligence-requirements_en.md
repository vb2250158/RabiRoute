<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-active-intelligence-requirements.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Active-Intelligence Requirements and Delivery Plan

> Status: implementation tracker for the phone-backed native-glasses route. AIUI feature development was paused on 2026-07-18; retained AIUI code is historical evidence only.

## Final architecture decision

```text
native glasses frontend
  -> captures and sends PCM to phone; stores no Relay credential and runs no ASR
phone glasses backend
  -> owns glasses settings, Relay credential, selected PC, cursor, and transfer queues
  -> calls restricted Relay speech proxy
Rabi PC glasses message endpoint
  -> RabiSpeech ASR -> record-first observation -> unified ledger -> Agent review

Agent / scheduler / planner
  -> RabiRoute Outbox and action gate -> persistent Relay downlink
phone
  -> polls text by cursor -> requests Rabi PC TTS -> sends PCM to glasses
glasses
  -> plays audio in order
```

The phone is not another RabiRoute configuration source. Route, Agent, workspace, and thread configuration remain on the Rabi PC and are edited by opening the remote WebGUI `/manage` from the phone.

## Required outcomes

1. Glasses connect to the selected Rabi PC through the phone and Relay; public credentials never live on glasses.
2. The phone can open remote PC configuration but has no duplicate Route/Agent/Codex binding editor.
3. Final ASR text is recorded first and does not synchronously interrupt Codex for every segment.
4. User observations, Agent downlinks, and manual review requests share one auditable JSONL timeline.
5. Codex reviews new context when idle, periodically, or when explicitly guided.
6. Codex, timers, and planners can enqueue proactive messages without a source `taskId`.
7. The phone resumes by cursor, requests PC TTS, and streams PCM to glasses in order.
8. ASR and TTS run only on the Rabi PC glasses message endpoint; phone and glasses host no speech model.
9. Photos and short videos are reliable message attachments. The first release does not claim live video or 24-hour capture.
10. High-risk external actions still pass through the RabiRoute action gate.

## Sources of truth

| Data | Owner |
| --- | --- |
| Route, role, policy, speech provider, and Agent configuration | PC RabiRoute |
| Unified conversation context | Role-directory JSONL ledger on PC |
| Public input/downlink mailbox and temporary attachment objects | Relay |
| Relay credential, selected PC, glasses settings, cursor, pending transfers | Phone app |
| Microphone/playback state and minimal HUD state | Glasses app |
| Model, tools, sandbox, approvals, and active turn | Bound PC Agent runtime |

Neither phone nor glasses becomes a second Agent, memory system, or configuration truth.

## Queue contracts

### Uplink audio

The glasses send tagged 16 kHz mono 16-bit PCM to the phone. Start/stop controls are idempotent because Classic Bluetooth and P2P may both deliver the same command. The phone wraps PCM as WAV, calls `/api/rabilink/speech/v1/audio/transcriptions`, then publishes a stable record-first observation through `/api/rabilink/devices/input`.

### Uplink media

The phone first uploads the binary to `/api/rabilink/devices/media`, then publishes an observation containing `attachments`. The PC worker downloads authenticated objects to private Route data before ledger append and Agent delivery. Failed binary upload must not create a dangling observation.

Photos are wired to the current physical-device callback. The protocol accepts video files, but the physical glasses video callback and disk-backed offline retry remain acceptance work. Media is a serialized message attachment, not a live stream.

### Review

The reviewer reads the unified ledger and advances persistent review state only after safe processing. Triggers include stable new observations, periodic reflection, manual review, and explicitly trusted urgent events.

### Downlink

User-facing text passes through `/api/agent/replies`, output policy, Relay Outbox, and the persistent message endpoint. The phone polls by cursor, calls `/api/rabilink/speech/v1/audio/speech`, extracts PCM from WAV, and streams it to glasses. Delivery and playback receipts are the next reliability layer.

## Privacy and safety

- Do not log tokens, transcript bodies, audio bodies, or private attachment content.
- Raw audio is not retained by default.
- Downloaded attachments stay under private Route data and are excluded from source control.
- Relay speech access is an explicit ASR/TTS allowlist, not general access to WebGUI, worker APIs, PC microphone control, or local URLs.
- Capture must be visible and pausable. Background operation requires a visible Android Foreground Service.
- External send, deletion, purchase, and device-control actions retain their existing approval rules.

## Acceptance sequence

1. Build both APKs and verify phone-driven install/launch.
2. Verify physical PTT from glasses through PC ASR to one ledger observation.
3. Verify proactive PC text through PC TTS and phone streaming to glasses playback.
4. Verify reconnect/cursor behavior and duplicate cross-transport command suppression.
5. Verify a photo arrives on PC as a local authenticated attachment.
6. Move the phone backend from Activity lifetime to a visible Foreground Service.
7. Add a disk-backed media/audio retry queue, exponential backoff, retention cleanup, and delivered/played receipts.
8. Wire physical-device video-file capture; assess live video only after reliable file messages.

## Historical AIUI boundary

AIUI cannot directly communicate with CXR-L and is not part of this primary route. Existing AIUI pages, tests, and release notes remain for regression and protocol history, but Craft submission or AIUI ASR/TTS acceptance no longer blocks the phone/glasses app milestone.
