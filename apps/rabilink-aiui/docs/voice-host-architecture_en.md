English | [简体中文](voice-host-architecture.md)

# Assistant and voice host boundaries

The shared implementation is `packages/assistant-runtime`; see its `VOICE_HOST_CONTRACT.md`.

| Layer | Responsibility | Implementation |
| --- | --- | --- |
| Assistant | Global prompt, persona, reasoning, tools, bound target and original receipts | `assistant-session.js` or native host Agent/Session; original-owner durable input/history |
| Voice interaction | Capture restart, input priority, TTS interruption, sentence splitting, serial playback, stale callback isolation | `voice-interaction.js` with injected ASR/TTS resources |
| Tool connectivity | Discovery, calls, authentication, transport, durable idempotency and reconciliation | Product adapters; new remote connectivity comes last |

The glasses page creates one owner through `ensureVoiceInteraction()` and streams reply deltas through `beginVoiceResponse()`. The web simulator runs that same compiled page and shared loop. DSH may inject its logged native Session as the assistant layer; do not wrap a second tool execution loop around a Session that already executes tools. Its GUI and optional pet subscribe to one voice owner. Rabi's pet must likewise remain a view, not another microphone/model.

Onset stops current and queued audio, while old response text and dispatched work continue. The assistant layer retains new input and chooses guidance, interjection or a later turn. Voice admission is not a durable execution receipt. Capture pause, page close, speech interruption and task cancellation remain separate actions.

VAD onset/end describe actual speaking; a segmented ASR final does not prove silence. Text simulation ends simulated onset before injecting a completed utterance; real microphone VAD owns its end event. Synthesis completion is not playback completion. Interruption explicitly stops the native player before destruction.

## Verification

SDK 0.10.2 passes 103 shared tests and strict TypeScript consumption; the compiled page passes 48 native contract tests. Ink 0.19.1 web regression covers successive replies, onset interruption, preserved model/capture, subsequent replies and reopening. Its input/audio are synthetic; microphone, AEC and glasses speakers remain separate acceptance.

Rabi now has the independent `io.rabiroute.manager.voice-assistant` plugin. Its `/voice-assistant` page and pet menu share one entry. The native persona Agent owns work, browser PCM/manual ASR adapts input, and RabiSpeech remains the sole playback FIFO. Replies match authoritative input ID, persona and Route; each TTS segment has an immutable cancellation scope. Leaving the page releases voice without cancelling native work. Microphone and assistant-task states are distinct, including permission timeout and retry.

The Rabi candidate passes complete frontend/backend type checks, the WebGUI build, 17 adapter regressions, 24 speech/message API regressions and the real outbox timeline-correlation test. The built-in browser fixture completed two inputs, cancelling only the second output while retaining text. Pet Python files pass syntax parsing; actual Qt, microphone, model/tools and installed runtime remain unaccepted.

The DSH maintenance chat reports its independent GUI candidate builds and passes 19 tests. Private Git hosting authorization, isolated installation and real voice acceptance remain pending. SDK/component tests do not establish desktop product delivery. New remote connectivity remains last.
