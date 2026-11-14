# Window API Reference

`window`, `self`, `globalThis`, and `global` refer to the same global object
in a Page or Widget. Agent Workers have a separate global scope and no
`Window`. A global API being callable does not imply a `window.xxx` alias.

## Viewport

`window.innerWidth` and `window.innerHeight` are read-only numeric viewport
dimensions in pixels.

## `window.open(url, target?)`

Requests opening a Widget declared in `app.json.widgets`. The URL is its
extensionless project path with optional query parameters. `target` defaults
to `'_widget'`, the only supported target. Use `placement: 'overlay'` for a
temporary Widget opened over the user's configured layout:

```javascript
window.open('widgets/weather/index?city=hangzhou', '_widget');
```

The call returns `undefined` immediately, not a Widget instance or launch
result. An empty URL throws `TypeError`. It cannot open another Page, an
external URL, or an undeclared Widget.
Query parameters reach the Widget's `onCreate(options)` as strings; no
parameters produces `{}`. Invalid non-string or whitespace-only URLs throw
`TypeError` synchronously.

## Network events

Use `window.addEventListener('online', listener)` and
`window.addEventListener('offline', listener)` to observe online state changes.
Read `navigator.onLine` and [connection metadata](./navigator.md#network-information)
inside the listener; remove listeners during cleanup. These signals do not
establish reachability of a particular service.

## `window.close()`

Requests that the host close the current agent instance; returns `undefined`.
An overlay Widget can call it when its temporary task is complete.

## Base64

`window.atob(encodedData)` decodes a Base64 string to a binary string.
`window.btoa(stringToEncode)` encodes a binary string as Base64. Neither is a
general Unicode text encoder; use `TextEncoder` for text bytes.

## Global image encoding

`createImageBlob(source, options?)` is a global function that encodes an open
`ImageBitmap` to `Promise<Blob>` without a Canvas. `options.type` accepts
`image/png` (default and fallback) or `image/jpeg`; `options.quality` is a
JPEG quality value from 0 to 1. Passing an already closed bitmap rejects with
`InvalidStateError`; unsupported native external/GPU pixels reject with
`NotSupportedError`, and a full encoding queue rejects with `EncodingError`.
Close the bitmap after the call completes. See [Canvas APIs](./canvas.md) for
Canvas-owned image output.
