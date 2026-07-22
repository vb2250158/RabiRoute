---
name: character-tts-dialogue
description: Write, return, validate, or troubleshoot character-faithful spoken replies for RabiRoute's current RabiSpeech workflow. Use when an AgentPacket contains characterTtsDialogue=true, when a delivered speech/voice_transcript turn must reach the host playback FIFO, or when checking visible/spoken wording, replyContext, persona voice, local or explicitly enabled API TTS, 24-hour cache records, and safe non-QQ speech boundaries. Do not use retired OumuQ/FenneNote paths.
---

# Character TTS Dialogue

## Current flow

```text
RabiPC speech endpoint -> voice_transcript -> AgentPacket
  -> character-faithful reply text
  -> POST /api/agent/replies with the complete replyContext
  -> Outbox freezes Route persona, voice, model, language, instructions, sessionId
  -> RabiSpeech host-wide FIFO
```

RabiRoute owns source binding and playback policy. RabiSpeech owns synthesis and playback. The Agent owns what the character says.

Speech ingress has its own record-before-wake policy. Route `speechPushMode=hot` delivers every completed non-empty ASR segment. `keyword` records every segment but creates an Agent turn only when the text matches persona-owned `speechTriggerKeywords`; an empty keyword list stays record-only. A `recorded` result therefore has no character reply to return.

## Decide whether to speak

Speak automatically only when the injected `replyContext` includes all of:

- `routeKind: "voice_transcript"`
- `adapterType: "speech"`
- `characterTtsDialogue: true`

Do not add this state to QQ, the role panel, ordinary text, or unrelated voice transcripts. Direct TTS explicitly requested by the user is a separate speech-service action; use `rabiroute-voice-workstation` for that workflow.

## Write the reply

- Preserve the active persona's relationship stance, vocabulary, rhythm, honorifics, and emotional posture.
- Keep factual accuracy, safety boundaries, refusals, and uncertainty intact while speaking in character.
- Make the spoken line short, natural, and easy to understand without screen-only context.
- Keep the visible final reply and spoken text semantically identical. Normally use the same sentence for both.
- Avoid markdown tables, URLs, code blocks, citation syntax, long lists, and stage directions in the spoken text.
- Treat user corrections about tone, names, catchphrases, or pronunciation as active guidance.

## Return through Outbox

POST the spoken text and the complete injected context to the Manager URL supplied by `replyApiUrl`, normally:

```http
POST http://127.0.0.1:8790/api/agent/replies
Content-Type: application/json; charset=utf-8
```

```json
{
  "text": "好呀，我听见了。我们慢慢来。",
  "replyContext": { "...": "copy the complete injected object unchanged" }
}
```

Do not rebuild a partial context, invent a target, or call a worker directly. Submit once. A `sent` result with autoplay means the audio entered the host FIFO; it does not prove speaker playback has finished.

Interpret other results explicitly:

- `draft`: retained without automatic external action.
- `blocked`: policy, source binding, or payload validation rejected it.
- `failed`: synthesis, queueing, transport, or runtime failed; preserve the visible reply and report the failure.

## Models and voices

Never hardcode a model table as runtime truth. Discover installed models and request schemas from:

- Manager: `GET /api/speech/models`, `GET /api/speech/personas`
- RabiSpeech: `GET /v1/models`, `GET /v1/models/<provider>/<model>`

Availability is machine-specific. Persona `voice/voice-profile.json` is the single source of truth for model, voice, language, speed, and speaking instructions. The selected Provider may be local or an explicitly enabled HTTPS API Provider. Provider secrets and cloned voice IDs must come from the named environment variables referenced by that persona; never copy their values into prompts, logs, public examples, or replies. Do not silently fall back from one Provider to another.

Persona voice material lives under `data/roles/<RoleId>/voice/`. Successful persona TTS retains finalized audio under `voice/cache/tts-audio/` for 24 hours from that file's own timestamp; non-persona direct TTS uses a private fallback. Diagnostic UI may show only the safe persona-relative cache reference and expected expiry, never an absolute path, traversal, reference audio, weights, tokens, or private persona data. Cache retention is not proof that playback completed.

ASR and TTS with the same `sessionId` share the persona's `speech` recent-context budget. The canonical persona ledger records both inbound and outbound messages; injection limits affect only how many recent rows are shown to the Agent, not whether the rows are retained.

## Speaker labeling from an Agent

If the ASR payload exposes a diarization label and the current conversation gives the Agent enough evidence to identify the person, use the Manager's loopback metadata interface:

```http
PUT /api/speech/speaker-identities
```

Send `sessionId`, `speakerLabel`, and either a known `speakerId` or a `displayName` plus optional aliases. The operation idempotently finds or creates one host-wide person profile, merges aliases, and binds that session label in one registry transaction. Several matching profiles return `409`; retry only after selecting an explicit profile ID.

The WebGUI keeps the corresponding human entry under **Speech Service → ASR → Speaker / voiceprint settings**, with separate unknown/known collapsible cards and the latest ten utterances for each diarization cluster. Both paths share the same registry. This is explicit person metadata, not biometric recognition: `voiceprint.supported=false` remains authoritative until a validated embedding matcher exists.

## Hard boundaries

- Do not use retired OumuQ or FenneNote runtime paths, fixed worker ports, or an unconfigured Provider. DashScope or another API Provider is allowed only when the persona and RabiSpeech configuration explicitly enable it through named environment variables and HTTPS.
- Do not call `/v1/audio/speech` during an Agent-routed dialogue turn; Outbox must freeze Route settings and enqueue exactly once.
- Do not read or forward the resolved Provider voice ID. Outbox/RabiSpeech resolves it from persona configuration at execution time.
- Do not automatically send QQ voice. QQ/NapCat output remains governed by its own Route policy and Action Gate.
- Do not claim playback completion from queue acceptance.

## Troubleshooting

1. Confirm the packet contains the three speech-state fields above and a complete `replyContext`.
2. Check `GET /api/speech/status`, then model and persona discovery.
3. Check the `/api/agent/replies` result before inspecting workers.
4. Check the host FIFO and playback error state; avoid retrying blindly because the first request may already be queued.
5. If Windows emits only an error chime while the FIFO says `done`, inspect the cached WAV with SoundFile. Streamed WAV headers can advertise a placeholder length that `winsound` misreads; RabiSpeech playback must stay on SoundFile / PortAudio.
6. Check `/api/speech/records` with the same `sessionId` to distinguish synthesis, cache retention, queue acceptance, and actual playback state.
7. If tone is wrong, reread the active `persona.md` and `voice/voice-profile.json`. If routing is wrong, inspect Route `speechPushMode` and persona keywords rather than changing character prose.
