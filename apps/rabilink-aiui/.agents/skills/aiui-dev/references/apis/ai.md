# AIUI AI and Speech API Reference

This file documents the verified AI and speech-related APIs available to AIUI agent code.

- Common scope, entry points, and authoring rules live in [apis.md](./index.md).
- Treat these definitions as implementation truth rather than as browser-platform guarantees.
- Do not assume richer provider metadata, structured tool-call round trips, or broader Web Speech coverage unless it is explicitly listed here.

## `LanguageModel`

### Module export

- `import { LanguageModel } from 'language-model'`

### Methods

- `LanguageModel.availability()`
- `LanguageModel.create(options?)`

### Return behavior

- `availability()` returns a `Promise<'available' | 'unavailable'>`.
- `create(options?)` returns a `Promise<LanguageModelSession>`.

### Create options

- `model?: string`
- `initialPrompts?: LanguageModelMessage[]`
- `tools?: LanguageModelTool[]`

### Message shapes

```ts
type LanguageModelMessage =
  | {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }
  | {
      role: 'user';
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
    };

type LanguageModelTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: object;
  };
};
```

### Behavior notes

- `LanguageModel` is a singleton capability surface and is not constructible.
- `availability()` only reports whether the host can provide a language-model config.
- `availability()` does not expose provider metadata, model lists, or endpoint details.
- `create()` resolves the session model in this order: explicit `options.model`, then host `defaultModel`.
- `initialPrompts` defaults to `[]`.
- `tools` defaults to `[]`.
- Supported `initialPrompts` roles are `system`, `user`, and `assistant`.
- `system` is only allowed as the first message in `initialPrompts`.
- Structured `content` arrays are only supported for `user` messages.
- Structured `content` currently supports `text` parts and `image_url` parts.
- Each tool must use `type: 'function'`.
- `function.name` must be a non-empty string.
- `function.parameters` must be a JSON object.
- Declared tools are forwarded into the provider request body.
- Tool calls are surfaced as session `toolcall` events rather than automatic JavaScript tool execution.
- The current request payload shape is aligned with the host's OpenAI-compatible chat-completions streaming path.

### Error behavior

- `create(options?)` throws when `options` cannot be parsed as the expected object shape.
- `create(options?)` throws when `model` is present but is not a non-empty string.
- `create(options?)` throws when any message role is invalid.
- `create(options?)` throws when `system` appears outside the first `initialPrompts` item.
- `create(options?)` throws when string `content` is empty.
- `create(options?)` throws when structured `content` is empty or used on a non-`user` message.
- `create(options?)` throws when a `text` part is empty.
- `create(options?)` throws when an `image_url.url` value is empty.
- `create(options?)` throws when a tool is not `type: 'function'`.
- `create(options?)` throws when `function.name` is empty or `function.parameters` is not an object.
- `create(options?)` rejects when neither an explicit `model` nor a host `defaultModel` is available.
- `create(options?)` can reject when the host fails to provide the runtime config.

### Example

```js
import { LanguageModel } from 'language-model';

if ((await LanguageModel.availability()) !== 'available') {
  throw new Error('LanguageModel is unavailable');
}

const session = await LanguageModel.create({
  initialPrompts: [
    {
      role: 'system',
      content: 'You are a concise travel assistant.',
    },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Look up current weather by city name',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
    },
  ],
});
```

## `LanguageModelSession`

### Constructor

`LanguageModelSession` cannot be constructed directly.

### Methods

- `prompt(input)`
- `promptStreaming(input)`
- `clone()`
- `destroy()`
- `addEventListener(type, listener, options?)`
- `removeEventListener(type, listener?)`

### Prompt input

- `string`
- `LanguageModelMessage[]`

### Prompt-time message rules

- A string input is normalized to one `{ role: 'user', content: string }` message.
- Prompt-time array input only allows `user` and `assistant` roles.
- Prompt-time array input does not allow `system`.
- Structured `content` arrays are only supported on `user` messages.

### Return behavior

- `prompt(input)` returns a `Promise<string>`.
- `promptStreaming(input)` returns a `LanguageModelTextStream`.
- `clone()` returns a `LanguageModelSession`.
- `destroy()` returns `void`.

### Event behavior

- `LanguageModelSession` inherits from `EventTarget`.
- When the provider emits tool calls, the session dispatches `toolcall` events after the request completes.
- Each `toolcall` event exposes:
  - `callId: string | null`
  - `index: number`
  - `toolType: string`
  - `functionName: string`
  - `arguments: any`
  - `isComplete: true`
- If tool-call arguments are valid JSON, `arguments` is the parsed value.
- If tool-call arguments are not valid JSON, `arguments` is the raw string.
- If the provider emitted an empty arguments payload, `arguments` is `null`.

### Behavior notes

- A session keeps its own message history.
- Input messages are appended to session history before the network request starts.
- The final assistant text is appended to history only after the request completes successfully.
- `prompt(input)` uses the same streaming transport internally, but resolves once with the final aggregated assistant text.
- `promptStreaming(input)` returns a polling wrapper, not a WHATWG stream and not an async iterator.
- Only one active request is allowed per session at a time.
- `clone()` copies the current message history, resolved runtime config, selected model, and tool declarations into a new independent session.
- The cloned session starts without any active request.
- `destroy()` invalidates the session for future use and closes any active request task.

### Error behavior

- `prompt(input)` throws when the input is not a string or message array.
- `prompt(input)` throws when any prompt-time role is invalid.
- `prompt(input)` throws when `system` appears in per-request input.
- `prompt(input)` throws when message content fails validation.
- `prompt(input)` throws if the session has been destroyed.
- `prompt(input)` throws if another request is already active on the same session.
- `prompt(input)` rejects if the started request later fails during streaming.
- `promptStreaming(input)` throws on the same validation and lifecycle failures as `prompt(input)`.
- `clone()` throws if the source session has already been destroyed.

### Examples

```js
const answer = await session.prompt('Plan a 2-day trip in Kyoto.');
console.log(answer);
```

```js
const multimodalAnswer = await session.prompt([
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image in one sentence.' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...',
        },
      },
    ],
  },
]);
```

```js
session.addEventListener('toolcall', (event) => {
  console.log(event.functionName, event.arguments);
});

await session.prompt('What is the weather in Shanghai today?');
```

## `LanguageModelTextStream`

### Constructor

`LanguageModelTextStream` cannot be constructed directly.

### Methods

- `read()`
- `cancel()`

### Return behavior

- `read()` returns a `Promise<{ done: boolean; value?: string }>`
- `cancel()` returns `void`

### Behavior notes

- `LanguageModelTextStream` is not a WHATWG `ReadableStream`.
- `read()` is polling-based.
- If buffered text exists, `read()` resolves to `{ done: false, value }`.
- If the stream is still open but no chunk has arrived yet, `read()` resolves to `{ done: false, value: undefined }`.
- If the stream has finished, `read()` resolves to `{ done: true, value: undefined }`.
- `cancel()` closes the underlying SSE task and marks the stream as closed.
- When streaming finishes successfully, the final assistant text is committed to the parent session history.

### Error behavior

- If the stream fails, `read()` rejects with an error.

### Example

```js
const stream = session.promptStreaming('Write a short poem about rain.');

while (true) {
  const { done, value } = await stream.read();
  if (done) break;
  if (value !== undefined) {
    console.log(value);
  }
}
```

## `speechSynthesis`

### Methods

- `speechSynthesis.speak(utterance, mode?)`
- `speechSynthesis.synthesize(utterance, options?)`

### Behavior notes

- `speak()` and `synthesize()` are independent workflows. Do not call both to complete one playback operation.
- `speak()` generates and plays speech directly, returns `void`, and uses one runtime-managed speech player shared by all `speak()` calls.
- `speak()` accepts `mode: 'enqueue' | 'immediate'`; omission defaults to `'enqueue'`.
- `synthesize()` starts generation and returns `Promise<SpeechSynthesisTask>`, but does not play the generated audio automatically.
- Tasks created by `synthesize()` do not enter the shared `speak()` playback queue.
- For playback after `synthesize()`, construct an independent `SpeechAudioPlayer` for the returned task.
- Prefer `speak()` for ordinary prompts and replies that only need direct playback.
- Prefer `synthesize()` for subtitle cues, audio chunks, cancellation, custom playback UI, or independent playback controls.
- `cancel()`, `pause()`, `resume()`, `getVoices()`, and utterance lifecycle events are not exposed.

### Synthesis options

- `subtitles?: 'none' | 'sentence' | 'word'`
- `audio.preferredFormat?: 'pcm' | 'mp3' | 'ogg_opus'`
- `audio.sampleRate?: number`
- `audio.channels?: 1 | 2`
- `audio.bitrate?: number`
- `signal?: AbortSignal`

### Examples

Direct playback through the shared player:

```js
const utterance = new SpeechSynthesisUtterance('Hello Ink');
speechSynthesis.speak(utterance, 'enqueue');
```

Independent generation and playback:

```js
const utterance = new SpeechSynthesisUtterance('Hello Ink');
const task = await speechSynthesis.synthesize(utterance, {
  subtitles: 'word',
});
const player = new SpeechAudioPlayer(task);
player.play();
```

## `SpeechSynthesisUtterance`

### Constructor

- `new SpeechSynthesisUtterance(text?)`

### Properties

- `text`
- `lang`
- `voice`
- `volume`
- `pitch`
- `rate`

### Behavior notes

- The default initial state is `text = ''`.
- The default initial state is `lang = 'en-US'`.
- The default initial state is `voice = null`.
- `lang` is not currently supported and does not change the generated language.
- `pitch`, `rate`, and `volume` default to `1`. Fractional volume values survive assignment; audible volume and pitch/rate adjustments depend on the speech service.

### Supported voice IDs

- `female-tianmei`
- `English_radiant_girl`
- `English_expressive_narrator`
- `male-qn-qingse`
- `male-qn-jingying`
- `female-yujie`
- `Chinese (Mandarin)_News_Anchor`
- `Chinese (Mandarin)_Radio_Host`
- `clever_boy`
- `lovely_girl`
- `English_Trustworthy_Man`

## `SpeechSynthesisTask`

### Members

- `id: string`
- `state: 'running' | 'completed' | 'aborted' | 'errored'`
- `audioConfig: SpeechSynthesisAudioConfig`
- `language: string`
- `granularity: 'none' | 'sentence' | 'word'`
- `finished: Promise<{ duration: number }>`

### Methods

- `abort()`

### Events

- Event names: `chunk`, `end`, `error`, and `abort`.
- Handler properties: `onchunk`, `onend`, `onerror`, and `onabort`.
- A `chunk` event exposes `audio: Uint8Array` and `cues: readonly SpeechSynthesisCue[]`.

## `SpeechAudioPlayer`

### Constructor

- `new SpeechAudioPlayer(task, options?)`
- `options.trackMode?: 'hidden' | 'showing'`

### Members

- `audioPlayer`
- `textTrack`
- `activeCue`
- `currentTime`
- `duration`
- `paused`

### Methods

- `play()`
- `pause()`
- `stop()`
- `seek(position)`
- `destroy()`

### Behavior notes

- Each instance consumes one `SpeechSynthesisTask` created by `synthesize()`.
- It neither represents nor controls the runtime-managed player shared by `speak()` calls.
- Generated `textTrack` cues preserve object identity for edits and removal; see [media text tracks](./media.md#text-tracks-and-subtitle-cues).

## `SpeechRecognition`

Speech recognition no longer requires a separate `SPEECH_RECOGNITION`
permission. Capturing microphone audio still requires declaring `RECORD_AUDIO`
and obtaining platform authorization. External-audio sessions do not open the
microphone themselves.

### Constructor

- `new SpeechRecognition()`

### Properties

- `lang`
- `continuous`
- `interimResults`
- `maxAlternatives`

### Methods

- `start()`
- `stop()`
- `abort()`

### Event behavior

- `SpeechRecognition` inherits from `EventTarget`.
- Supported event names are `start`, `audiostart`, `soundstart`, `speechstart`, `result`, `nomatch`, `error`, `speechend`, `soundend`, `audioend`, and `end`.
- Supported event handler properties are `onstart`, `onaudiostart`, `onsoundstart`, `onspeechstart`, `onresult`, `onnomatch`, `onerror`, `onspeechend`, `onsoundend`, `onaudioend`, and `onend`.
- `result` events expose `resultIndex`, `results`, and `sessionId`.
- `error` events expose `error`, `message`, and `sessionId`.

### Behavior notes

- Default values are `lang = ''`, `continuous = false`, `interimResults = false`, and `maxAlternatives = 1`.
- If `lang` is left empty, the host speech capability chooses the default language for the current runtime.
- `start()` forwards a new recognition session request to the host speech capability.
- `stop()` asks the host to stop listening and finalize the active session if possible.
- `abort()` stops the active session immediately without expecting a normal final result.
- New `start()` calls require the owning InkView to remain interactive.
- Ink currently supports object-scoped recognition sessions, targeted lifecycle events, final result delivery, and explicit `stop()` / `abort()` control.

### Error behavior

- `start()` fails immediately with `InvalidStateError` when the owning InkView is non-interactive.

## `SpeechRecognitionSession`

Use this API when audio is already recorded or must arrive incrementally. The session does not open the microphone itself; capture microphone chunks with `MediaRecorder` and write them to `session.audio`.

### Constructor

`new SpeechRecognitionSession(options?)`

| Option | Type | Behavior |
| --- | --- | --- |
| `lang` | `string` | Recognition language such as `zh-CN`. |
| `interimResults` | `boolean` | Enables provisional results when supported; defaults to `false`. |
| `maxAlternatives` | `number` | Maximum alternatives per result; minimum/default is `1`. |
| `phrases` | `{ phrase: string, boost?: number }[]` | Custom hotwords; check capabilities first. |
| `segmentation` | `'auto' \| 'vad' \| 'semantic' \| { mode: 'vad', silenceDurationMs?: number }` | Requested segmentation mode; check supported modes and VAD threshold capability. |
| `audio` | `{ mimeType?, sampleRate?, channelCount?, sampleFormat? }` | Input format; `sampleFormat` is `'s16'` or `'f32'`. |

The instance exposes writable stream `audio`, read-only `state`, `updateContext(messages)`, and `onstart`, `onaudiostart`, `onresult`, `onerror`, `onaudioend`, and `onend`.

### `SpeechRecognitionSession.getCapabilities()`

Returns a Promise for:

| Field | Meaning |
| --- | --- |
| `audioFormats` | MIME types and supported sample rates, channel counts, and sample formats. |
| `maxChunkBytes` | Maximum transport chunk size; larger writes are split automatically. |
| `interimResults` | Whether provisional results are supported. |
| `maxAlternatives` | Maximum alternatives per result. |
| `phrases` | Whether custom hotwords are supported. |
| `contextUpdates` | Whether initial or updated ASR context is supported. |
| `segmentationModes` | Supported `auto`, `vad`, or `semantic` modes. |
| `vadSilenceDuration` | Whether a custom VAD silence duration is supported, with `minMs` and `maxMs` bounds. |

For a custom VAD threshold, select a non-negative integer within the reported
closed interval and pass `{ mode: 'vad', silenceDurationMs }`. Unsupported modes
or threshold support reject the first audio write; malformed options throw.
Segmentation ends a result segment, not the audio stream or session. Close the
audio writer when all input is complete.

### `session.updateContext(messages)`

Replaces the recognition context. Each message has non-empty `text` and role `user` or `assistant`. Check `contextUpdates`; the Promise rejects when dynamic context is unsupported or the update fails.

```javascript
const capabilities = await SpeechRecognitionSession.getCapabilities();
const session = new SpeechRecognitionSession({
  lang: 'zh-CN',
  interimResults: capabilities.interimResults,
  phrases: capabilities.phrases
    ? [{ phrase: 'Rokid', boost: 5 }, { phrase: 'AIUI', boost: 5 }]
    : undefined,
});

if (capabilities.contextUpdates) {
  await session.updateContext([
    { role: 'user', text: 'I am asking about Rokid products.' },
  ]);
}

session.onresult = (event) => {
  console.log(event.results[event.resultIndex][0].transcript);
};

const writer = session.audio.getWriter();
await writer.write(audioBlob);
await writer.close();
```

For live microphone input, choose a MIME type supported by both `MediaRecorder.isTypeSupported()` and `capabilities.audioFormats`, serialize `dataavailable` writes through one Promise chain, wait for all writes, then close the writer and stop microphone tracks.
