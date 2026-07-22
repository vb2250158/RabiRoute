<!-- docs-language-switch -->
<div align="center">
English | <a href="./pipeline-presets.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Pipeline Presets

> Status: Agent/Outbox sections are current. FenneNote/OumuQ were retired on 2026-07-17. New speech flows use RabiSpeech and the `speech` message endpoint; old fields remain read-only migration compatibility.

A pipeline describes where an event enters, where handler output is allowed to leave, and how reply instructions are rendered. A preset supplies a coherent default while an inline `pipeline` object can override individual fields.

```json
{
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "inputAdapter": "speech",
    "outputAdapter": "tts",
    "outputPipeline": "rabispeech",
    "promptOutputMode": "voice_short",
    "ttsProvider": "local-tts",
    "ttsVoice": "Rabi",
    "ttsWorkerUrl": "http://127.0.0.1:8781/v1/audio/speech",
    "ttsPlay": true,
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

Important fields:

- `inputAdapter`: the message source.
- `outputAdapter`: `agent`, `qq`, `wecom`, `tts`, `file`, `console`, `webhook`, `fennenote`, or `none`.
- `outputPipeline`: a stable delivery label used in reply context and logs.
- `promptOutputMode`: how the handler should format its response.
- `preventFeedbackLoop`: preserve source/self checks.
- `replyToSource`: request a source-bound reply when the adapter supports it.
- `ttsProvider`, `ttsVoice`, `ttsWorkerUrl`, `ttsPlay`: optional voice-output settings.

## Built-in presets

The current built-ins are `qq_chat`, `wecom_chat`, `voice_chat`, and `webhook_task`. `voice_chat` means RabiSpeech `speech` ingress, local TTS output, `voice_short` prompting, host playback, and feedback-loop protection.

When no known preset is selected, the compatibility `legacy` fallback uses `outputAdapter=agent`, `outputPipeline=agent`, and `promptOutputMode=plain_text`. It keeps an ordinary reply in the Agent session instead of silently publishing it.

## Template values

Pipeline values available to route templates include:

```text
{pipelinePreset} {channelPreset}
{inputAdapter} {outputAdapter} {outputPipeline}
{promptOutputMode}
{ttsProvider} {ttsVoice} {ttsWorkerUrl} {ttsPlay}
{preventFeedbackLoop} {replyToSource}
{replyApiUrl} {replyContextJson}
```

RabiRoute also injects a generated reply-delivery section. Users normally do not need to encode all policy logic into the route template.

## Handler replies

Use:

```http
POST /api/agent/replies
```

with the injected `replyContext`. Outbox resolves the active route and pipeline and returns `sent`, `draft`, `blocked`, or `failed`.

An explicit QQ/WeCom/RabiLink target can select the corresponding endpoint even when the compatibility pipeline is still `legacy`, but the adapter policy must allow output and the target must be unambiguous.

There is no generic persistent Action Queue, WebGUI approval center, or automatic retry queue. `draft` is a result/audit state, not a pending item in a finished approval product.

## RabiSpeech speech message endpoint

A `voice_transcript` from the `speech` message endpoint is forced to `voice_chat` in `AgentPacket`, even if the Route's general preset is still QQ or the Agent-session fallback. Its reply context contains `characterTtsDialogue=true`; the handler must POST a short spoken line, semantically identical to its visible reply, to `/api/agent/replies` instead of leaving text only in the Codex task.

Outbox revalidates the source record and `messageAdapterPolicies.speech`, then sends the Route persona ID, playback policy, and original `sessionId` to local `POST /v1/audio/speech`. RabiSpeech reads the TTS model, voice binding, language, speed, and speaking instructions from `data/roles/<RoleId>/voice/voice-profile.json`; legacy Route TTS fields are compatibility fallbacks only when persona configuration is missing. With `speechAutoPlay=true`, the completed audio enters the host-wide FIFO. A successful API result means accepted or queued, not that speaker playback has already completed.

FenneNote/OumuQ output fields and `/api/fennenote/*` remain migration compatibility only. They are not the implementation path for a new speech Route and must not reintroduce cloud TTS.
