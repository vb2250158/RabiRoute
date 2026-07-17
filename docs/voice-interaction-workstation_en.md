<!-- docs-language-switch -->
<div align="center">
English | <a href="./voice-interaction-workstation.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Voice Interaction Workstation

> Maturity: experimental. Generic Webhook/FenneNote input and Outbox wiring exist, while real devices, TTS, and role experience still require environment-specific acceptance.

This guide connects RabiRoute, FenneNote transcription, role dialogue, and OumuQ TTS without exposing private recordings, chat logs, IDs, tokens, secrets, or role data.

## Positioning

```text
Microphone / voice message
  -> FenneNote transcription webhook
  -> RabiRoute normalization and route policy
  -> Codex or another handler runtime
  -> role-faithful response and action decision
  -> Agent-visible text, QQ/WeCom/RabiLink reply, or FenneNote/OumuQ playback
```

FenneNote performs speech-to-text. The handler understands context and writes the response. OumuQ synthesizes approved speech. RabiRoute records the event, selects the handler, supplies context, and applies outbound policy.

## Accepted event shape

The current webhook-like adapter reads:

- `type`;
- `id` or `messageId`;
- `source` or `sender`;
- text from `text`, `message`, `content`, `query`, `prompt`, `input`, or `question`;
- optional speaker, device, session, and time fields.

```json
{
  "type": "voice_transcript",
  "id": "<stable-event-id>",
  "source": "fennenote",
  "text": "<recognized text>",
  "speakerName": "<display-name>",
  "speakerConfidence": 0.92,
  "sourceDeviceId": "<device-id>",
  "sessionId": "<session-id>",
  "startedAt": "2026-06-05T10:00:00+08:00",
  "endedAt": "2026-06-05T10:00:05+08:00"
}
```

The ID is recorded as the message ID, but the generic FenneNote/Webhook path has no persistent global `eventId` deduplication table. The sender must avoid duplicate submission or provide its own idempotency.

The adapter does not parse nested `actionInstruction.replySurface`, `allowExternalSend`, or `allowTts`. Output is decided by the route pipeline, message-adapter policy, injected `replyContext`, and any explicit target:

- `outputAdapter=agent`: keep the result in the Agent session.
- `outputAdapter=fennenote`: Outbox posts a reply or playback request.
- Explicit QQ, WeCom, or RabiLink source/target: use that adapter's Outbox policy.
- Missing route/target or denied policy: return `blocked` with draft data.

Voice is only the input medium. A conversational sentence must not be published to QQ unless the target is explicit and policy permits it.

## Route rule

Use route kind:

```text
voice_transcript
```

The generated packet already includes transcript text, source metadata, pipeline, reply context, role paths, and recent logs. A route template should only add voice-specific decision rules.

## Role dialogue and TTS

Treat visible text and speech text as related but distinct artifacts:

- `visibleText` preserves the full role voice for users or chat platforms.
- `ttsText` derives from visible text and changes only pronunciation, pauses, or light multilingual rendering.

Do not write a neutral assistant reply and ask TTS alone to perform the role. Translation must preserve identity, tone, and relationship.

A handler may prepare an internal structured draft:

```json
{
  "visibleText": "<role-faithful reply>",
  "ttsText": "<role-faithful speech text>",
  "ttsProvider": "oumuq",
  "notes": "<internal notes, never external chat>"
}
```

RabiRoute does not automatically parse this draft as a webhook instruction; the handler/output bridge must map it to the configured reply/playback API.

## External-action safety

RabiRoute may record events, deliver to the handler, and create internal drafts automatically. QQ/NapCat, WeCom, RabiLink, and FenneNote output always goes through Outbox and adapter policy. There is no generic WebGUI approval queue. A blocked result must be completed and resubmitted by the user or an authorized upper workflow.

Public examples must not contain real accounts, group IDs, user IDs, cookies, tokens, webhook secrets, private paths, transcripts, recordings, persona memory, or user profiles. Keep `data/`, `logs/`, `recordings/`, `transcripts/`, and caches out of Git.

## Minimal implementation checklist

1. Configure FenneNote to POST each transcript as `voice_transcript`.
2. Make the sender avoid duplicate submission; RabiRoute does not promise global event-ID deduplication.
3. Add a `voice_transcript` rule in the role's `personaConfig.json`.
4. Deliver the packet to the fixed Codex/handler thread; start when idle and steer when active.
5. Generate role-faithful visible text and optional speech text.
6. Send only approved speech text to OumuQ/FenneNote playback.
7. Route any external response through `/api/agent/replies` and the corresponding message-adapter policy.

For RabiLink record-first observation, place FenneNote and `rabilink` on the same route and set `routeVariables.rabilinkRecordFirstSources` to include `fennenote`. That mode writes the shared conversation ledger and waits for idle/periodic/touchpad review instead of delivering every transcript directly. Do not configure another route to consume the same webhook simultaneously.

## Repository boundaries

- RabiRoute owns the event model, routing policy, templates, Outbox gate, and public workflow documentation.
- FenneNote owns audio capture, transcription quality, payload retry, and deduplication semantics.
- OumuQ/role-dialogue systems own role voice, multilingual speech rendering, and playback.

This repository documents interfaces and constraints only; it must not copy private implementation or runtime data from those projects.
