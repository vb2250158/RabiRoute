English | [简体中文](speech-message-endpoint-design.md)

# Speech Message Endpoint Consolidation Design

> Status: selected and being implemented. RabiRoute / RabiPC replaces the local speech capabilities of OumuQ and FenneNote; paid cloud TTS and ASR are out of scope.

## Constraints

- RabiSpeech remains a directly callable local API. It does not own an Agent or conversation context.
- The speech message endpoint is an optional RabiPC Route input for recording, ASR, delivery, TTS replies, and compact configuration.
- RabiPC can still synthesize and play a persona voice by persona name when no Route enables the endpoint.
- The persona owns voice identity. References, dialogue indexes, emotion metadata, and rebuildable caches live under `data/roles/<RoleId>/voice/`.
- Every request explicitly carries persona, model, Route, and session identity. There is no process-global current character.
- All Routes and direct callers share one host FIFO playback queue. Model work may be scheduled separately, but speaker playback never overlaps.

## Options

### A. Put all speech behavior in Manager

This centralizes entry points but couples the TypeScript control plane to Python model lifecycles and makes the direct API depend on Agent/Route runtime state.

### B. RabiSpeech domain plus optional RabiPC endpoint (selected)

RabiSpeech directly owns local providers, workers, persona voice resolution, and the host playback queue. Manager owns safe proxying, Route delivery, and WebGUI configuration. Direct API and endpoint mode reuse one registry and queue.

### C. Keep proxying OumuQ and FenneNote

This minimizes edits but retains two retired projects, three frontends, and duplicated configuration, so it cannot become the new source of truth.

## Selected boundary

```text
RabiSpeech-resident PC microphone / local file / any HTTP client
  -> optional top-level RabiPC TTS/ASR control or direct RabiSpeech API
  -> RabiSpeech local model registry
  -> ASR worker / TTS worker
  -> data/roles/<RoleId>/voice/
  -> optional host FIFO playback queue
  -> Route / Agent (endpoint mode only)
```

The microphone belongs to the RabiSpeech service lifecycle, so closing RabiPC does not stop it. The ASR tab configures device selection, separate record/transcribe thresholds, adaptive noise, pre-roll, silence segmentation, model, session, and optional Route delivery. The TTS tab owns persona/model/style selection and FIFO playback. Microphone start/stop is loopback-only and is not exposed through the ordinary RabiLink token.

`voice` is a persona ID. RabiSpeech never guesses a persona from text. Advanced direct calls may provide an explicit reference. Concurrent sessions may use different personas because each queued job freezes its complete voice snapshot.

## Persona voice directory

```text
data/roles/<RoleId>/voice/
  voice-profile.json
  voice-index.json
  dialogue-examples.jsonl
  audio/
  cache/reference-audio/
  reports/
```

Wiki extraction retains character facts, voice/emotion-relevant traits, dialogue examples, and a stable dialogue index. It must not overwrite Rabi persona principles, memory, plans, or action boundaries.

## Extension boundary

The provider registration interface remains, but default configuration, installers, documentation, and tests list local models only. A future provider must be explicitly installed and registered by the local administrator; remote requests cannot download models or load code.
