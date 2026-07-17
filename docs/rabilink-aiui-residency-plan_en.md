<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-aiui-residency-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI Residency and Active-Intelligence Boundary

> Status: current boundary of an experimental path. The foreground AIUI loop has implementation and local-test evidence. System-level 24-hour background recording is not implemented and cannot be promised by AIUI.

## Exact conclusion

```text
AIUI kept in the foreground:
  enough for the glasses-side active-intelligence loop

Page hidden, closed, locked, or reclaimed by the host:
  no guarantee of continued microphone capture
```

## What the current foreground app can do

- Restart native ASR rounds while the page remains visible and not paused.
- Record final text as observations in the PC unified ledger instead of delivering every segment to Codex.
- Ask the bound Codex Desktop owner to review when idle, periodically, or after a touchpad request.
- Queue proactive downlink without an upstream task and consume it later by cursor.
- Speak ordinary and proactive messages through native TTS in order.
- Keep user observations, queued Agent messages, and control events on one JSONL timeline.
- Offer a configuration assistant that maps natural language to whitelisted PC-owned actions.

## What it cannot promise

- Microphone capture after the page is hidden, exited, locked, or reclaimed.
- 24-hour system background recording.
- Raw PCM, custom VAD, dynamic noise floor, pre-roll audio, Whisper confidence, or raw-audio playback.
- Reliable native TTS playback-complete callbacks on every host version.

Therefore:

```text
RabiLink AIUI = foreground HUD + ASR + TTS + touchpad + configuration
FenneNote/future Android foreground service = true resident capture lifecycle
```

## Current data flow

```text
AIUI foreground ASR
  -> POST /rokid/rabilink/input
  -> record-first observation
  -> PC worker appends rabilink-conversation.jsonl
  -> review later through the Desktop task owner

Codex / scheduler / planner
  -> POST /api/agent/replies
  -> RabiLink Outbox policy
  -> persistent Relay downlink
  -> GET /rokid/rabilink/messages?stream=1&after=<cursor>
  -> persistent device playback queue
  -> native TTS
```

Uplink and downlink progress independently. The user does not need to speak before a proactive message can be queued.

## Ledger and recovery

The role directory stores the current ledger, review state, archive volumes, and index. Rotation preserves original JSONL records. Index and cursor updates use atomic replacement; damaged indexes are reconstructed from the underlying files. Prefer a duplicate review over silently losing an observation.

## Foreground ASR loop

The page:

1. Starts recognition after the first stable frame.
2. Normalizes and persists final text.
3. Starts another round only when visible, unpaused, and not competing with TTS/model use.
4. Uses backoff for rapid empty/error endings and pauses after repeated failures.

Text-level protections include whitespace normalization, punctuation-only filtering, short-window exact duplicate suppression, post-TTS echo suppression, and bounded offline text retention. Audio-level controls are unavailable because AIUI does not expose the raw audio stream.

## Native TTS boundary

AIUI exposes `speechSynthesis.speak()`, but the host may not reliably emit complete utterance lifecycle callbacks. The implementation therefore uses host callbacks when present and a conservative length-based watchdog otherwise. A repeatedly failing item yields the queue so later proactive messages are not blocked forever.

The watchdog proves state-machine recovery, not that a physical device played every syllable. Real glasses must verify timing, echo behavior, and ASR resume.

## Configuration assistant

Conversation and configuration modes share one speech controller. The local `LanguageModel` chooses from a whitelist; PC RabiRoute remains the configuration source of truth. Deletion, external sends, device control, and other high-risk actions require confirmation.

## True 24-hour capture

A real resident capture layer needs an independent lifecycle, for example:

```text
Android foreground service or FenneNote
  -> microphone + visible resident notification
  -> AudioRecord/VAD/segmentation
  -> local or explicitly configured ASR
  -> same record-first observation contract
  -> same PC ledger/reviewer/downlink queue
```

RabiRoute can already merge a named FenneNote/Webhook source into the same record-first ledger through `rabilinkRecordFirstSources`. This supplements the PC side; it does not turn a PC microphone into a glasses microphone or grant AIUI a background lifecycle.

## Physical-device acceptance

Local automation is necessary but insufficient. The current release still needs proof of repeated foreground ASR, configuration-assistant conversation, ordinary/proactive TTS, post-TTS ASR recovery, hide/show playback recovery, touchpad behavior, device-status freshness, and same-session logs from the physical glasses.
