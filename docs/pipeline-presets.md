# Pipeline presets

Pipeline presets are a small configuration layer for pairing a default input adapter with an expected output surface. They do not replace route rules or Agent adapters. A route still receives messages through `messageAdapters`, normalizes them into RabiRoute records, renders a notification template, and delivers that template to the configured Agent adapter.

The preset only adds routing intent that templates and future output adapters can read:

```json
{
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "inputAdapter": "webhook",
    "outputAdapter": "fennenote",
    "outputPipeline": "fennenote",
    "promptOutputMode": "voice_short",
    "ttsProvider": "oumuq",
    "ttsVoice": "cloud_zh_voice",
    "ttsWorkerUrl": "http://127.0.0.1:8793/api/fennenote/playback",
    "ttsPlay": true,
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

## Built-in presets

- `qq_chat`: NapCat input, QQ output intent, `qq_text` prompt mode, reply to the source channel, feedback-loop protection enabled.
- `voice_chat`: Webhook/FenneNote input, FenneNote output endpoint, `voice_short` prompt mode, playback enabled, feedback-loop protection enabled, no automatic reply to the source input channel.
- `webhook_task`: Webhook input, file output intent, Markdown prompt mode.

Routes can override any field in `pipeline`. When no `pipelinePreset` is configured, RabiRoute uses the legacy behavior and only exposes neutral template variables.

## Template variables

Pipeline fields are available in notification templates:

```text
{pipelinePreset} {channelPreset}
{inputAdapter} {outputAdapter} {outputPipeline} {promptOutputMode}
{ttsProvider} {ttsVoice} {ttsWorkerUrl} {ttsPlay}
{preventFeedbackLoop} {replyToSource}
```

Use them to make the Agent produce output in the correct shape:

- `promptOutputMode=voice_short`: short spoken sentences, conversational wording, avoid long lists.
- `promptOutputMode=qq_text`: readable chat text, line breaks are fine.
- `promptOutputMode=markdown`: Markdown suitable for file output.
- `promptOutputMode=json`: structured JSON or agreed fields for webhook consumers.

## FenneNote endpoint

RabiRoute does not synthesize audio. For `voice_chat`, Codex or another Agent produces a playback request object. RabiRoute forwards that object to FenneNote without interpreting voice fields such as text, language, emotion vector, model, or character id. FenneNote owns guard handling, speaker bookkeeping, and the final OumuQ/worker call.

RabiRoute manager exposes a FenneNote output endpoint with two surfaces:

```text
POST /api/fennenote/playback
POST /api/fennenote/reply
```

`/api/fennenote/playback` receives the same request object Codex wants FenneNote to handle, for example:

```json
{
  "text": "<speech text>",
  "play": true,
  "character_id": "tamamo_no_mae",
  "language": "auto",
  "emotion_vector": [0.2, 0.1, 0.0]
}
```

RabiRoute forwards this packet to FenneNote's local endpoint, usually `http://127.0.0.1:8793/api/fennenote/playback`. `/api/fennenote/reply` forwards a text reply packet to `http://127.0.0.1:8793/api/fennenote/reply`. Keep real voice IDs, API keys, private reference audio, and non-local URLs out of public route examples.

For low latency, Codex should keep sending the desired `model`, `character_id`, `language`, emotion fields, and optional `worker_url` in the same packet. RabiRoute does not switch models. FenneNote compares the requested playback target with its current active target, performs local guard bookkeeping, probes the requested worker when `worker_url` is present, and then forwards the original packet to OumuQ. A later OumuQ worker-management API can turn this into true pre-start/preload for heavier local models.
