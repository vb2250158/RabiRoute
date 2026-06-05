---
name: rabiroute-voice-workstation
description: Build or review a public-safe voice interaction workstation that connects FenneNote voice transcripts, RabiRoute routing, role-faithful dialogue, and OumuQ TTS without leaking private chat logs, accounts, paths, webhook secrets, NapCat config, or role-private data.
---

# RabiRoute Voice Workstation

Use this skill when you need to design, document, implement, or review the workflow:

```text
voice transcript -> RabiRoute route decision -> role dialogue -> visible reply and/or TTS reply
```

RabiRoute is the message and event routing layer. It receives QQ/NapCat events, FenneNote webhook events, voice transcript events, scheduler events, and local tool events, then hands normalized events to Codex or another Agent runtime. It does not replace FenneNote, OumuQ, NapCat, or the downstream role-playing Agent.

## Public Safety First

Never commit or paste:

- private chat logs, audio transcripts, recordings, role-private memory, or user profiles
- real QQ numbers, group IDs, sender IDs, webhook secrets, NapCat admin URLs, cookies, tokens, API keys, or personal absolute paths
- real `data/`, `logs/`, `tmp/`, `recordings/`, `transcripts/`, or `voice-cache/` runtime contents

Use placeholders such as `<placeholder-user-id>`, `<webhook-secret>`, `<gateway-id>`, `/path/to/project`, and `C:/Path/To/Project`.

Before staging changes, check `git status --short` and stage only files owned by the current task.

## Core Boundary

Keep the layers separate:

```text
FenneNote
  -> transcript webhook
  -> RabiRoute normalize / store / route
  -> Codex or Agent runtime
  -> role-faithful visibleText / ttsText
  -> OumuQ TTS or QQ/NapCat action draft
```

FenneNote owns speech-to-text. RabiRoute owns route policy and safe handoff. The Agent owns reasoning, role play, and response text. OumuQ owns speech generation. QQ/NapCat owns chat delivery.

## Event Contract

Voice transcript events should be structured. Minimum fields:

```json
{
  "platform": "fenne-note",
  "eventType": "voice_transcript",
  "eventId": "<stable-event-id>",
  "createdAt": "2026-06-05T10:00:00+08:00",
  "source": {
    "channel": "codex",
    "chatType": "local",
    "chatId": "<placeholder-chat-id>",
    "senderId": "<placeholder-user-id>",
    "senderName": "<display-name>"
  },
  "transcript": {
    "text": "<recognized text>",
    "language": "zh-CN",
    "confidence": 0.92
  },
  "actionInstruction": {
    "replySurface": "codex",
    "allowExternalSend": false,
    "allowTts": true
  }
}
```

`actionInstruction.replySurface` controls where the answer belongs:

- `codex`: answer in the current Codex or Agent conversation.
- `qq`: produce a QQ/NapCat draft; send only after explicit approval unless the local policy says otherwise.
- `tts`: produce speech-ready text for OumuQ; do not infer QQ delivery from TTS.
- `none`: record or route internally without a user-facing reply.

For Codex/FenneNote voice input, always follow the event action instruction. Do not confuse a Codex voice reply with a QQ/NapCat reply.

## Route Design

Use or add the role message rule route kind `voice_transcript` in `data/roles/<role>/roleMessageConfig.json`. A good route template includes:

- route kind and event time
- transcript text
- source channel and source type
- reply surface
- external-send permission
- TTS permission
- role path or role id
- required recent logs or cache paths

The downstream prompt must tell the Agent to read the reply surface before acting. RabiRoute should start a fixed thread when idle and steer the active turn when the target thread is already running.

## Role Dialogue Rules

The visible text and the TTS text must both preserve the character voice.

Do not write a neutral assistant response for display and only make the audio sound like the character. When translating or answering across languages, preserve the character identity, tone, relationship, and speaking habits first; then adapt wording for the target language.

Preferred Agent output:

```json
{
  "visibleText": "<role-faithful reply>",
  "ttsText": "<role-faithful speech text>",
  "replySurface": "codex",
  "ttsProvider": "oumuq",
  "requiresApproval": false,
  "notes": "<internal routing notes>"
}
```

Never send `notes` to external chat.

## Action Safety

Default allow:

- recording raw and normalized events
- recording route decisions
- starting or steering an internal Agent thread
- generating a visible reply draft
- generating a TTS draft when `allowTts` is true

Default require approval:

- QQ/NapCat group or private sends
- writing external documents, issues, sheets, databases, or tickets
- changing private role memory or production gateway config
- replaying or uploading recordings/transcripts

If a route asks for QQ/NapCat delivery but `allowExternalSend` is false, create a draft and report that approval is required.

## Delivery Checklist

When finishing a public workflow or skill:

- Confirm the repository only contains public-safe docs, examples, or code.
- Confirm `.gitignore` excludes runtime audio, transcript, log, temp, and private config directories.
- Confirm route examples use placeholders and no real account identifiers.
- Confirm Codex/FenneNote voice input clearly distinguishes Codex reply from QQ/NapCat reply.
- Confirm role dialogue instructions preserve character voice in visible text and cross-language output.
- Confirm OumuQ receives only approved `ttsText`.
- Run available validation such as `npm run build` for code-touching changes, or at least inspect markdown links for doc-only changes.
