# AIUI Runtime API Index

Use this page to choose a domain reference. The domain files contain the actual signatures, parameters, return values, events, errors, permissions, lifecycle requirements, and examples.

Never infer full browser or WeChat compatibility from a familiar API name. If a symbol or overload is absent, verify it against the current Ink types and implementation before generating code.

## Domain Routing

| Task or symbol | Read |
| --- | --- |
| App, Page, Widget, Agent Worker, Page data | [framework APIs](./framework.md) and [framework concepts](../framework.md) |
| Widget instance, `setData`, size, attachment lifecycle | [Widget API](./widget.md) |
| Agent Worker instance, `onOpen`, `waitUntil`, global scope | [Agent Worker API](./agent-worker.md) |
| `navigator` identity, language, network status, device capabilities | [Navigator](./navigator.md) |
| `window` viewport, Widget routing, closing, Base64 | [Window](./window.md) |
| `fetch`, `Headers`, `Response`, Streams, `WebSocket`, `File`, `FormData`, URL, encoding, Crypto, Performance | [Web APIs](./web.md) |
| `AudioPlayer`, text tracks, `Sound`, Web Audio, microphone/camera streams, recording sources (`captureSource`, `microphoneMode`), video | [media APIs](./media.md) |
| Language model, image input, speech synthesis, `SpeechRecognition`, `SpeechRecognitionSession` | [AI and speech APIs](./ai.md) |
| BLE client, accelerometer, orientation, gyroscope | [device APIs](./device.md) |
| `navigator.geolocation`, current position, location watching | [Geolocation API](./geo/geolocation.md) |
| GPX route parsing, creation, and export | [GPXDocument API](./geo/gpx-document.md) |
| `Canvas`, 2D drawing, `Path2D`, text metrics, image export, `BarcodeDetector` | [Canvas and barcode APIs](./canvas.md) |
| `wx.request`, sockets, Event Source, storage, navigation, camera, recorder, speech | [wx APIs](./wx.md) |

## Entry-point Summary

| API family | Entry point |
| --- | --- |
| Navigator capabilities | `navigator.*` |
| Device location | `navigator.geolocation` |
| Window and Widget routing | `window.*` |
| Language model | global `LanguageModel` or `import { LanguageModel } from 'language-model'` |
| Speech | globals or named imports from `'speech'` |
| Audio | globals where documented or named imports from `'audio'` |
| GPX | global `GPXDocument` or `import { GPXDocument } from 'gpx'` |
| Barcode | global `BarcodeDetector`, default or named import from `'barcode'` |
| wx compatibility | `import wx from 'wx'` — the module has a default export only |
| Page Canvas | `wx.createCanvasContext(id)` or the `<canvas>` node's context |
| Script-owned Canvas | `new Canvas(width, height)` |

## Capability and Cleanup Rules

- Microphone: declare `RECORD_AUDIO`, start capture from a valid user interaction, stop every media track, and release recorder/audio resources.
- Location: declare `GEOLOCATION`; clear every active `watchPosition()` ID.
- BLE client scan: stop the scan and disconnect GATT connections when finished.
- Audio: disconnect nodes and close `AudioContext`; call `destroy()` where the API exposes it.
- Events and timers: remove listeners and clear timers in the matching Page, Widget, or Worker cleanup.
- Streams: release or close readers/writers and do not consume one response body through multiple incompatible readers.

## Evidence Rule

The references describe verified current contracts, but source presence is not the same as complete-device validation. If correctness depends on target hardware, permissions, a service implementation, or rendering behavior, report what was statically verified and run the relevant target check when available.
