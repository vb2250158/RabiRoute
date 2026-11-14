# AIUI Events and Lifecycle Reference

Load this reference when implementing lifecycle, user input, focus, voice wakeup, head gestures, or environment awareness.

`onVoiceWakeup(event)` runs for voice or touch wakeup. Respond to the event
without filtering `event.keyword` by default. When the source matters, known
values include `乐奇`, `Hi Rokid`, and `clickAiAssist` for touch wakeup.
Call `event.preventDefault()` only when replacing the host's default action.

## Page Lifecycle

Common Page callbacks are:

| Callback | Use |
| --- | --- |
| `onLoad(query)` | Read route input and initialize state once per Page instance. |
| `onShow()` | Resume work needed while visible. |
| `onReady()` | Runs once per instance after the first frame containing the initial view is presented. |
| `onHide()` | Pause visible-only timers, listeners, or work. |
| `onUnload()` | Release final Page resources. |

Make repeated show/hide cycles safe. Final cleanup belongs in `onUnload()`.
The initial sequence is `onLoad` → `onShow` → first-frame presentation →
`onReady`. Parsing or layout alone does not fire ready. Returning to an existing
Page or calling `setData()` does not repeat it; unloading before presentation
prevents a late callback. Component `lifetimes.ready()` likewise waits for its
own subtree to appear in a presented frame, including dynamically mounted components.

## Widget Lifecycle

| Callback | Use |
| --- | --- |
| `onCreate(options)` | Initialize once; opening URL query values are strings, or `{}` when absent. |
| `onAttach()` | Refresh visible data and resume visible-only work. |
| `onDetach()` | Pause work that is unnecessary while hidden. |
| `onDestroy()` | Cancel requests, remove listeners, and release resources. |

Do not substitute Page lifecycle callbacks in a Widget.

## Agent Worker Open Event

`onOpen(event)` runs whenever a Page or Widget opens. Call `event.waitUntil(promise)` synchronously for async work whose lifetime must be included in the event.

## Template Events

Use `bind<event>` for normal propagation and `catch<event>` to stop propagation where supported:

```xml
<button bindtap="submit">Submit</button>
<view catchtap="dismiss">...</view>
```

Handlers live on the default-exported logic object. Read payload values from `event.detail`, target information from `event.target`, and declared dataset values from the target dataset.

Do not use DOM `onclick` attributes or assume browser `addEventListener()` behavior for template component events.

## Animation Events

Use `bindanimationstart`, `bindanimationiteration`, `bindanimationend`, and
`bindanimationcancel`. `AnimationEvent` exposes `animationName`, `elapsedTime`
in seconds (excluding delay), and `pseudoElement` (`''`, `'::before'`, or
`'::after'`); `detail` mirrors these fields. Events bubble through ancestors to
the Page / Widget. `catch` or `stopPropagation()` stops bubbling; the events
are not cancelable. Handlers may call `setData()` synchronously.

Removing an animation or node, or applying `display: none`, cancels active
playback. Closing a Page / Widget fires cancellation before `onUnload` /
`onDestroy`. See [animation](./animation.md) for timing, replay, and cleanup.

## Network Status

App and Page `onNetworkStatus(event)` receive `event.online: boolean` and
`event.status: 'online' | 'offline'`. Window also emits `online` / `offline`;
`navigator.connection` emits `change`. See [Navigator](./apis/navigator.md).
Online status does not guarantee a network operation will succeed.

## Focus and Default Actions

Interactive elements can receive focus. Style focus visibly and do not remove all focus indication. Some key or navigation events have framework default behavior; prevent it only when the agent intentionally replaces that behavior.

## Key Events

Define `onKeyDown(event)` and `onKeyUp(event)` on the Page logic object and inspect `event.code`. Use `onKeyDown` for immediate feedback. Host default actions generally run after `onKeyUp`; call `event.preventDefault()` there when the Page takes over one of those actions.

### Rokid Glasses

Keep focus and the primary confirmation/back actions usable when handling these `event.code` values.

#### `Backspace`

Back action. On `onKeyUp`, the default behavior returns to the previous level or requests to close the agent when there is no page to return to. Call `event.preventDefault()` in `onKeyUp` if the Page handles back itself.

#### `ArrowUp`

Up direction. On `onKeyUp`, the default behavior moves within the current navigation path or scrolls the root view upward. Use `onKeyDown` for immediate feedback; prevent the `onKeyUp` default behavior when the Page handles navigation or scrolling itself.

#### `ArrowDown`

Down direction. On `onKeyUp`, the default behavior moves within the current navigation path or scrolls the root view downward. Use `onKeyDown` for immediate feedback; prevent the `onKeyUp` default behavior when the Page handles navigation or scrolling itself.

#### `Enter`

Confirm or activate. On `onKeyUp`, the default behavior enters navigation mode or activates the current target. Use `onKeyDown` for immediate feedback; prevent the `onKeyUp` default behavior when the Page handles confirmation itself.

#### `GlobalHook`

A device-specific signal for a touch on the glasses temple button; it is not a standard Web key value. Some host integrations report it through `onKeyDown` or `onKeyUp`. No default action is specified for `GlobalHook`.

> [!NOTE]
> Use `GlobalHook` on `onKeyDown` only for fast responses that do not distinguish button actions. To distinguish back from confirm, use `Backspace` or `Enter` instead.

### Rokid Glasses 2

The `event.code` mapping and default key actions for this device remain unverified. Confirm them against its host integration before implementing device-specific handlers; do not assume the Rokid Glasses mappings apply.

### First-generation full-color glasses

The `event.code` mapping and default key actions for this device remain unverified. Confirm them against its host integration before implementing device-specific handlers; do not assume the Rokid Glasses mappings apply.

## Voice Wakeup and World Awareness

Page-level awareness is opt-in:

```javascript
export default {
  onLoad() {
    this.enableWorldAwareness();
  },
  onHeadGesture(event) {
    if (event.gesture === 'nod') this.confirm();
  },
  onOrientationStabilityChange(event) {
    if (event.stable) this.setData({ stable: true });
  },
};
```

`enableWorldAwareness()` is Page-only. Do not call it from Widgets or Agent Workers. Treat wakeup and gesture callbacks as optional signals and preserve another usable interaction path when the product requires it.
