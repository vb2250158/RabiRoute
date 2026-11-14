# AIUI Animation and Transform Reference

Use this reference with [WXSS](./wxss.md) for keyframes, event-driven replay,
and 2D motion. Prefer transform and opacity for frequent animation; size and
typography changes require layout.

## Concurrent Animations

```css
.status {
  animation: fade-in 300ms ease-out, pulse 900ms ease-in-out infinite;
  transition: background-color 200ms ease;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pulse {
  from { transform: scale(1); }
  50% { transform: scale(1.05); }
  to { transform: scale(1); }
}
```

Comma-separated animations have independent timing. Shorter duration, delay,
and related lists repeat; entries beyond the animation-name count are ignored.
Later contributing animations win on a shared property. Active transitions
override keyframes; ordinary `!important` declarations can override keyframes.

Unrelated `setData()` or style changes preserve playback progress. Removing
and re-adding an animation starts new playback. Completed `forwards` / `both`
effects retain their final values without continuously requesting frames.

## Timing and Events

- Duration / delay use `ms` or `s`; delay may be negative, duration may not.
- Iteration count accepts numbers or `infinite`; direction is `normal`, `reverse`, `alternate`, or `alternate-reverse`.
- Fill mode is `none`, `forwards`, `backwards`, or `both`.
- Timing supports `linear`, the `ease` family, `cubic-bezier()`, `step-start`, `step-end`, and `steps()`. `steps(n, jump-none)` requires `n >= 2`; other steps require positive integers.
- Zero duration or iteration count completes after delay without continuous playback.

```xml
<view class="status" bindanimationstart="onAnimation"
  bindanimationiteration="onAnimation" bindanimationend="onAnimation"
  bindanimationcancel="onAnimation" />
```

```javascript
export default {
  data: { completed: false },
  onAnimation(event) {
    console.log(event.animationName, event.elapsedTime, event.pseudoElement);
    if (event.type === 'animationend') this.setData({ completed: true });
  },
};
```

Events bubble to the Page / Widget and expose `animationName`, `elapsedTime`
in seconds excluding delay, and `pseudoElement` (`''`, `'::before'`, or
`'::after'`), also mirrored in `detail`. Use template `bind` / `catch`,
`addEventListener()`, or `onanimation...`; `stopPropagation()` stops bubbling.
Events are not cancelable. Callbacks may call `setData()` synchronously.

Removing an active animation/node or applying `display: none` fires one
`animationcancel`. Closing a Page / Widget cancels animations before
`onUnload` / `onDestroy`. Offscreen pauses and temporarily hidden Pages preserve
progress rather than restarting playback.

## Generated Text Decorations

Only single-line `<text>` supports generated `::before` / `::after` boxes.
`content` accepts quoted strings or `attr(name)`; missing attributes produce
empty strings, and `normal` / `none` generate no content. Typed `attr()` and
fallback arguments are unsupported. Use `content: ''` for an empty decoration.

`::before` anchors at the text start, `::after` at its end, both on the text
midline. These are generated boxes, not Entity/layout nodes; selectors cannot
return them as Entities.

```xml
<text class="streaming-text">{{answer}}</text>
```

```css
.streaming-text {
  position: relative;
  event-trigger: --text-update textchange;
}
.streaming-text::after {
  content: '';
  position: absolute;
  left: 100%;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #74f7c5;
  animation: spark 900ms ease-out;
  animation-trigger: --text-update replay;
  -ink-animation-trigger-instance-limit: 5;
}
@keyframes spark {
  from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to { opacity: 0; transform: translate(-50%, -28px) scale(0.35); }
}
```

`textchange` observes final bound text changes; `attributechange` observes
attribute-generated content changes. Initial mounting does not trigger replay;
multiple updates before one layout coalesce. `animation-trigger: --name replay`
restarts generated-box playback on the owning text. One instance is retained by
default; `-ink-animation-trigger-instance-limit` accepts integers `1`–`32` and
discards the oldest at the limit. Each instance captures its post-layout anchor
and animates only transform/opacity, so later text updates do not move older
effects. Use the bounded [random values](./wxss.md#calculated-and-random-values)
subset to vary replay endpoints, with literal fallbacks.

## 2D Transforms and Interpolation

`transform` supports `matrix()`, `translate()` / X / Y, `rotate()`, `scale()` /
X / Y, and `skew()` / X / Y. Independent `translate`, `rotate`, and `scale`
compose in that order before `transform`. For example:

```css
.badge {
  translate: 8px 25%;
  rotate: 0.125turn;
  scale: 120% 0.9;
  transform-origin: left center;
}
```

Sizes/insets, margin/padding, border widths, font-size/line-height, colors,
radii, background-position, visibility, opacity, and 2D transform/origin can
animate. Keep endpoint transform types and order compatible for continuous
interpolation; incompatible values switch at the interval midpoint.

3D transforms, perspective, a third transform-origin component, and
`animation-play-state` are unsupported. Min/max sizes, flex/grid controls, gap,
shadow, filter, clip, and outline do not interpolate.
