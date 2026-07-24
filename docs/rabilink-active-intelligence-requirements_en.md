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
  -> RabiSpeech VAD/segmentation/ASR/voiceprint
  -> host-wide speech store -> enabled rabilink Route
  -> user-state quantification / scenario recognition -> persona conversation context
  -> hot/keyword/observation policy -> Agent persona decision

Agent / scheduler / planner
  -> RabiRoute Outbox and action gate -> persistent Relay downlink
phone
  -> subscribes to Relay events -> recovers messages by cursor after an event -> requests Rabi PC TTS -> sends PCM to glasses
glasses
  -> plays audio in order
```

The phone is not another RabiRoute configuration source. Route, Agent, workspace, and thread configuration remain on the Rabi PC and are edited by opening the remote WebGUI `/manage` from the phone.

Post-connection delivery follows the NapCat relationship: the endpoint supplies normalized events, while each enabled Route that allows `rabilink` selects the bound persona.

Every persona owns its speech history, unified conversation, and other persona files. The host stores one raw speech record plus opaque voiceprint evidence and decides neither identity nor who the user is.

Each receiving persona writes conclusions such as `isUser` into its own `voice/voice-identities.jsonl`.

Active intelligence reacts only to observation, Route, persona-relationship, Agent-idle, manual-trigger, and explicit timer or heartbeat events.

It must not reread ledgers or query coverage on an interval to discover changes. Coverage APIs are on-demand diagnostics only.

## Required outcomes

1. Glasses connect to the selected Rabi PC through the phone and Relay; public credentials never live on glasses.
2. The phone can open remote PC configuration but has no duplicate Route/Agent/Codex binding editor.
3. Final ASR text enters the host-wide speech store first, then enabled `rabilink` Routes apply their `hot/keyword` policy. With no subscription it remains record-only and never bypasses Route policy for direct delivery.
4. User observations, Agent downlinks, and manual review requests share one auditable JSONL timeline.
5. Codex reviews new context when idle, periodically, or when explicitly guided.
6. Codex, timers, and planners can enqueue proactive messages without a source `taskId`.
7. The phone resumes by cursor, requests PC TTS, and streams PCM to glasses in order.
8. ASR and TTS run only on the Rabi PC glasses message endpoint; phone and glasses host no speech model.
9. Photos and short videos are reliable message attachments. The first release does not claim live video or 24-hour capture.
10. High-risk external actions still pass through the RabiRoute action gate.
11. The PC maintains versioned current-user-state and scenario snapshots. The Agent combines them with persona and user settings to choose no interruption, preparation, prompting, recommendation, or action.
12. Each persona maintains an inspectable, correctable, deletable, and synchronized user model that separates trait hypotheses, learned preferences, and current psychological state.
13. The Companion App exposes one persisted `PAUSED / PHONE / GLASSES` mode state. A transition releases the old capture path before enabling the new one, and glasses mode remains paused with a visible reason until a physical glasses connection exists.
14. A user may submit an explicit proactivity preference, but the App and Relay carry it only as an observation and message metadata. Final intervention remains a PC-context, Route-action-gate, and target-Agent decision.

## Sources of truth

| Data | Owner |
| --- | --- |
| Route, role, policy, speech provider, and Agent configuration | PC RabiRoute |
| Raw speech and processing evidence | Host-wide PC `data/speech/messages/YYYY-MM-DD.jsonl`, one record per utterance |
| Persona speech records and unified conversation context | Each persona's `voice-transcripts.jsonl` and `conversation/current.jsonl` |
| Who a voiceprint is and whether it is that persona's user | Each persona's own `voice/voice-identities.jsonl`; host and Route do not decide |
| Public input/downlink mailbox and temporary attachment objects | Relay |
| Relay credential, selected PC, Route/persona selection, requested input mode, explicit proactivity preference, cursor, pending transfers, and message-restore intent | Phone app |
| Actual runtime input mode, capture state, connection state, and latest error | Phone foreground service; settings UI renders service events only |
| Microphone/playback state and minimal HUD state | Glasses app |
| Model, tools, sandbox, approvals, and active turn | Bound PC Agent runtime |
| Current user state and scenario snapshots | PC active-intelligence context layer; rebuildable from device events and conversation evidence |
| Stable trait hypotheses and learned preferences | Target persona's user-profile domain, derived from append-only evidence and corrections and synchronized with the persona |
| Agent personality, tone, and proactivity tendency | Persona configuration, separate from the individual user model |
| Intervention intensity and presentation | Target Agent persona combining user state, scenario, user model, explicit instruction, and risk |

Neither phone nor glasses becomes a second Agent, memory system, or configuration truth.

## User-State Quantification and Scenario-Recognition Boundary

> Status: target contract. Speech, voiceprint, device, health, Route, and unified-ledger paths already provide partial evidence. A unified `CurrentUserState` and scenario lifecycle still require implementation and physical acceptance.

Devices report observations, not final scenarios. Phone, glasses, watch, computer, and RabiSpeech must not each maintain separate authoritative conclusions such as “the user is in a meeting” or “the user is unhappy.”

The PC active-intelligence context layer first fuses events into user-state dimensions, then derives primary and secondary scenarios.

RabiRoute may record events, expose a safe snapshot, and include it in AgentPacket. It does not replace the Agent persona's action decision.

### User-State Dimensions

| Dimension | Example variables |
| --- | --- |
| Time | Local time, time of day, day type, distance to schedule event, state duration |
| Environment | Place class, indoor/outdoor, noise, light, weather, privacy level |
| Activity | Still, walking, driving, exercise, computer operation, cooking |
| Emotion | Valence, arousal, stress, irritation, confidence |
| Physical | Heart-rate delta from baseline, fatigue, sleep, posture, activity intensity |
| Attention | Focus, cognitive load, confusion, hesitation, interruption level |
| Social | Alone or not, participant count, speaker relationships, whether someone addresses the user |
| Task | Project, stage, progress, blocker, urgency, commitment |
| Interaction | Interruptibility, screen availability, audio availability, hands busy, available devices |
| Device and safety | Network, battery, sensor freshness, risk, permissions, privacy mode |

Each dimension uses an appropriate value type and carries `confidence`, `observedAt`, `expiresAt`, `evidenceRefs`, `sourceKinds`, and `userConfirmed`.

Deterministic time facts need no fake model score. Mood should be multi-axis, not one happy/unhappy label.

### Individual User Model and Psychological Boundary

> Status: target contract, not implemented. Persona directories already contain preference, memory, conversation, and voice-relationship evidence.
>
> No unified `UserIndividualModel`, append-only model event log, or user-control surface exists yet.

The individual user model contains at least four layers:

1. Stable trait hypotheses: continuous Five-Factor dimensions used only as low-weight priors.
2. Learned preferences: context-scoped initiative, medium, explanation, timing, and confirmation preferences.
3. Current psychological state: valence, arousal, stress, fatigue, cognitive load, frustration, and motivational needs.
4. Situation characteristics: explainable dimensions such as duty, intellect, adversity, positivity, negativity, deception risk, and sociality.

Stable traits and learned preferences belong to the persona user-profile domain. Current psychological state and situation characteristics stay owned by the rebuildable PC context layer.

The profile references current views instead of copying stale state.

The target contract needs no separate manual UID. The persona directory locates the model today. A controlled `userProfileRef` appears only if several Agent personas later share one profile.

```json
{
  "schemaVersion": 1,
  "stableTraits": {},
  "preferences": {},
  "currentPsychologicalStateRef": "current-user-state",
  "situationCharacteristicsRef": "current-scenarios",
  "evidenceCursor": "<profile-event-ledger-position>",
  "updatedAt": "<iso-time>"
}
```

Inference and correction append events. Evidence priority is current explicit instruction, confirmed setting, repeated correction, repeated cross-time behavior, then one weak inference.

Corrected conclusions remain auditable but stop influencing decisions.

AgentPacket injects only the smallest context-relevant user-model slice, including source and confidence, never a complete psychological profile.

RabiRoute records and delivers it safely but does not interpret the user or let trait scores bypass permissions.

The user surface must support evidence inspection, confirmation, correction, deletion, learning pause, and export. Passive signals must not produce clinical diagnoses. Sensitive relationship inference stays off by default.

### Scenarios and Intervention

Scenarios may be hierarchical and concurrent. A macro scenario can be work, the activity can be a meeting, and a micro scenario can be task assignment.

The system retains a primary scenario, secondary scenarios, confidence, alternatives, evidence, and lifecycle.

The intervention strategy combines:

```text
current user state and interruptibility
+ primary and secondary scenarios
+ Agent persona's proactivity tendency
+ contextual preferences and low-weight trait hypotheses
+ current explicit instructions
+ benefit, timeliness, and confidence
- action risk and irreversible cost
```

The result may be no interruption, background preparation, subtle prompt, proactive recommendation, confirmation request, direct action, or emergency intervention.

In one meeting, a cautious persona may summarize later while an action-oriented persona shows an immediate glasses prompt.

User corrections append auditable events, such as “I am not in a meeting,” “I am drafting a proposal,” or “remind me directly next time.” Corrections derive state and scenario again instead of overwriting raw device evidence.

State and scenario changes must be driven by new events, user corrections, or explicit expiry events. The system must not reread complete ledgers on an interval to discover change.

The current snapshot is a rebuildable read model, not a second event truth.

## Queue contracts

### Uplink audio

The glasses send tagged 16 kHz mono 16-bit PCM to the phone. Start/stop controls are idempotent because Classic Bluetooth and P2P may both deliver the same command. The phone performs no VAD, utterance segmentation, or ASR. It continuously forwards ordered PCM chunks through the restricted `audio-streams/rabilink/start|chunk|stop` endpoints to the target PC. `source_device_id` preserves the stable companion-backend identity that subscribes to downlink events and therefore owns reply addressing; `device_kind` distinguishes phone versus glasses as the physical origin, while `stream_id` identifies only the current PCM connection. RabiSpeech owns VAD, segmentation, ASR, and voiceprint processing, then automatically stores the completed host-wide speech message and enters the `rabilink` Route selected by `routeProfileId`. `/api/rabilink/speech/messages` remains compatibility/debug only.

### Uplink media

The phone first uploads the binary to `/api/rabilink/devices/media`, then publishes an observation containing `attachments`. The PC worker downloads authenticated objects to private Route data before ledger append and Agent delivery. Failed binary upload must not create a dangling observation.

Photos are wired to the current physical-device callback. The protocol accepts video files and the phone media disk queue is implemented, while the physical-glasses video callback plus weak-network/process-recovery acceptance remain. Media is a serialized message attachment, not a live stream.

### Review

Only ledger append events for record-only observations or manual review requests wake the reviewer, which advances persistent review state only after safe processing. Ordinary direct messages already enter the Route/Agent delivery path and do not trigger a redundant ledger read. Continuous-speech observations must persist their source `routeProfileId`; automatic review selects the reply Route from pending records, and a multi-Route batch exposes the complete Route set to the Agent with an explicit requirement to deliver per record rather than falling back to a default persona. Settle, busy retry, and periodic reflection are one-shot scheduled events; without a pending review-owned observation, manual request, or due timer, it does not reread JSONL.

### Downlink

User-facing text passes through `/api/agent/replies`, output policy, Relay Outbox, and the persistent message endpoint. Relay pushes `outbox_available` through `/api/rabilink/events`; the phone reads one cursor-bounded delta after the event, uses the same cursor only for reconnect recovery, then calls `/api/rabilink/speech/v1/audio/speech`, extracts PCM from WAV, and streams it to glasses. The phone persists `delivered/played/playback_failed` before replaying them to Relay, which stores the receipts and emits `outbox_receipt`. Only the phone's or glasses' own `AudioTrack` marker may produce `played`; Relay, estimated duration, and “PCM written to the channel” cannot infer it.

Phone-private text, control, media, receipt, and downlink queues share fsync plus atomic replacement. Startup removes incomplete temporary files; malformed JSON, missing media binaries, and orphaned attachments move to quarantine with a visible error so one poison item cannot block later work forever. Reliable facts remain until acknowledgement or explicit user handling. Real-time PCM uses a separate acknowledgement-sensitive chunk and bounded newest-audio buffer so reconnect catches the live stream instead of replaying every obsolete sound.

## Privacy and safety

- Do not log tokens, transcript bodies, audio bodies, or private attachment content.
- Raw audio is not retained by default.
- Downloaded attachments stay under private Route data and are excluded from source control.
- Relay speech access is an explicit ASR/TTS allowlist, not general access to WebGUI, worker APIs, PC microphone control, or local URLs.
- Capture must be visible and pausable. Background operation requires a visible Android Foreground Service.
- External send, deletion, purchase, and device-control actions retain their existing approval rules.
- Psychological state, trait hypotheses, and preferences stay local to the persona profile by default and never enter Relay primary storage, public logs, or open-source examples.
- Users must be able to pause personalization learning and inspect, correct, delete, or export the system's long-term understanding of them.

## Acceptance sequence

1. Build both APKs (automation complete), then verify real phone-driven install and glasses launch.
2. Verify physical PTT from glasses through PC ASR to one ledger observation.
3. Verify proactive PC text through PC TTS and phone streaming to glasses playback.
4. Verify reconnect/cursor behavior and duplicate cross-transport command suppression.
5. Verify a photo arrives on PC as a local authenticated attachment.
6. The phone backend has moved to a visible Foreground Service in code; continue with system-reclaim, reboot, and notification-interaction acceptance.
7. Text/control, media, and device receipts use disk-backed reliable queues. Unconfirmed entries are no longer silently age-pruned; capacity exhaustion rejects new work explicitly. Continue validating weak-network backoff, the product choice for brief PCM across process death, and actual phone/glasses speaker output.
8. Wire physical-device video-file capture; assess live video only after reliable file messages.

## Current completion audit (2026-07-24)

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Glasses capture only, phone owns Relay credentials, PC owns speech processing | The Android production path sends ordered PCM only; PC `audio-streams/rabilink/*` owns VAD, segmentation, ASR, and voiceprint | Code and automation pass; physical-glasses acceptance remains |
| Route selects persona like NapCat | One host raw record is written before fan-out; `speech` and `rabilink` subscriptions remain separate; `hot/keyword` returns real `delivered/recorded/failed` outcomes | End-to-end tests pass |
| Persona owns conversation, files, and identity interpretation | Every persona separately writes `voice-transcripts.jsonl`, `conversation/current.jsonl`, and `voice/voice-identities.jsonl`; host person names are removed and only opaque evidence remains | End-to-end tests pass |
| Replies return to the originating phone/glasses backend | Stable `sourceDeviceId` owns downlink addressing and transient `sourceStreamId` identifies PCM only; AgentPacket, Outbox, and Relay tests lock the boundary | End-to-end tests pass |
| Single-source three-state mode and mutually exclusive capture | Settings persist the requested `PAUSED / PHONE / GLASSES` mode; the Service owns the actual runtime mode and releases the old capture path first; capture remains paused before a glasses connection event and after disconnect; the runtime card refreshes from broadcasts | Code, unit tests, and architecture audit pass; physical Bluetooth switching remains |
| Explicit proactivity preference does not take over decisions | `agent_decides / quiet / balanced / proactive` is durably recorded as a `rabilink.preference` observation and carried with text, control, media, and PCM metadata; App and Relay do not convert it into a local intervention rule | Code, Relay metadata tests, and persona-ledger tests pass |
| Event-driven operation without idle business polling | Relay/RabiSpeech SSE, filesystem events, ledger wakeups, and one-shot deadlines are active; Android SSE/reliable sending waits for a system connectivity event while known offline, with a five-minute OS-connectivity check only during known-offline state to cover vendor callback loss without reading business data, and backs off only for a server failure on an available network; the production-source gate permits only five registered exceptions | Gate, mobile architecture audit, and Android event-gate tests pass; physical validation of a missed vendor callback remains |
| Visible Android background host | `RabiConversationService` is a `START_STICKY` Foreground Service with notification, restore-after-boot, and input-mode switching | Code and APK builds pass; real system-reclaim/reboot acceptance remains |
| Reliable text, media, receipt, and downlink queues | Each reliable fact is atomically persisted to phone-private disk before transmission; success removes it, failure remains for event-driven or bounded-backoff retry; malformed JSON, missing binaries, and orphaned attachments are quarantined with visible errors instead of blocking later items | Code and automation pass; weak-network and corruption recovery still need physical-device acceptance |
| Short continuous-PCM retry | The unacknowledged chunk retains its original sequence and bytes; PC accepts identical sequence/hash retries idempotently, while repeated failure rebuilds transport without discarding current-process pending PCM | Code passes; PCM held only in memory is not promised across process death |
| Downlink cursor, TTS, ordered playback, and receipts | Phone subscribes to `outbox_available` and performs one cursor query; explicit-target Relay messages do not TTL-expire before `delivered`; phone/glasses return `played` only after their own AudioTrack marker; glasses confirm capture pause before PCM and fail explicitly on destruction | Protocol, durable queues, state machine, concurrency sequencing, and automation pass; physical speaker playback remains |
| Real-person voiceprint | The current model probe produces a real 192-dimensional embedding; persistent unknown clusters, day-long bounded prototypes, and overlap rejection are tested | Private corpus remains 0/32; formal automatic identity is not accepted |
| Multi-PC persona synchronization | Same-token discovery, LAN-first, Relay fallback, JSONL union, ordinary-file fast-forward/deletion/conflict/resolution publication all have real HTTP and Relay-child-process tests | Automation passes; two physical PCs and long-run acceptance remain |
| User-state and scenario recognition | The multidimensional state, evidence envelope, scenario hierarchy, and state-plus-scenario-plus-persona intervention contract are defined | Design complete; unified state service, scenario engine, and physical-scenario acceptance remain |

Therefore neither buildable APKs nor a runnable model are presented as physical-environment completion. Remaining evidence is a private real-speaker threshold report, two physical PCs exercising disconnect/conflict/endurance, and phone/glasses weak-network PCM, process-reclaim, and real playback acceptance.

## Unified physical-environment acceptance status

`npm run check:active-intelligence:physical -- [options]` is the fail-closed, one-shot evidence aggregator. It starts no model, Manager, phone, or glasses test, never polls a device, and never treats green automation as physical completion. By default it reads only narrow Git-ignored locations for the latest persona-sync, Android soak, and Rokid summaries; the formal speaker report must be supplied explicitly through `--speaker-report <json>`. The aggregate contains evidence SHA-256 values, times, check results, and `missing / partial / passed / stale / invalid` states only. It omits tokens, message bodies, persona names, device serials, host names, and private paths. Any incomplete domain returns exit code `2` by default; `--allow-incomplete` is an explicit report-only mode.

All four domains must pass independently:

- `voiceprint`: the private dataset must be `real_person_private`, formally eligible, pass the complete policy and every target engine, and match the dataset hash in the report. Synthetic TTS cannot satisfy formal evidence.
- `personaSync`: schema-v2 physical synchronization evidence must combine `syncPassed`, explicit confirmation of two distinct physical hosts, and `formalAcceptanceEligible`; operator evidence must separately confirm LAN, Relay fallback, disconnect recovery, conflict resolution, and endurance. A successful functional sync cannot impersonate formal physical evidence.
- `android`: a real-device soak must run for at least 23.5 hours with increasing PCM, plus operator confirmation of offline recovery, process-reclaim recovery, boot recovery, and audible phone playback.
- `rokid`: the real-device script must actually request and receive TTS and non-empty ASR evidence, plus operator confirmation of continuous PCM, touchpad behavior, audible playback, and connection recovery.

Physical facts that require human observation go in the local ignored file `output/acceptance/active-intelligence-physical-observation.json`. Do not hand-edit the file or flip every value to true at once. Use the controlled command to confirm, revoke, or reset individual observations:

```powershell
npm run record:active-intelligence:physical -- --list
npm run record:active-intelligence:physical -- --confirm personaSyncLan
npm run record:active-intelligence:physical -- --revoke personaSyncLan
npm run record:active-intelligence:physical -- --reset
```

Every `--confirm` must explicitly name an allowlisted check ID. The command starts no test, polls no device, and offers no confirm-all shortcut. It copies an existing file into the sibling `archive/` directory before atomically updating the current file. The first run generates random environment evidence and stores only its SHA-256; later updates reuse that hash. Host names, device serials, accounts, notes, and free text are never stored. The current file shape is:

```json
{
  "schemaVersion": 1,
  "kind": "active_intelligence_physical_observation",
  "generatedAt": "2026-07-24T12:00:00.000Z",
  "operatorConfirmed": true,
  "environmentIdHash": "<64 lowercase hex characters>",
  "checks": {
    "personaSyncDistinctPhysicalHosts": false,
    "personaSyncLan": false,
    "personaSyncRelayFallback": false,
    "personaSyncDisconnectRecovery": false,
    "personaSyncConflictResolution": false,
    "personaSyncLongRun": false,
    "androidOfflineRecovery": false,
    "androidProcessReclaimRecovery": false,
    "androidBootRecovery": false,
    "androidPhonePlayback": false,
    "rokidContinuousPcm": false,
    "rokidTouchpad": false,
    "rokidPlaybackHeard": false,
    "rokidConnectionRecovery": false
  }
}
```

Example:

```powershell
npm run check:active-intelligence:physical -- `
  --speaker-report plugin-adapters\rabi-speech\output\benchmarks\speaker-validation.json
```

## Historical AIUI boundary

AIUI cannot directly communicate with CXR-L and is not part of this primary route. Existing AIUI pages, tests, and release notes remain for regression and protocol history, but Craft submission or AIUI ASR/TTS acceptance no longer blocks the phone/glasses app milestone.
