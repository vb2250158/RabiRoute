# AIUI Built-in Components

This index is aligned with `ink/packages/ink-builtin-components/src/lib.rs`. It lists every authorable registered tag. Read the linked detail before generating component-specific attributes, events, methods, or behavior.

## View Containers

| Component | Purpose | Detail |
| --- | --- | --- |
| `<view>` | General layout container. | [View](./components/view.md) |
| `<row>` | View-compatible semantic row container. | [View aliases](./components/view.md#aliases) |
| `<column>` | View-compatible semantic column container. | [View aliases](./components/view.md#aliases) |
| `<scroll-view>` | Scrollable content with position control and events. | [Scroll View](./components/scroll-view.md) |
| `<swiper>` | Container for content presented as pages; no automatic carousel behavior. | [Swiper](./components/swiper.md) |
| `<swiper-item>` | Child page container used with `<swiper>`. | [Swiper](./components/swiper.md) |
| `<fragment>` | View-compatible grouping container. | [View aliases](./components/view.md#aliases) |
| `<slot>` | View-backed slot placeholder used in component composition. | [View aliases](./components/view.md#aliases) |
| `<card>` | Cover, title, body, and footer composition. | [Card](./components/card.md) |

## Date

| Component | Purpose | Detail |
| --- | --- | --- |
| `<calendar>` | Month, week, and schedule information. | [Calendar](./components/calendar.md) |

## Basic Content

| Component | Purpose | Detail |
| --- | --- | --- |
| `<text>` | Plain and bound text. | [Text](./components/text.md) |
| `<icon>` | Icons rendered with an icon font. | [Icon](./components/icon.md) |
| `<error-state>` | Empty, exceptional, or error feedback. | [Error State](./components/error-state.md) |
| `<streamdown>` | Streaming Markdown content. | [Streamdown](./components/streamdown.md) |
| `<table>` | Structured columns and row data. | [Table](./components/table.md) |
| `<timed-text>` | Text-range highlighting synchronized with playback. | [Timed Text](./components/timed-text.md) |

## Semantic Content

| Component | Purpose | Detail |
| --- | --- | --- |
| `<p>` | Paragraph and inline content. | [Paragraph](./components/p.md) |
| `<header>` | Content heading. | [Header](./components/header.md) |
| `<blockquote>` | Quoted content. | [Blockquote](./components/blockquote.md) |
| `<list>` | Ordered or unordered list container. | [List](./components/list.md) |
| `<list-item>` | One list entry. | [List Item](./components/list-item.md) |
| `<b>` | Bold semantic content. | [Bold](./components/b.md) |
| `<i>` | Italic semantic content. | [Italic](./components/i.md) |
| `<snippet>` | Inline or block code. | [Snippet](./components/snippet.md) |
| `<formula>` | Inline or block mathematics. | [Formula](./components/formula.md) |

## Forms and Interaction

| Component | Purpose | Detail |
| --- | --- | --- |
| `<button>` | Focusable action control. | [Button](./components/button.md) |
| `<input>` | Single-line text input. | [Input](./components/input.md) |
| `<textarea>` | Multiline text input. | [Textarea](./components/textarea.md) |
| `<switch>` | Switch or checkbox control. | [Switch](./components/switch.md) |

## Media

| Component | Purpose | Detail |
| --- | --- | --- |
| `<image>` | Local or remote image. | [Image](./components/image.md) |
| `<video>` | Video playback and playback events. | [Video](./components/video.md) |
| `<lottie-view>` | Lottie animation asset. | [Lottie View](./components/lottie-view.md) |

## Location

| Component | Purpose | Detail |
| --- | --- | --- |
| `<map>` | Map rendered from MVT vector tiles. | [Map](./components/map.md) |
| `<map-gpx>` | GPX track and waypoint overlay for `<map>`. | [Map GPX overlay](./components/map.md#map-gpx-properties) |

## Canvas and Charts

| Component | Purpose | Detail |
| --- | --- | --- |
| `<canvas>` | Custom 2D drawing and pixel operations. | [Canvas](./components/canvas.md) |
| `<chart>` | Data visualization. | [Chart](./components/chart.md) |

## AI-generated UI

| Component | Purpose | Detail |
| --- | --- | --- |
| `<a2ui>` | A2UI command stream rendered as an interface surface. | [A2UI](./components/a2ui.md) |

## Internal Registration

`#text` is also registered by the runtime but represents parsed text nodes. It must not be written directly in WXML or `.ink` templates and is therefore excluded from the 37 authorable tags above.

## Shared Rules

- Most components accept common WXML attributes such as `id`, `class`, and inline `style`.
- Generic tap handling such as `bindtap` and `catchtap` is provided by the framework rather than each component.
- Use WXSS for layout, size, spacing, borders, colors, and Flexbox behavior unless the component detail defines a dedicated property.
- A registered familiar tag does not imply full browser or WeChat behavior. In particular, view-backed aliases add no behavior beyond their documented container role.
