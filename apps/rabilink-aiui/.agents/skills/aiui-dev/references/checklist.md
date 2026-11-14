# AIUI Agent Delivery Checklist

Use this checklist after generating or modifying an AIUI agent and before declaring it complete. Apply every required item and each conditional section used by the agent. Do not claim a check passed unless it was actually performed.

## 1. Required Project Checks

- [ ] `AGENTS.md`, `app.json`, and every referenced source or asset file exist.
- [ ] `app.json` is valid JSON and uses current field names, including `agentWorkers` rather than `workers`.
- [ ] Every Page route declared in `pages` resolves to exactly one source structure: either one `.ink` file or same-basename `.json`, `.wxml`, `.wxss`, and `.js` files.
- [ ] Every Widget entry resolves to its `.ink` file, and its `family` matches `<script def>`.
- [ ] Every Agent Worker `script` is a project-relative `.js` or `.ts` file without a URL, absolute path, `..`, or backslashes.
- [ ] Custom component paths in `usingComponents` resolve to concrete files; directory entries explicitly include `index`.
- [ ] Imported project modules and packaged asset paths resolve with the same spelling and letter case.
- [ ] No required runtime file is accidentally excluded from the final package.

## 2. Registration and Source Checks

- [ ] App, Page, Widget, Component, and Agent Worker logic uses `export default { ... }`; no `App()`, `Page()`, or `Widget()` registration call remains.
- [ ] Every `.ink` file has valid block structure and exactly one interface root: `<page>` or `<widget>`, never both.
- [ ] `<script def>` contains valid JSON and `<script setup>` contains valid JavaScript or TypeScript.
- [ ] Every multi-file Page has valid `.json`, `.wxml`, `.wxss`, and `.js` files; its `.js` file uses `export default { ... }`, and its `.wxml` file does not add an `.ink`-only `<page>` wrapper.
- [ ] Template bindings reference fields that exist in `data`, computed state, or the documented render input.
- [ ] Event handler names in the template exist on the default-exported logic object.
- [ ] Calls to `setData()` use valid keys or dot paths and do not mutate rendered state without notifying the renderer.
- [ ] Async work handles rejection and does not leave the UI permanently loading after an error.

## 3. Page and Widget Behavior

- [ ] Page initialization, visibility changes, and final cleanup use the correct Page lifecycle callbacks.
- [ ] Page `onReady()` and component `lifetimes.ready()` wait for their own first presented frame and run once per instance; updates and redisplay do not require another ready callback.
- [ ] Widget code uses `onCreate(options)`, `onAttach()`, `onDetach()`, and `onDestroy()`; opening query values are handled as strings with defaults for absent values.
- [ ] Repeated Widget attach/detach and Page show/hide cycles do not duplicate timers or listeners.
- [ ] Widget layout is relative and adapts to available bounds; the root does not hardcode `239 × 140` or `480 × 140`.
- [ ] `1x1` and `1x2` are treated as size categories, with content that remains usable at the selected family.
- [ ] `window.open(url, '_widget')` targets a declared Widget; it is not used to open another Page.
- [ ] Conversation-flow cards remain display-only unless an explicitly supported interactive surface is used.

## 4. Agent Worker Checks

- [ ] `name`, `script`, `trigger`, and `lifetime` are present and valid.
- [ ] `trigger` is `{ "type": "open" }`, and no second open-trigger Worker is declared.
- [ ] `lifetime` is `instant` or `foreground`; unsupported `background` is not used.
- [ ] `onOpen(event)` calls `event.waitUntil(promise)` synchronously for work that must complete before the event ends.
- [ ] Repeated open events reuse or serialize initialization instead of starting conflicting duplicate work.
- [ ] Durable state is stored persistently rather than relying on values kept on Worker `this` after shutdown.
- [ ] Worker code does not use unavailable Page, Widget, `window`, `document`, `fetch`, routing, rendering, or media-capture APIs.

## 5. Components, Layout, and Visual Standards

- [ ] Every component, attribute, property, event, and method is present in `components.md` or verified against the current implementation.
- [ ] Every selector and style property is supported by `wxss.md`; browser-only CSS is not assumed.
- [ ] `calc()` uses the supported two-operand `+` / `-` syntax with compatible units; experimental `random()` declarations have literal fallbacks.
- [ ] Animation timing, concurrency, generated-text decorations, and cancellation follow [animation.md](./animation.md); no 3D transforms or `animation-play-state` are assumed.
- [ ] Layout uses Flexbox, Grid, percentages, constraints, and content sizing appropriately instead of relying on one test resolution.
- [ ] Text remains readable, important content is not clipped, and long or empty content has a deliberate state.
- [ ] Focus is visible and the primary flow works with the target's confirmation and back controls.
- [ ] Color is not the only way to communicate state.
- [ ] Generated UI copy avoids emoji unless explicitly required.
- [ ] Monochrome-green rules are applied only when that Rokid Glasses target is intended.
- [ ] Loading, empty, success, and failure states required by the task are implemented and distinguishable.

## 6. API and Data Checks

- [ ] Every runtime API is documented in the matching `references/apis/` domain file or was verified against current Ink types and implementation.
- [ ] Arguments, optional fields, defaults, return values, events, and errors match the verified contract.
- [ ] Browser or WeChat overloads not implemented by AIUI are not generated.
- [ ] External and render-time data is checked before use; missing optional data has a safe fallback.
- [ ] Streaming readers and writers are consumed in order and are closed or released when finished.
- [ ] Network failures, rejected permissions, unavailable capabilities, and malformed responses produce a usable result or error state.

## 7. Conditional Capability Checks

Apply only the rows used by the agent:

| Capability | Required checks |
| --- | --- |
| Microphone or recording | Declare `RECORD_AUDIO`; start capture from a valid user interaction; stop all tracks; close recorder, writer, and audio context. |
| Media recording format | Use static `MediaRecorder.isTypeSupported(mimeType)`; handle unsupported target formats. |
| Recording source selection | Set `captureSource` / `microphoneMode` in `getUserMedia()`; handle `OverconstrainedError`; omit microphone mode and enabled echo cancellation for system audio; use Web capture because wx recording has no source selection parameters. |
| Web Audio microphone analysis | Do not connect to `context.destination` unless playback is intended; disconnect nodes and close the context. |
| Location | Declare `GEOLOCATION`; handle permission and timeout errors; clear every watch ID. |
| BLE client | Check availability; stop scans; remove listeners; disconnect GATT when finished. |
| Speech recognition | No separate `SPEECH_RECOGNITION` permission; microphone capture still needs `RECORD_AUDIO`. Check supported formats and capabilities; serialize audio writes; close the writer for a final result; stop captured tracks. |
| Network status | Treat online / connection metadata as hints; handle actual request errors and remove connectivity listeners. |
| Stream pipelines | Await writes and pipe completion; handle backpressure, cancellation, and errors; BYOB transfers input buffers, so use returned views. |
| Language model image input | Use a supported `image_url` value and reject empty URLs; keep text and image parts in the documented message shape. |
| Canvas or images | Verify dimensions and pixel-buffer lengths; avoid drawing closed bitmaps; distinguish encoded PNG/JPEG Blobs from raw pixels; close bitmaps after encoding or use. |
| Timers or listeners | Store handles and remove or clear them in the matching hide, detach, unload, destroy, or Worker shutdown path. |

## 8. Executable Validation

Use the validation commands already provided by the agent repository. At minimum, run the applicable checks rather than inventing success from inspection:

- [ ] Parse `app.json` and every JSON configuration block.
- [ ] Parse or type-check JavaScript/TypeScript entry files and `<script setup>` code.
- [ ] Run the project's focused build, package, lint, type-check, or test command.
- [ ] Confirm the output package contains each declared Page, Widget, Worker, component, and asset.
- [ ] Search generated code for stale fields and unsupported registrations such as `workers`, `Page(`, `Widget(`, and hardcoded Widget root dimensions.
- [ ] Review validation output and distinguish new failures from repository baseline failures.

When a runnable preview or target is available:

- [ ] Open every changed Page and Widget.
- [ ] Exercise the primary interaction, focus path, back/close behavior, loading state, failure state, and cleanup/reopen path.
- [ ] For a Widget, check both its selected family and content growth rather than only one static screenshot.
- [ ] For hardware-backed APIs, test permission denial and actual device behavior when feasible.

## 9. Completion Report

Summarize completion with three evidence levels:

1. **Verified by static checks:** configuration parsing, syntax, types, package contents, and reference alignment.
2. **Verified by execution:** commands, preview interactions, tests, and observed results.
3. **Not verified:** target-device rendering, unavailable hardware/services, or scenarios that could not be exercised.

Do not describe static validation, a mock, or a successful package build as end-to-end device verification.
