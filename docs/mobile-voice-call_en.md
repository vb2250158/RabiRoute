# Phone voice calls and message Routes

English | [简体中文](mobile-voice-call.md)

> Status: experimental implementation. Automated checks and builds do not replace physical multi-turn speech, listening, offline recovery, and recording-restoration acceptance.

## Use

Each message-list row represents one selectable RabiLink message Route published by its PC. Multiple Routes for the same persona remain separate. The avatar is on the left; the first line contains the persona name on the left and “computer · Route” on the right; the second contains the latest-message preview and its date or time. Persona-only setup rows are excluded. Connection and endpoint diagnostics remain in details and settings. Local history is retained; an original Route notification can still open history for a retired Route.

Open a conversation and tap **Phone** in the upper right. Microphone permission and the PC's published voice-call protocol are required. Starting fixes the PC identity, Route, and authenticated connection for that call. Choosing another conversation or computer cannot retarget it. The PC providing remote persona material differs from the PC owning the delivery Route: the list shows the Route owner. If a remote persona's display name is unavailable, its explicit persona ID is used; a local namesake's name or avatar is not substituted.

The call surface shows connecting, listening, waiting for a reply, speaking, muted, and error states. Acoustically valid speech remains a recording, uses PC transcription, and queues each final nonempty transcript through the selected Route's formal message input. Ordinary transcription-only recordings receive no call authorization and do not wake an Agent as a consequence.

**Mute** blocks new microphone data from recording and uplink; replies can still play. **Hang up** stops this call's capture and automatic playback, seals received audio, and restores the prior recording intent. Save failure keeps capture stopped with an explanation. An explicit recording-page switch or pause ends the call and follows the new recording operation. A call does not change persistent recording mode, enabled state, or Route. Calls do not resume after process exit.

The current implementation takes turns: playback suppresses capture, so natural interruption is unsupported. An AudioTrack completion marker confirms playback progress; it does not prove suitable volume, audibility, or listening quality.

## Delivery and late replies

- A live input is valid for at most 90 seconds from the end of its recording. Both the phone before upload and the PC before forwarding check it. Expired inputs and unsent inputs after hangup remain recordings and are not delivered indefinitely after reconnection.
- Each final event has a stable `rabi-call-v1` source ID containing the call, deadline, PC, Route, and event digest. Relay may simply preserve the opaque ID. The PC checks identity and time before formal forwarding. A changed PC or Route is rejected rather than retargeted.
- The PC durably claims a source ID once. Failure or process exit after claiming can leave an uncertain outcome; repeats cannot trigger another Agent turn. A new utterance can produce a new input, while the original recording remains reviewable.
- AgentPacket and the formal RabiLink send API preserve the source ID as the reply's `taskId`. Automatic phone playback requires both the active call association and the same Route. Old-call, late, cross-Route, and uncorrelated replies remain chat messages; ordinary replies are not guessed to belong to a call.
- Hangup does not cancel Agent execution already delivered to the PC. Relay-accepted inputs awaiting PC processing remain subject to the 90-second lifetime.

Claim writes emit mutation audit after persistence and synchronization, containing only the input digest and outcome, without recorded text, raw source IDs or local directories.

## Maintenance boundary

`RabiConversationService` remains the sole coordinator. Calls reuse `CaptureOwnership`, `RabiPhoneAudioCapture`, acoustic splitting, the durable spool, `RabiEventAsrUploader`, and the phone player. A frozen `call_` capture ID uses transcription-only processing; its final-transcript callback authorizes messaging only for that active call.

Existing recording-upload authorization remains frozen. A call event obtains its final receipt from the same ASR actor before the existing reliable archive upload can consume it, avoiding eviction races with PCM reads. Network failure does not delete recordings. Live-input deadlines and reliable recording/archive retention are separate contracts.

SDK `getMobileRoutes` returns selectable phone Routes. `getMobileRouteCatalog` retains the full configuration catalog for management and must not be used directly as a chat picker. Phone metadata caches retain the Route owner, computer name, persona source PC, and call protocol. `src/manager/rabiApi.ts` owns the PC summary; `src/shared/mobileVoiceCall.ts` and the RabiLink adapter enforce live-input fences. No Agent Runtime is replaced or added.

Acceptance must cover multiple Routes for one persona, correct PC and Route, at least two actual speech turns, final-transcript delivery, phone playback, mute, hangup during playback, late replies, isolation between old and new calls, prior-recording restoration, offline expiry, and missing permissions or PC capability. Report logic, build, installation, device, and listening evidence separately.
