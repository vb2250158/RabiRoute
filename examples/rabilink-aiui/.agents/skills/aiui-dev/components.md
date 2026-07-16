# AIUI Built-in Components Reference

This reference is aligned with the current registered component list in `ink/packages/ink-builtin-components/src/lib.rs` and is meant to reflect the implementation that AIUI agents can rely on today.

## Common Runtime Rules

- Most components support standard WXML attributes such as `id`, `class`, and inline `style`.
- Tap handlers such as `bindtap` and `catchtap` are handled by the framework layer on `TouchEnd` / `MouseUp`, not by each component individually.
- Layout, size, spacing, borders, colors, and flex behavior are primarily controlled through WXSS rather than many component-specific props.
- Some tags are currently aliases of other components:
  - `swiper`, `swiper-item`, and `fragment` are currently backed by the `view` implementation.
- The internal `#text` registration is runtime-only and is not meant to be authored directly in page templates.

## Component Reference

### `<view>`

**Purpose**

Base layout container for general composition.

**Supported Attributes**

This component has no view-specific props in the current implementation. Use:

- `id`, `class`, `style`
- Generic interaction handlers such as `bindtap` and `catchtap`

**Content Model**

- Can contain arbitrary child components
- Commonly used as the main flex layout wrapper

**Notes**

- Behavior is almost entirely style-driven
- Use class selectors and Flexbox for layout control

**Example**

```xml
<view class="card" bindtap="openDetail">
  <text class="title">{{ title }}</text>
</view>
```

### `<text>`

**Purpose**

Displays text content.

**Supported Attributes**

No text-specific props are parsed by the component itself.

- Use text content between the tags
- Use `class` / `style` for typography, color, wrapping, alignment, and spacing
- Generic tap handlers are available when needed

**Content Model**

- Primary content comes from inline text or interpolated text such as `{{ message }}`
- Can also wrap child nodes, though plain text usage is the normal pattern

**Notes**

- Text content is rendered through WXML interpolation before display

**Example**

```xml
<text class="headline">{{ greeting }}</text>
```

### `<image>`

**Purpose**

Displays local or remote images.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `src` | String | `''` | Image source path or URL. |
| `mode` | String | `scaleToFill` | Image scaling mode. The implementation explicitly handles `widthFix` and `heightFix`, and also passes the mode string through to the view layer. |

**Events**

- No public component-specific events

**Content Model**

- Normally used as an empty tag

**Notes**

- Local files and remote URLs are both supported
- Image loading is asynchronous when needed
- `widthFix` preserves aspect ratio by letting height auto-expand
- `heightFix` preserves aspect ratio by letting width auto-expand
- Animated image results can register a frame animation automatically

**Example**

```xml
<image class="avatar" src="{{ user.avatar }}" mode="widthFix"></image>
```

### `<button>`

**Purpose**

Clickable container for actions.

**Supported Attributes**

No button-specific props are parsed by the current component implementation.

- Commonly used with `bindtap` or `catchtap`
- Can be styled with `class` / `style`
- Child text or child nodes are rendered normally

**Events**

| Event | Description |
| :--- | :--- |
| `bindtap` | Generic framework tap event fired on pointer release. |
| `catchtap` | Tap event that stops bubbling. |

**Content Model**

- Can contain text and child nodes

**Notes**

- The current button component is structurally close to a styled container with tap handling provided by the framework
- Do not assume web-style form submission behavior

**Example**

```xml
<button class="btn-primary" bindtap="submitForm">Submit</button>
```

### `<canvas>`

**Purpose**

Native-backed 2D drawing surface.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `width` | Number | `300` | Backing canvas width in pixels. |
| `height` | Number | `150` | Backing canvas height in pixels. |

**Events**

- No public component-specific events

**Content Model**

- Normally used as an empty tag

**Notes**

- The backing `Canvas` instance is created once per node
- The rendered snapshot is displayed through the native view tree
- If you need a larger visual display area, combine the logical canvas size with style sizing intentionally

**Example**

```xml
<canvas id="chartCanvas" width="320" height="180"></canvas>
```

### `<scroll-view>`

**Purpose**

Scrollable container for overflowing content.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scroll-x` | Boolean | `false` | Enables horizontal scrolling. |
| `scroll-y` | Boolean | `false` | Enables vertical scrolling. |
| `scroll-top` | Number | `0` | Sets the vertical scroll offset. |
| `scroll-left` | Number | `0` | Sets the horizontal scroll offset. |
| `scroll-into-view` | String | — | Scrolls to a descendant node with the matching `id`. |
| `auto-scroll` | Boolean | `false` | Enables automatic scrolling animation. |
| `scroll-speed` | Number | `25.0` | Auto-scroll speed. |
| `scroll-direction` | String | `vertical` | Auto-scroll direction. Use `vertical` or `horizontal`. |

**Events**

- No public component-specific scroll callback is exposed here

**Content Model**

- Can contain arbitrary child nodes

**Notes**

- The component creates an internal content view as the scrollable child container
- If neither `scroll-x` nor `scroll-y` is enabled, the container behaves like a regular non-scrollable wrapper
- Programmatic changes to `scroll-top` / `scroll-left` animate smoothly after the first render when the user is not actively interacting

**Example**

```xml
<scroll-view class="list" scroll-y="true" scroll-into-view="{{ activeId }}">
  <view id="item-a">A</view>
  <view id="item-b">B</view>
</scroll-view>
```

### `<card>`

**Purpose**

Structured container with optional cover, title, body, and footer areas.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cover` | String | — | Optional image URL rendered above the content area. |
| `title` | String | — | Optional title text rendered before the body content. |
| `footer` | String | — | Optional footer text rendered after the body content. |
| `role` | String | `navigation` | Accessibility and interaction role. An explicit value such as `group` overrides the default navigation semantics. |

**Events**

- No public component-specific events

**Content Model**

- Can contain arbitrary child nodes
- Child content is rendered as the card body between the optional title and footer

**Notes**

- When no explicit `role` is provided, the component is treated as `role="navigation"`
- Interactive mode treats a visible navigation card as an enterable navigation target
- Navigation matching is scoped to a single active layer, and nested navigation containers are ignored while their parent card remains eligible
- Within an active card, focus order follows actionable descendants with non-negative `tabindex`
- Built-in themes apply a hover outline to `card:hover` using outline properties rather than border changes, so layout size does not shift
- Theme hosts can customize the hover effect with `--card-hover-outline-width`, `--card-hover-outline-color`, and `--card-hover-outline-offset`

**Example**

```xml
<card
  title="Now Playing"
  footer="Swipe for more"
>
  <text>Artist recommendations and queue summary.</text>
</card>
```

### `<chart>`

**Purpose**

Renders `line`, `area`, `pie`, and `radar` charts.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `type` | String | `line` | Chart type. Supported values: `line`, `area`, `pie`, `radar`. |
| `series` | String \| Array | `value` | Single field name or a multi-series configuration array. |
| `data` | Array | `[]` | Chart data source. |
| `width` | Number | `300` | Backing canvas width in pixels. |
| `height` | Number | `150` | Backing canvas height in pixels. |
| `animate` | Boolean | `false` | Enables animated updates for supported chart types. |
| `color` | String | `#00FF7F` | Primary fallback chart color. |
| `show-average` / `showAverage` | Boolean | `false` | Draws an average reference line for single-series line and area charts. |
| `smooth` | Boolean | `true` | Enables smooth curves for line and area rendering. |
| `y-axis` / `yAxis` | Object \| JSON String | — | Y-axis configuration. |
| `x-axis` / `xAxis` | Object \| JSON String | — | X-axis configuration. |

**Nested `series` Object**

- `yName` or `yKey`: required series value key
- `xName` or `xKey`: optional x-axis key
- `dataSource`: optional per-series data source override
- `color`: optional per-series color
- `width`: optional per-series stroke width
- `smooth`: optional per-series smoothing override

**Nested `y-axis` Object**

- `minimum` or `min`
- `maximum` or `max`
- `interval`
- `opposedPosition`
- `stripLines`

**Nested `stripLines` Item**

- `start` or `value`: y position
- `color`
- `width`
- `dash` or `dashArray`

**Nested `x-axis` Object**

- `valueType`
- `intervalType`
- `minimum`
- `maximum`

**Events**

- No public component-specific events

**Content Model**

- Normally used as an empty tag

**Notes**

- The chart implementation supports both kebab-case and camelCase aliases for several attributes
- Unknown chart types render nothing
- `series` can be passed as a simple field name for single-series rendering or as a JSON array / bound object array for multi-series rendering

**Example**

```xml
<chart
  type="line"
  series="{{ series }}"
  data="{{ points }}"
  animate="true"
  y-axis="{{ yAxis }}"
  x-axis="{{ xAxis }}"
  width="350"
  height="120"
></chart>
```

### `<lottie-view>`

**Purpose**

Displays a Lottie animation loaded from inline JSON, a local file, or a remote URL.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `src` | String | `''` | Lottie source. Can be inline JSON, a relative path, an absolute path, or an HTTP URL. |
| `auto-play` | Boolean | `true` | Starts playback automatically when the animation finishes loading. |
| `loop` | Boolean | `true` | Repeats playback after the animation completes. |
| `speed` | Number | `1.0` | Playback speed multiplier. |
| `progress` | Number | — | Manually renders a normalized progress position. Expected range is typically `0.0` to `1.0`. |

**Events**

- No public component-specific events

**Content Model**

- Normally used as an empty tag

**Notes**

- The current attribute name is `auto-play`, not `autoplay`
- If you want deterministic manual frame control with `progress`, pair it with `auto-play="false"`
- Failed loads do not emit a public failure callback from the component layer

**Example**

```xml
<lottie-view src="/assets/loading.json" auto-play="true" loop="true" class="loading"></lottie-view>
```

### `<a2ui>`

**Purpose**

Renders UI described by A2UI command streams.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `commands` | String | — | Initial JSON command payload. Executed once when the component first renders. |

**Events**

- No public WXML event is exposed directly by the component

**Content Model**

- Child nodes are generated dynamically from parsed A2UI surfaces

**Notes**

- The initial `commands` payload is only consumed once per component instance
- Dynamic updates happen through the A2UI runtime context, not by repeatedly mutating authored child nodes
- Internally supported update operations include full write, stream open, stream chunk, stream close, and clear

**Example**

```xml
<a2ui id="agent-view" commands="{{ initialUIJson }}" class="agent-surface"></a2ui>
```

```javascript
const ctx = a2ui.createA2UIContext('agent-view');
ctx.write(JSON.stringify([{ type: 'createSurface', surfaceId: 'main' }]));
```

### `<error-state>`

**Purpose**

Compact status row that displays an optional icon and a message.

**Supported Attributes**

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `icon` | String | — | Optional icon source shown on the left. |
| `text` | String | `''` | Message text shown on the right. |

**Events**

- No public component-specific events

**Content Model**

- Normally authored as an empty tag
- Internally expands into virtual `image` and `text` children

**Notes**

- The component owns the layout of its generated children
- Supplying no `icon` results in a text-only state row

**Example**

```xml
<error-state icon="/assets/warn.png" text="Network request failed."></error-state>
```
