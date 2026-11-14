# AIUI WXSS Reference

This file documents the currently confirmed WXSS and CSS support surface for AIUI agents.

- Treat this file as the source of truth for selector and property support when generating styles.
- Only use selectors and properties that are explicitly listed here.
- Do not infer browser-level CSS compatibility beyond the confirmed support surface.

## Confirmed Selector Support

Only the following selector categories are currently documented as supported:

- **Class selector**: `.class`
- **ID selector**: `#id`
- **Type selector**: `element`, such as `view` and `text`
- **Grouping combinator**: `A, B`
- **Descendant combinator**: `A B`
- **Child combinator**: `A > B`
- **Documented pseudo-classes**: `:active`, `:hover`, `:focus`, `:first-child`, `:last-child`, `:nth-child(n)` (including `odd` / `even`), and `:disabled`.
- **Generated text boxes**: `::before` / `::after` on single-line `<text>` only; see [animation](./animation.md#generated-text-decorations).

Authoring rules:

- Prefer class selectors for most styling work.
- Use ID selectors sparingly for targeted hooks.
- Use type selectors only when the rule truly applies to all instances of a component tag.
- Do not generate selector categories that are not listed in this file.

## Confirmed Layout Properties

### Flexbox

Confirmed Flexbox-related properties:

- `display: flex`
- `flex-direction`
- `flex-wrap`
- `justify-content`
- `align-items`
- `flex-grow`
- `flex-shrink`
- `flex-basis`
- `flex`
- `gap`
- `row-gap`
- `column-gap`

### Grid

Confirmed Grid-related properties:

- `display: grid`
- `grid-template-columns`
- `grid-template-rows`
- `grid-auto-columns`
- `grid-auto-rows`
- `grid-auto-flow`
- `grid-column`
- `grid-column-start`
- `grid-column-end`
- `grid-row`
- `grid-row-start`
- `grid-row-end`
- `grid-area`
- `align-content`
- `justify-items`
- `align-self`
- `justify-self`
- `gap`
- `row-gap`
- `column-gap`

### Sizing And Spacing

Confirmed box model and sizing properties:

- `width`
- `height`
- `margin`
- `padding`
- Their individual `-top`, `-right`, `-bottom`, and `-left` forms.
- `box-sizing`

### Positioning And Overflow

Confirmed positioning and overflow properties:

- `position`: supports `static`, `relative`, `absolute`, and `fixed`
- `top`, `right`, `bottom`, `left`, and `z-index`
- `display: none` and `overflow: hidden`

Layout authoring rules:

- Prefer Flexbox when either Flexbox or Grid can satisfy the layout.
- Use Grid only when the UI needs coordinated row and column placement.
- Keep layouts simple and predictable for wearable-sized interfaces.

## Confirmed Styling Properties

### Colors And Backgrounds

Confirmed color and background properties:

- `color`
- `background-color`
- `background-position`
- Custom properties such as `--token-name`
- `var(--token-name)` references

### Borders And Outlines

Confirmed border and outline properties:

- `border`
- `border-width`
- `border-style`
- `border-color`
- `border-radius`
- Independent `border-top`, `border-right`, `border-bottom`, and `border-left`, including each side's width, style, and color longhands.
- `outline`
- `outline-width`
- `outline-style`
- `outline-color`
- `outline-offset`

### Typography

Confirmed typography properties:

- `font-size`
- `line-height`
- `font-weight`
- `font-family`
- `font-style`
- `text-align`
- `white-space: nowrap` with a constrained width, `overflow: hidden`, and `text-overflow: ellipsis` for single-line truncation. This does not provide multiline clamping.

### Effects And Visibility

Confirmed visual effect properties:

- `opacity`
- `visibility`
- `box-shadow`
- `filter`
- `transform`
- `transform-origin`
- Independent 2D `translate`, `rotate`, and `scale`; see [animation](./animation.md#2d-transforms-and-interpolation) for supported functions and composition.

### Motion

Confirmed transition and animation properties:

- `transition`
- `transition-property`
- `transition-duration`
- `transition-timing-function`
- `transition-delay`
- `animation`, `animation-name`, `animation-duration`, `animation-timing-function`, `animation-delay`, `animation-iteration-count`, `animation-direction`, and `animation-fill-mode`

Read [animation.md](./animation.md) for concurrent keyframes, timing, animation
events, and text-triggered replay. Generated-text properties `content`,
`event-trigger`, `animation-trigger`, and `-ink-animation-trigger-instance-limit`
are limited to that documented feature.

Styling authoring rules:

- Prefer theme tokens through `var(--token-name)` over hardcoded colors, spacing, radii, and border widths.
- Keep custom property names semantic and local to the feature when introducing new tokens.
- Prefer production-safe styles over browser-specific techniques.

## Other Confirmed WXSS Features

The following WXSS features are also confirmed:

- `@import` can be used to import external style sheets.
- Media queries are used in the sample capability pages and are part of the confirmed authoring surface.
- `@keyframes` defines animations; `@font-face` loads custom fonts.
- `!important` participates in cascade priority, including overriding keyframe values.

After `@import`, combine classes with `class="container flex-center"` in WXML;
`composes` is unsupported.

## Calculated and Random Values

`calc()` accepts exactly two operands with `+` or `-` and spaces around the
operator. Use compatible lengths (for example `calc(100vw - 20px)`) or two
percentages. Sizes, margin / padding / gap, and insets accept these values.
Multiplication, division, nesting, and mixing percentages with lengths such as
`width: calc(100% - 20px)` are unsupported for ordinary sizing and spacing.

Experimental `random()` supports these forms:

```css
.spark {
  opacity: 0.8;
  opacity: random(0.4, 1);
  margin-left: 0;
  margin-left: random(-20px, 20px, 5px);
  animation-duration: 700ms;
  animation-duration: random(400ms, 1s, 100ms);
  width: 6px;
  width: random(--size, 4px, 10px, 2px);
  height: 6px;
  height: random(--size, 4px, 10px, 2px);
}
```

- Syntax is `random([auto | --key,] min, max[, step])`. Use literal fallbacks before experimental declarations.
- Bounds must be compatible literal numbers, lengths, percentages, or times; optional step must be positive and compatible. Discrete values are `min + n * step`, including the upper bound only when a step lands on it. If `max < min`, the result is `min`.
- The consuming property determines the accepted type and limits. Length units can mix, as can `ms` / `s`; percentages cannot mix with lengths or numbers.
- Values remain stable across style recomputation. A named key shares a random base within an element: equal ranges/steps yield equal values; different ranges map that base to their own range. Values do not share across elements.
- Animation endpoints are resolved before interpolation and remain stable during playback. Each triggered replay gets a fresh context without changing older retained instances.
- Nested `calc()` / `random()` arguments, random angles/frequencies/resolutions, cross-element sharing, `element-shared`, and fixed random sources are unsupported. Invalid expressions invalidate the declaration. Use Web Crypto for secure randomness.

## Explicitly Unsupported Or Not Implemented

The following constraints are explicitly called out by the current repository and should be treated as unsupported for generated code:

- Browser-only CSS behavior is unsupported unless AIUI explicitly documents it.
- Unsupported CSS shorthands beyond the confirmed support surface must not be assumed to work.
- `position: sticky` is not supported.
- `animation-play-state`, 3D transforms, and perspective are unsupported.
- `font-variant` is not supported.
- `word-break` is not supported.
- Browser `::placeholder`, `::-webkit-scrollbar`, and generated boxes on arbitrary containers or multiline `<text>` are outside the supported subset. Use component placeholder properties.
- Any selector category or property not listed in this file is outside the confirmed support surface and must not be generated by default.

## Authoring Rules For Agents

- Treat this file as implementation truth, not browser truth.
- Generate only the selectors and properties listed here.
- Prefer class-based styling and semantic theme tokens.
- Keep WXSS concise, deterministic, and easy to render on wearable layouts.
