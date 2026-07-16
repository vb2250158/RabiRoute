# AIUI wx API Reference

This file documents the verified `wx` module surface and related task or media objects available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
- Treat these definitions as implementation truth.
- Do not assume unlisted WeChat-compatible overloads or return shapes.

## `wx`

### Module export

- `import wx from 'wx'`

Behavior notes:

- The `wx` module currently declares and exports only `default`.

### Base methods

- `wx.arrayBufferToBase64(buffer)`

Behavior notes:

- `arrayBufferToBase64(buffer)` returns a base64 string.

Error behavior:

- `arrayBufferToBase64(buffer)` throws if the `ArrayBuffer` is detached.

### System methods

- `wx.exitMiniProgram(options?)`

Behavior notes:

- `exitMiniProgram(options?)` calls `success()` and `complete()` when present, then sends the app exit event.

### UI methods

- `wx.setBackgroundColor(options)`

Behavior notes:

- `setBackgroundColor(options)` reads these option fields when present:
  - `backgroundColor`
  - `backgroundColorTop`
  - `backgroundColorBottom`
- `setBackgroundColor(options)` calls `success()` when present.
- `setBackgroundColor(options)` calls `complete()` when present.
- The current implementation does not expose a `fail()` path.

### Router methods

- `wx.navigateTo(options)`
- `wx.redirectTo(options)`
- `wx.navigateBack(options?)`

Argument behavior:

- `navigateTo(options)` requires `options.url`.
- `redirectTo(options)` requires `options.url`.
- `navigateBack(options?)` uses `delta = 1` when omitted.

Behavior notes:

- `navigateTo(options)` requests page navigation.
- `redirectTo(options)` requests page redirection.
- `navigateBack(options?)` requests backward navigation.
- These methods call `success()` and `complete()` when present.

### Storage methods

#### Async methods

- `wx.setStorage(options)`
- `wx.getStorage(options)`
- `wx.removeStorage(options)`
- `wx.clearStorage(options)`

Argument behavior:

- `setStorage(options)` requires `key` and `data`.
- `getStorage(options)` requires `key`.
- `removeStorage(options)` requires `key`.
- All async storage methods optionally accept `success`, `fail`, and `complete`.

Behavior notes:

- Async storage methods require storage support in the current context. If it is unavailable, the call throws.
- `setStorage(options)` serializes `data` through JSON before storing it.
- `getStorage(options)` calls `success({ data })` when the key exists.
- `getStorage(options)` calls `fail({ errMsg: 'Key not found' })` when the key does not exist.
- `removeStorage(options)` and `clearStorage(options)` call `success()` on success.
- On storage errors, async methods call `fail({ errMsg })` when `fail` is present.
- Async storage methods call `complete()` after the success or fail path when `complete` is present.

#### Sync methods

- `wx.setStorageSync(key, data)`
- `wx.getStorageSync(key)`
- `wx.removeStorageSync(key)`
- `wx.clearStorageSync()`

Behavior notes:

- `setStorageSync(key, data)` serializes `data` through JSON before storing it.
- `getStorageSync(key)` returns the parsed stored value when the key exists.
- `getStorageSync(key)` returns `undefined` when the key does not exist.

Error behavior:

- Sync storage methods throw when storage support is unavailable in the current context.
- `setStorageSync(key, data)` throws when JSON serialization or storage write fails.
- `getStorageSync(key)` throws when the stored JSON cannot be parsed.
- `removeStorageSync(key)` throws on storage removal failure.
- `clearStorageSync()` throws on storage clear failure.

### Networking factory methods

- `wx.request(options)`
- `wx.createSocket(options)`
- `wx.connectSocket(options)`
- `wx.createEventSource(options)`

Return behavior:

- `wx.request(options)` returns a `RequestTask`.
- `wx.createSocket(options)` returns a `SocketTask`.
- `wx.connectSocket(options)` returns a `SocketTask`.
- `wx.createEventSource(options)` returns an `EventSourceTask`.

Behavior notes:

- `request(options)` uses `GET` when `method` is omitted.
- `request(options)` uses `'arraybuffer'` when `responseType` is omitted.
- `request(options)` resolves timeout in this order: `options.timeout`, app config timeout, then `60000`.
- `request(options)` accepts request data from `data` or fallback `body`.
- When `data` is an object and `content-type` contains `application/x-www-form-urlencoded`, the body is URL-encoded.
- Otherwise object `data` is serialized with `JSON.stringify`.
- `createEventSource(options)` uses the same request body construction rules as `request(options)`.

Callback behavior:

- `request(options)` supports `success`, `fail`, and `complete`.
- `success(res)` receives an object with these confirmed fields:
  - `data`
  - `statusCode`
  - `header`
  - `cookies`
  - `errMsg`
- When `responseType` is `'arraybuffer'`, `res.data` is an `ArrayBuffer`.
- Otherwise `res.data` is decoded text, except when `dataType` is `'json'` and parsing succeeds, in which case `res.data` is the parsed value.
- `fail(err)` receives an object with `errMsg`.
- `complete(result)` receives the same success object shape on success, or an object with `errMsg` on failure.

## `wx.speech`

### Methods

- `wx.speech.playTTS(text)`
- `wx.speech.startRecognition()`

Return behavior:

- `playTTS(text)` returns a string.
- `startRecognition()` returns a string.

Behavior notes:

- `playTTS(text)` forwards the request to the speech subsystem.
- If `playTTS(text)` cannot create the utterance request, it returns an empty string.

Error behavior:

- `startRecognition()` requires an interactive call site and throws when the interaction gate check fails.

## `wx.media`

### Methods

- `wx.media.getRecorderManager()`
- `wx.media.createCameraContext()`

Return behavior:

- `getRecorderManager()` returns a `RecorderManager` instance or `undefined`.
- `createCameraContext()` returns a `CameraContext` instance or `undefined`.

Behavior notes:

- These methods return `undefined` when the current context does not provide the required media capability.
- These methods may return `undefined` in unsupported app lifecycle modes.
- `getRecorderManager()` also returns `undefined` when recording capability is unavailable.

## `RequestTask`

### Methods

- `abort()`
- `onHeadersReceived(callback)`
- `offHeadersReceived(callback?)`
- `onChunkReceived(callback)`
- `offChunkReceived(callback?)`

Behavior notes:

- `onHeadersReceived(callback)` passes a plain object containing response headers.
- `offHeadersReceived(callback?)` clears this event type's callbacks. The callback argument is accepted but not used.
- `onChunkReceived(callback)` passes an `ArrayBuffer`.
- `offChunkReceived(callback?)` clears this event type's callbacks. The callback argument is accepted but not used.

## `SocketTask`

### Methods

- `send(data)`
- `close()`
- `onOpen(callback)`
- `onClose(callback)`
- `onError(callback)`
- `onMessage(callback)`

Argument behavior:

- `send(data)` accepts:
  - a string
  - an `ArrayBuffer`
  - a `Uint8Array`

Behavior notes:

- `onOpen(callback)` and `onClose(callback)` call the callback with no payload.
- `onError(callback)` passes an exception object created from the underlying error message.
- `onMessage(callback)` passes either a string or an `ArrayBuffer`.

Error behavior:

- `send(data)` throws a `TypeError` when `data` is not a string, `ArrayBuffer`, or `Uint8Array`.

## `EventSourceTask`

### Methods

- `close()`
- `onOpen(callback)`
- `onMessage(callback)`
- `onError(callback)`

Behavior notes:

- `onOpen(callback)` calls the callback with no payload.
- `onMessage(callback)` passes an object with these confirmed fields:
  - `data`
  - `event`
  - `id`
- `onError(callback)` passes an object with `errMsg`.

## `RecorderManager`

### Constructor

`RecorderManager` cannot be constructed directly.

### Methods

- `start(options)`
- `pause()`
- `resume()`
- `stop()`
- `onStart(callback)`
- `onResume(callback)`
- `onPause(callback)`
- `onStop(callback)`
- `onHeader(callback)`
- `onFrameRecorded(callback)`
- `onError(callback)`
- `onInterruptionBegin(callback)`
- `onInterruptionEnd(callback)`

Return behavior:

- `start(options)` returns a `Promise`.
- `pause()` returns a `Promise`.
- `resume()` returns a `Promise`.
- `stop()` returns a `Promise`.

Behavior notes:

- `start(options)` requires an interactive call site.
- `onStart(callback)`, `onResume(callback)`, `onPause(callback)`, `onInterruptionBegin(callback)`, and `onInterruptionEnd(callback)` call the callback with no payload.
- `onStop(callback)` passes an object with `tempFilePath`.
- `onHeader(callback)` passes two positional arguments: `format` and `buffer`.
- `onFrameRecorded(callback)` passes an object with `frameBuffer`.
- `onError(callback)` passes an object with `errMsg`.

Error behavior:

- `start(options)` throws when the interaction gate check fails.
- `pause()`, `resume()`, and `stop()` reject with a generic error when the operation fails.

## `CameraContext`

### Constructor

`CameraContext` cannot be constructed directly.

### Methods

- `takePhoto(options)`

Return behavior:

- `takePhoto(options)` returns a `Promise`.
- The promise resolves to an object with these confirmed fields:
  - `data`
  - `mimeType`
- `data` is returned as an `ArrayBuffer`.

Behavior notes:

- `takePhoto(options)` requires an interactive call site.
- Do not assume browser or WeChat-compatible option coverage beyond what is explicitly documented here.

Error behavior:

- `takePhoto(options)` throws when the interaction gate check fails.
- If the operation fails, the promise rejects with a generic exception.
