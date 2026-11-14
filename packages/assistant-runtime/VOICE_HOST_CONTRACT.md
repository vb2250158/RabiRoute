# Voice host contract 0.10.3

Development SDK; injected-host tests are not physical audio acceptance.

## Three owners

1. Assistant: `createAssistantSession` owns the selected model, persona/global prompt, tool schema/policy, serial reasoning and tool receipts. Products own durable input drafts and target binding. Input must not change a running tool's identity or replay uncertain work.
2. Voice: `createVoiceInteraction` owns ASR restart, input priority, interrupting TTS, streamed sentence splitting and sequential playback. Use this identical module in glasses, web, DSH and Rabi. `createAiuiAssistantRuntime` is the historical name for the injected resource owner; no Rokid service is required.
3. Connectivity: adapters implement tool discovery/execution with original authorization and receipts. Remote transport is a later task, outside the voice module.

## Host integration

```js
import { createAiuiAssistantRuntime } from '@rabilink/assistant-runtime/aiui';
import { createVoiceInteraction } from '@rabilink/assistant-runtime/voice';
const resources = createAiuiAssistantRuntime({ asr, tts });
const voice = createVoiceInteraction({
  runtime: resources,
  onInput: input => assistant.accept(input),
  onEvent: event => gui.render(event),
  onError: error => gui.showError(error),
});
// Invoke from a genuine button/wake action; respect microphone permission.
voice.activate({ continuous: true, interimResults: true });
const response = voice.beginResponse({ id: replyId, speech: selectedVoiceOptions });
// Model onText: response.append(delta). Model finished: response.finish().
const detachPet = voice.subscribe(event => pet.render(event));
// Closing one optional view calls detachPet, not voice.dispose.
// Hidden foreground with continuing work: mute output, pause capture, keep text subscription.
voice.setOutputEnabled(false);
voice.pauseListening();
// Visible again, if the user's output preference permits: enable NEW responses only.
voice.setOutputEnabled(true); // Does not start ASR or replay old responses.
// Actual owner close: voice.dispose(); resources.dispose().
```

`assistant.accept` is a product-owned admission function, not an SDK method. Retain input before asynchronous execution and handle busy sessions through session guidance/interjection. `submitText` returning true means callback delivery only, never persistence, backend acceptance, execution or completion.

ASR onset or accepted interim/final input stops existing audio and its queued tail. Old model/tool work is never cancelled; its response token continues emitting text with `suppressed:true`. A new response token can speak again. Events carry response IDs and `foreground`; old reply events must not replace new foreground text. `suspend` retires voice output tokens; activation does not replay them. One runtime rejects a second voice owner.

## Foreground lifecycle and output permission

| Host action | Shared operation | Preserved |
| --- | --- | --- |
| Interrupt the current spoken reply | `interruptSpeech()` | ASR, text, model/tool work; later replies may speak |
| Persistent mute | `setOutputEnabled(false)` | ASR, existing/new text tokens, model/tool work |
| Hide with work continuing | Mute output, then `pauseListening()` | Text projection, native Session and durable work |
| Show without microphone consent | `setOutputEnabled(userOutputPreference)` | No ASR start, no replay of any muted token |
| Explicit microphone action | `activate()` | Does not override output permission |
| Hard voice deactivation | `suspend()` | Native work, but response tokens are retired and cannot project further text |
| End the voice owner | `dispose()` | Model/session cleanup remains the assistant owner's responsibility |

`outputEnabled` is an optional boolean constructor setting (default true), also exposed in `getState()`. `setOutputEnabled(false)` fences output before cancelling active/queued/pending audio. Every response created while muted remains suppressed for its whole lifetime, including after re-enabling. Text still appends/finishes normally. Opening a view never calls `activate()` implicitly and must not override a user's explicit mute. An output-only change never stops ASR or invokes model/tool cancellation.

For hosts retaining background text, `isActive` describes the assistant/voice owner's validity, not view visibility. Keep authorization, binding identity and disposal guards; do not reuse a visibility flag to invalidate already accepted model work. Hiding must not start new mailbox work or widen tool permissions. A view may detach rendering, but a retained owner continues consuming durable native events so it can rebuild the view later. SDK response events are not durable storage or presentation acknowledgements.

On SDKs without `setOutputEnabled`, do not emulate persistent mute with `interruptSpeech` alone: a later response can restart audio. Require the capability or remain unavailable for that integration until its verified dependency is loaded.

ASR implements `createRound/start/stop` and onset/interim/final/end/error callbacks. Silence alone does not complete input. TTS returns the documented task/player pair; playback finishes on actual player ended, not synthesis completion. Browser/Electron hosts cannot assume AIUI `LanguageModel` exists. Label fixture, browser and Rokid behavior separately.

DSH supplies an independent GUI and desktop adapters. Its pet is an optional subscriber, never a second microphone/model/loop. Rabi similarly owns one assistant with pet and GUI views. Page close, stop-speaking and explicit task cancellation are separate operations. Configure providers in the host/assistant layer; never embed keys in SDK/frontend bundles.

## Acceptance

Run package tests unchanged in consumers. Cover streaming, barge-in, late text, final after speechend, recognition restart, bounded errors, hidden/disposed callbacks, pet attach/detach and pending work. Then verify actual permissions, microphone, echo and playback; fixtures do not establish hardware full duplex.

On failed, cancelled or superseded assistant turns, call response.finish({ speak: false }) in the owner's finally block. This releases the reply token without speaking its tail or cancelling newer output. An already finished reply keeps its queued audio.
