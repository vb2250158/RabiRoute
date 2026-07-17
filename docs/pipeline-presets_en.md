<!-- docs-language-switch -->
<div align="center">
English | <a href="./pipeline-presets.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Pipeline Presets

> Status: Agent/Outbox sections are current. FenneNote/OumuQ were retired on 2026-07-17; FenneNote endpoints below document legacy configuration compatibility only. New speech flows use RabiSpeech and the `speech` message endpoint.

A pipeline describes where an event enters, where handler output is allowed to leave, and how reply instructions are rendered. A preset supplies a coherent default while an inline `pipeline` object can override individual fields.

```json
{
  "pipelinePreset": "agent_session",
  "pipeline": {
    "inputAdapter": "napcat",
    "outputAdapter": "agent",
    "outputPipeline": "agent",
    "promptOutputMode": "markdown",
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

Important fields:

- `inputAdapter`: the message source.
- `outputAdapter`: `agent`, `qq`, `wecom`, `fennenote`, `rabilink`, or another supported endpoint.
- `outputPipeline`: a stable delivery label used in reply context and logs.
- `promptOutputMode`: how the handler should format its response.
- `preventFeedbackLoop`: preserve source/self checks.
- `replyToSource`: request a source-bound reply when the adapter supports it.
- `ttsProvider`, `ttsVoice`, `ttsWorkerUrl`, `ttsPlay`: optional voice-output settings.

## Built-in presets

Current presets include the Agent-session default and endpoint-oriented presets such as QQ, WeCom, and FenneNote. Use the preset list exposed by the current configuration model/WebGUI rather than copying historical names from old documents.

The compatibility default is `agent_session`: if the handler calls `/api/agent/replies` without a source reply or explicit external target, Outbox returns `sent` and records that the text was retained in the Agent session. It does not silently publish to QQ.

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

An explicit QQ/WeCom/RabiLink target can select the corresponding endpoint even when the compatibility pipeline is still `agent_session`, but the adapter policy must allow output and the target must be unambiguous.

There is no generic persistent Action Queue, WebGUI approval center, or automatic retry queue. `draft` is a result/audit state, not a pending item in a finished approval product.

## FenneNote endpoints

FenneNote output can use the configured reply/playback bridge. The pipeline decides whether a voice-transcript response remains in the Agent session or is posted to FenneNote. Message-adapter policy and payload support are checked before delivery.

See [Voice Interaction Workstation](voice-interaction-workstation_en.md) for the experimental end-to-end boundary.
