# AIUI Web Networking and Encoding API Reference

This file documents browser-style networking, Streams, text encoding, Web Crypto, storage, and timing APIs available to AIUI agent code.

- Common scope, entry points, and authoring rules live in [apis.md](./index.md).
- Treat this file as the implementation-aligned reference for streamed HTTPS consumption and incremental text decoding.

## `fetch(url, options?)`

### Return behavior

- `fetch(url, options?)` returns a `Promise<Response>`.

### Behavior notes

- Prefer `fetch` when you want promise-based request flow or streamed body consumption through `response.body`.
- If you only care about the final buffered result, `response.text()`, `response.json()`, and `response.arrayBuffer()` remain valid choices.

## `Headers`

### Constructor

- `new Headers(init?)`

### Confirmed behavior

- Current compatibility checks explicitly cover case-insensitive key lookup.
- Repeated header values are merged and returned from `get(name)` as a comma-separated string.
- Verified methods in current examples include `has(name)` and `get(name)`.

### Example

```javascript
const headers = new Headers([
  ['X-Test', 'one'],
  ['x-test', 'two'],
]);

console.log(headers.has('x-test')); // true
console.log(headers.get('X-Test')); // "one, two"
```

## `Response`

### Common properties

- `ok`
- `status`
- `statusText`
- `url`
- `body`
- `bodyUsed`

### Common methods

- `clone()`
- `text()`
- `json()`
- `arrayBuffer()`

### Behavior notes

- `body` is exposed as a `ReadableStream`.
- Once the body is locked by `getReader()`, convenience readers such as `text()` and `json()` no longer consume that same body.
- `bodyUsed` becomes `true` after the body has been consumed or locked to a reader.
- `clone()` allows the original response and the cloned response to be consumed independently.

## Streams

### Readable streams and readers

`new ReadableStream(underlyingSource?, strategy?)` accepts source callbacks
`start(controller)`, `pull(controller)`, and `cancel(reason)`. Chunks can be
objects, strings, or bytes. `type: 'bytes'` creates a byte stream, optionally
with `autoAllocateChunkSize`; `strategy.size` is invalid for byte streams.

| Member | Contract |
| --- | --- |
| `ReadableStream.from(iterable)` | Creates a stream from a sync or async iterable, advancing as data is requested. |
| `stream.locked` | Read-only boolean. One reader or pipe locks a stream at a time. |
| `stream.getReader(options?)` | Default reader, or BYOB reader for `{ mode: 'byob' }`. A locked stream or BYOB on an ordinary stream throws `TypeError`. |
| `reader.read()` | Default reader: `Promise<{ value, done }>`; errors reject. |
| `reader.read(view, options?)` | BYOB reader: nonempty TypedArray/DataView; `min` defaults to `1` view element. Returns a new view; input buffer ownership transfers. |
| `reader.closed` | Promise resolving on close, rejecting on error or early lock release. |
| `reader.cancel(reason?)` | Cancels its source, returning `Promise<void>`. |
| `reader.releaseLock()` | Releases the lock; pending reads fail with `TypeError`, queued data remains. |
| `stream.cancel(reason?)` | Discards queued chunks and notifies the source; cancel locked streams through their reader. |
| `stream.tee()` | Locks the original and returns two branches. Ordinary chunks preserve identity; byte branches get independent buffers. |
| `stream.values(options?)` | Async iterator; early exit cancels by default, or only releases the lock with `{ preventCancel: true }`. |
| `stream[Symbol.asyncIterator]()` | Supports `for await...of`, using default cancellation behavior. |

Only byte streams, including network response bodies, support BYOB. Use the
returned view / buffer after each read; the original input view is transferred.
Release the old reader before switching modes. Canceling one tee branch does
not immediately cancel the source; that cancellation Promise waits for the
other branch or source to finish. If both cancel, the source receives both reasons.

Default controllers provide `desiredSize: number | null`, `enqueue(chunk)`,
`close()`, and `error(reason?)`. Byte controllers additionally expose
`byobRequest` or `null`; byte enqueue transfers input buffers. A BYOB request
has a fillable `view`, `respond(bytesWritten)`, and
`respondWithNewView(view)` for a compatible pending range. Do not reuse the
old request after responding.

### Writable streams and transforms

`new WritableStream(underlyingSink?, strategy?)` accepts `start(controller)`,
`write(chunk, controller)`, `close()`, and `abort(reason)` callbacks, which may
return Promises. Strategy uses `highWaterMark` and optional `size(chunk)`.

| Member | Contract |
| --- | --- |
| `stream.locked` / `getWriter()` | Only one writer; requesting another while locked throws `TypeError`. |
| `writer.ready` / `desiredSize` | Backpressure Promise and remaining capacity (`number | null`). |
| `writer.closed` | Resolves on close, rejects on errors or early lock release. |
| `writer.write(chunk?)` | `Promise<void>`; await acceptance before sustained writes. |
| `writer.close()` / `abort(reason?)` | `Promise<void>` for orderly completion or discarding unprocessed chunks. |
| `writer.releaseLock()` | Releases ownership; do not release while a write is pending. |
| `stream.close()` / `abort(reason?)` | For unlocked streams; operate through the writer when locked. |
| `new TransformStream(transformer?, writableStrategy?, readableStrategy?)` | Transformer accepts async-capable `start`, `transform`, and `flush`; exposes read-only `readable` / `writable`. Errors propagate to both endpoints. |
| `stream.pipeTo(destination, options?)` | `Promise<void>` honoring backpressure and cleanup. |
| `stream.pipeThrough({ readable, writable }, options?)` | Returns the transform's readable endpoint. |

By default, source completion closes the destination, source errors abort it,
and destination errors cancel the source. Pipe options `preventClose`,
`preventAbort`, `preventCancel`, and abort `signal` control this behavior.
Locks release after shutdown/failure cleanup. Await `pipeTo()` completion and
handle rejection. `CountQueueingStrategy({ highWaterMark })` counts chunks;
`ByteLengthQueueingStrategy({ highWaterMark })` counts chunk `byteLength`.
Construct both with `new`; each exposes `highWaterMark` and `size(chunk)`.

```javascript
const response = await fetch('https://example.com/stream');
const reader = response.body.getReader();
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    console.log(value.byteLength);
  }
} finally {
  reader.releaseLock();
}
```

## `TextDecoder`

### Constructor

- `new TextDecoder(label?, options?)`

### Common properties

- `encoding`
- `fatal`
- `ignoreBOM`

### Methods

- `decode(input?, options?)`

### Behavior notes

- `decode(input, { stream: true })` keeps the decoder state across chunk boundaries.
- Call `decode()` once more with no input after the last chunk to flush any buffered trailing bytes.
- For streamed UTF-8 text, this is the preferred pattern because multibyte characters may span multiple chunks.

### Example

```javascript
const response = await fetch('https://example.com/stream');
const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');

let text = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) {
    break;
  }

  text += decoder.decode(value, { stream: true });
}

text += decoder.decode();
console.log(text);
```

## `WebSocket`

Create a connection with `new WebSocket(url, protocols?)`. Important members are `url`, `readyState`, `protocol`, `extensions`, `bufferedAmount`, `binaryType`, `send(data)`, and `close(code?, reason?)`.

Handle `open`, `message`, `error`, and `close` through event listeners or `onopen`, `onmessage`, `onerror`, and `onclose`. A message event exposes `data`; close events expose `code`, `reason`, and `wasClean`.

```javascript
const socket = new WebSocket('wss://example.com/events');
socket.addEventListener('open', () => socket.send('ready'));
socket.addEventListener('message', (event) => console.log(event.data));
socket.addEventListener('close', (event) => {
  console.log(event.code, event.reason, event.wasClean);
});
```

Close the socket when its owning Page, Widget, or task no longer needs it.

## `File` and `FormData`

`new File(parts, name, options?)` creates a Blob with `name`, `lastModified`, `size`, and `type`. `FormData` supports `append()`, `set()`, `get()`, `getAll()`, `has()`, `delete()`, and iteration.

```javascript
const attachment = new File(['AIUI'], 'note.txt', { type: 'text/plain' });
const form = new FormData();
form.append('attachment', attachment);
form.append('category', 'example');
await fetch('/api/upload', { method: 'POST', body: form });
```

Do not manually set a multipart boundary when passing `FormData` as the request body.

## `URL` and `URLSearchParams`

Use `new URL(input, base?)` to parse or resolve URLs. Read or update `protocol`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`, `origin`, and `searchParams`.

`URLSearchParams` supports construction from a query string, records, or pairs plus `append()`, `set()`, `get()`, `getAll()`, `has()`, `delete()`, `sort()`, iteration, and `toString()`.

```javascript
const url = new URL('/weather', 'https://example.com');
url.searchParams.set('city', 'Hangzhou');
console.log(url.href);
```

## Text Encoding

- `new TextEncoder().encode(text)` returns UTF-8 bytes.
- `encoder.encodeInto(source, destination)` writes into an existing `Uint8Array`, returning `{ read, written }`. `read` counts UTF-16 code units, `written` counts bytes; no partial UTF-8 character is written. Continue with `source.slice(read)` when space runs out.
- `TextDecoder.decode(input?, { stream? })` decodes bytes; use streaming mode across chunk boundaries and finish with an empty `decode()`.
- Decoder input can be `ArrayBuffer`, `SharedArrayBuffer`, or a TypedArray/DataView (only its own view range); ordinary numeric arrays are invalid. Unsupported labels throw `RangeError`. `fatal: true` throws `TypeError` on malformed or incomplete final input.
- `ignoreBOM` defaults to `false` (remove an initial UTF BOM); `true` preserves it. A BOM does not switch encoding.

### Encoding streams

`new TextEncoderStream()` has `encoding === 'utf-8'`, a writable accepting
strings (input is converted to strings), and a readable emitting `Uint8Array`.
Surrogate pairs can span chunks; a trailing lone surrogate becomes U+FFFD on close.

`new TextDecoderStream(label?, options?)` accepts the same labels and
`fatal` / `ignoreBOM` options as `TextDecoder`. Its writable accepts the same
byte input types as `decode()`, and its readable emits nonempty strings.
Split characters and BOM state survive across chunks; close flushes state.

Both expose stable read-only `readable` / `writable` endpoints. Consume the
readable concurrently with manual writes to avoid waiting on backpressure.
Readable cancellation rejects pending writes; writable abort and decoding
errors propagate through the endpoints. All four encoding classes are
available in Pages and Agent Workers; Workers still do not provide `fetch`.

```javascript
const response = await fetch('https://example.com/stream');
const textStream = response.body.pipeThrough(new TextDecoderStream('utf-8'));
for await (const text of textStream) console.log(text);
```

## Web Crypto

Use global `crypto` or `import crypto from 'crypto'`. Current scope is secure
randomness, SHA digests, and HMAC; encryption/decryption, RSA, ECDSA, and JWK
formats are unsupported.

| Method | Contract |
| --- | --- |
| `crypto.randomUUID()` | Secure v4 UUID string. |
| `crypto.getRandomValues(typedArray)` | Fills/returns the same integer TypedArray, including BigInt arrays. Floating-point/ordinary arrays are invalid; above 65,536 bytes throws `QuotaExceededError`. |
| `subtle.digest(algorithm, data)` | `Promise<ArrayBuffer>`; `SHA-1`, `SHA-256`, `SHA-384`, or `SHA-512`, as a string or `{ name }`. |
| `subtle.generateKey(algorithm, extractable, keyUsages)` | `Promise<CryptoKey>`; HMAC algorithm `{ name: 'HMAC', hash, length? }`. Hash is a supported SHA name or `{ name }`. |
| `subtle.importKey('raw', keyData, algorithm, extractable, keyUsages)` | Nonempty raw HMAC BufferSource; explicit bit length cannot exceed input or discard a whole trailing byte. |
| `subtle.exportKey('raw', key)` | `Promise<ArrayBuffer>`; requires an extractable key. |
| `subtle.sign('HMAC', key, data)` | `Promise<ArrayBuffer>`; requires `'sign'` usage. Algorithm also accepts `{ name: 'HMAC' }`. |
| `subtle.verify('HMAC', key, signature, data)` | `Promise<boolean>`; requires `'verify'` usage. Mismatches return `false`; algorithm also accepts `{ name }`. |

`subtle` is `crypto.subtle`. HMAC usages must be a nonempty array of `'sign'`
and/or `'verify'`. Key length is positive bits; default is 512 for SHA-1/256,
1024 for SHA-384/512. `CryptoKey` has read-only `type: 'secret'`, `extractable`,
`usages`, and `algorithm: { name: 'HMAC', hash: { name }, length }`.

Digest/sign/verify inputs and raw keys accept BufferSource: ArrayBuffer or
TypedArray/DataView, using only the view range. Encode strings first. Arrays,
fabricated objects, and detached buffers are invalid. Handle synchronous
validation errors and async rejections in `try { await ... } catch`.
Unsupported algorithms/formats use `NotSupportedError`; incompatible keys or
usages use `InvalidAccessError`; invalid usages use `SyntaxError`; invalid raw
keys use `DataError`. Do not log exported keys or use ordinary randomness for tokens.

```javascript
const bytes = new Uint8Array(16);
crypto.getRandomValues(bytes);
const digest = await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode('AIUI'),
);

const key = await crypto.subtle.generateKey(
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
);
const data = new TextEncoder().encode('message');
const signature = await crypto.subtle.sign('HMAC', key, data);
console.log(await crypto.subtle.verify('HMAC', key, signature, data));
```

## `localStorage`

`getItem(key)` returns a string or `null` when absent. `setItem(key, value)`
converts both arguments with JavaScript string conversion (`null` becomes
`'null'`); serialize objects with `JSON.stringify()` rather than storing
`'[object Object]'`. `removeItem(key)` also stringifies the key and tolerates
missing entries. `clear()` removes the current agent's storage. Mutations
return `undefined`. The [wx storage APIs](./wx.md#storage-methods) use JSON
serialization instead.

## User Timing

Use `performance.now()` for monotonic elapsed time. User Timing provides marks and measures:

```javascript
performance.mark('render-start');
// Perform the operation.
performance.mark('render-end');
performance.measure('render', 'render-start', 'render-end');

const [entry] = performance.getEntriesByName('render', 'measure');
console.log(entry.duration);
performance.clearMarks();
performance.clearMeasures();
```

## Authoring Rules For Agents

- Prefer `fetch` over `wx.request` when you need `async/await` flow or streamed body consumption.
- Prefer `wx.request` when you need Mini Program-style task callbacks or `RequestTask` control.
- For streamed text, pair `response.body.getReader()` with `TextDecoder.decode(value, { stream: true })` and a final empty `decode()` flush.
- Do not mix `getReader()` with `text()`, `json()`, or `arrayBuffer()` on the same body unless you deliberately use `response.clone()`.
