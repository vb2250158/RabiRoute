# AIUI AI and Speech API Reference

This file documents the verified AI and speech-related APIs available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
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

- `speechSynthesis.speak(utterance)`

### Behavior notes

- `speak(utterance)` forwards the utterance state to the native runtime through IPC.
- `speechSynthesis` currently supports dispatching speech synthesis requests through `speak()` only.
- `cancel()`, `pause()`, `resume()`, `getVoices()`, and utterance lifecycle events are not exposed.

## `SpeechSynthesisUtterance`

### Constructor

- `new SpeechSynthesisUtterance(text?)`

### Properties

- `text`
- `lang`
- `pitch`
- `rate`
- `voice`
- `volume`

### Behavior notes

- The default initial state is `text = ''`.
- The default initial state is `lang = 'en-US'`.
- The default initial state is `pitch = 1.0`.
- The default initial state is `rate = 1.0`.
- The default initial state is `voice = null`.
- The default initial state is `volume = 1.0`.

## `SpeechRecognition`

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
