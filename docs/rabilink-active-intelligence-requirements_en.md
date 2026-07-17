<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-active-intelligence-requirements.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Active-Intelligence Requirements and Delivery Plan

> Status: implementation tracker for an experimental capability. The document combines code facts, device limitations, remaining engineering work, and acceptance criteria. Not every requirement is complete.

This English companion is deliberately organized around the current contract rather than mirroring every historical paragraph.

## Final architecture decision

Use one application-level path:

```text
RabiLink AIUI foreground app
  -> native ASR produces an observation
  -> HTTPS directly to the public Relay
  -> PC worker writes the unified conversation ledger
  -> Codex Desktop task owner reviews when idle, periodically, or on touchpad request

Codex / scheduler / planner
  -> RabiRoute Outbox and action gate
  -> persistent Relay downlink queue
  -> AIUI consumes by cursor
  -> native TTS plays messages in order
```

“Direct” describes the application protocol. AIUI calls Relay HTTPS itself. It does not exchange messages, audio, configuration, or cursors with CXR-L.

Confirmed limitation: AIUI cannot communicate directly with CXR-L. CXR-L may remain an independent native probe or device-management experiment, but it is not part of the AIUI message path and cannot stand in for AIUI acceptance.

## Voice strategy

Two phases share one adapter/DTO contract:

| Phase | ASR | TTS | Default cost behavior |
| --- | --- | --- | --- |
| First usable release | AIUI `SpeechRecognition` | AIUI `speechSynthesis` | No paid voice API |
| Later provider phase | Configurable ASR API | Configurable TTS API plus audio playback transport | Explicit opt-in, credentials, limits, and cost display |

Changing provider must not change the observation record, unified ledger, review workflow, or Relay downlink contract. CXR-L is not an AIUI voice adapter.

## Required user outcomes

1. Foreground AIUI continues recognition across utterances without requiring a wake word every time.
2. Final ASR text is recorded first; it does not interrupt Codex for every segment.
3. User observations, queued Agent downlinks, and touchpad review requests share one auditable JSONL timeline.
4. Codex reviews new context when its bound Desktop task is idle; periodic reflection can run without new input.
5. A touchpad click means “review recent context now.” The Desktop owner starts a turn when idle or steers the active turn when busy.
6. Codex, timers, and planners can send proactive messages without an upstream `taskId` and even while the glasses page is closed.
7. AIUI resumes by cursor, consumes backlog in order, and speaks messages through native TTS.
8. Configuration remains owned by PC RabiRoute; AIUI may invoke only whitelisted configuration actions.
9. The system never claims 24-hour background recording from AIUI.

## Current implementation baseline

Implemented or locally covered:

- AIUI foreground ASR loop and conservative retry/backoff.
- Persistent TTS queue with watchdog recovery when the host does not emit lifecycle callbacks.
- Record-first observation handling.
- Unified conversation ledger, date/idle rotation, archive index, and recovery from index damage.
- Idle review, periodic reflection, and touchpad-guided review.
- Proactive task-free Relay downlink through `/api/agent/replies` and RabiLink Outbox.
- Configuration assistant with a whitelist of safe actions.
- Local automation for queue contracts, ledger recovery, voice adapters, interaction modes, and visual/runtime safety.

Still requiring external or physical-device acceptance:

- Current Craft upload/binding/review flow.
- Repeated ASR and TTS on physical glasses.
- Touchpad semantics on the real device.
- Network interruption, page hide/show, and backlog recovery.
- Device-status freshness and long-session stability.
- Future ASR/TTS API providers.
- Any true system-level background capture service.

## Sources of truth

| Data | Owner |
| --- | --- |
| Route, role, policy, and configuration | PC RabiRoute |
| Unified conversation context | Role directory JSONL ledger on PC |
| Public input/downlink mailboxes | Relay application state |
| Per-device cursor and temporary pending playback | Device client |
| Model, tools, sandbox, approvals, and turn state | Bound Codex Desktop task owner |
| Device network and platform lifecycle | AIUI/Android host |

No phone, glasses page, Relay process, or CXR-L probe becomes a second Agent or configuration source of truth.

## Queue contracts

### Uplink observation

Final ASR text and control events use stable identity and producer time. Record-first input is accepted and completed after the PC ledger write; it does not wait for a Codex answer.

```text
POST /rokid/rabilink/input
```

### Review work

The reviewer reads the ledger and persists review cursor/state. It must not skip unreviewed records when the ledger rotates or Codex was offline.

Triggers:

- new stable observations after the settle window;
- periodic reflection;
- touchpad manual review;
- optional explicitly trusted urgent events.

### Downlink

User-facing text goes through:

```text
POST /api/agent/replies
  -> targetType=rabilink
  -> proactive=true when no source task exists
  -> route output policy
  -> Relay outbox
  -> GET /rokid/rabilink/messages?stream=1&after=<cursor>
```

The Relay keeps downlink independently of an input task. Retries use a stable `deliveryId` for idempotency.

## Unified conversation ledger

Current role data:

```text
rabilink-conversation.jsonl
rabilink-conversation-review-state.json
rabilink-conversations/
  index.json
  YYYY-MM-DD.jsonl
  YYYY-MM-DD-02.jsonl
```

Directions:

- `user_to_agent`: observations, normally `requiresReview=true`.
- `agent_to_user`: messages successfully queued for device delivery.
- `control`: touchpad/manual-review and related control events.

Rotation is mechanical: preserve original records, move by local date or configured idle gap, and rebuild indexes from JSONL when necessary. Do not summarize or rewrite raw timeline records during rotation.

## Active review guardrails

- Review only new/unreviewed context plus the necessary surrounding timeline.
- Apply cooldowns and deduplication to avoid repetitive proactive speech.
- Prefer one high-value observation or action over a long monologue.
- User questions and manual touchpad review may bypass normal cooldowns but remain audited.
- Emergency intervention is reserved for credible, imminent safety risk.
- External actions still require the relevant Outbox/action policy.

## Touchpad contract

In connected-conversation mode, a single click means:

> Review what I have said recently and tell me the most useful thing at the current safe point.

It does not pause ASR. If the TTS queue explicitly shows a failed head item, the UI may reuse a click to retry that failure, but the state must be visibly distinct from review mode.

## Configuration assistant boundary

The local AIUI `LanguageModel` may map natural language to a small whitelist of RabiLink/WebGUI actions. It is not a recursive call into the bound full Agent loop. Destructive, external-send, device-control, deletion, or secret-changing actions require explicit confirmation and remain owned by PC RabiRoute policy.

## Reliability requirements

- Stable IDs for observations, deliveries, sessions, devices, and cursors.
- Persistent queues on both Relay and device sides.
- Cursor advancement only after local persistence/processing.
- Idempotent retry by `deliveryId`.
- Bounded exponential backoff and visible offline state.
- Atomic ledger/index/review-state replacement and stale-lock recovery.
- TTS failures cannot block later messages forever.
- ASR/TTS handoff must avoid capturing the system's own speech.
- No raw audio retention by default.

## Security and privacy red lines

- Continuous capture must be explicit and visibly indicated.
- Recording, transcript retention, raw-audio retention, external send, and deletion are separately authorized.
- Tokens belong to their application/device scope and never appear in public examples.
- The local Manager is not exposed directly to the Internet; remote WebGUI is proxied through the Relay/PC worker.
- Device clients do not receive other devices' messages unless the envelope explicitly targets their kind/ID.

## Acceptance gate

The capability is not “usable on glasses” until the current build proves:

1. Craft upload, binding, installation, and launch.
2. Continuous foreground ASR over multiple utterances.
3. Record-first PC ledger writes without per-segment Codex turns.
4. Idle, periodic, and touchpad review through the bound Desktop owner.
5. Ordinary and task-free proactive downlink with cursor recovery.
6. Native TTS queue, failure recovery, and ASR resume without echo loops.
7. Page hide/show and network interruption recovery.
8. Current-version evidence from the same physical-device session.

Until then, describe the feature as locally implemented and experimentally integrated—not as a verified production wearable loop.
