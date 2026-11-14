# AIUI Framework Reference

Use this reference for project structure, registration, Pages, Widgets, Agent Workers, SFC files, and agent configuration.

## Project Structure

```text
agent/
├── AGENTS.md
├── app.json
├── app.js
├── pages/
│   └── index/index.ink
├── widgets/
│   └── weather/index.ink
├── workers/
│   └── sync.js
├── components/
└── assets/
```

- `AGENTS.md` describes identity and requested capabilities.
- `app.json` declares Pages, Widgets, Agent Workers, and window configuration.
- `app.js` default-exports agent lifecycle and global data.
- Paths in configuration omit the `.ink` extension where shown.

## Registration

All logic entry files use an ES module default export:

```javascript
export default {
  data: { ready: false },
  onLoad() {
    this.setData({ ready: true });
  },
};
```

Never generate `App({...})`, `Page({...})`, or `Widget({...})`.

## Page Declaration

Declare Page routes in order; the first is the default Page:

```json
{
  "pages": ["pages/index/index", "pages/detail/index"]
}
```

A Page supports either of these equivalent source structures:

- **Multi-file Page**: four files with the same base path and the extensions `.json`, `.wxml`, `.wxss`, and `.js`.
- **Single-file Page**: one `.ink` file containing the same configuration, template, style, and logic concerns.

Do not mix the two forms for the same route.

The top-level Page schema describes render-time input:

```json
{
  "description": "Displays weather for a city.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "city": { "type": "string" },
        "temperature": { "type": "number" }
      },
      "required": ["city", "temperature"]
    }
  }
}
```

Keep `description` observable and define every required input in `schema.data`.

## Multi-file Page

For the route `pages/weather/index`, create all four files together:

```text
pages/weather/
├── index.json
├── index.wxml
├── index.wxss
└── index.js
```

`index.json` contains Page configuration and render-input metadata:

```json
{
  "navigationBarTitleText": "Weather",
  "description": "Displays weather for a city.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "city": { "type": "string" },
        "temperature": { "type": "number" }
      },
      "required": ["city", "temperature"]
    }
  }
}
```

`index.wxml` contains the Page template. It does not need an outer `<page>` block:

```xml
<view class="weather">
  <text>{{city}}</text>
  <text>{{temperature}}°C</text>
</view>
```

`index.wxss` contains Page-local styles:

```css
.weather {
  display: flex;
  flex-direction: column;
  padding: var(--spacing-md);
}
```

`index.js` default-exports Page state, lifecycle, and handlers:

```javascript
export default {
  data: {
    city: '',
    temperature: 0,
  },
  onLoad(query) {
    this.setData({ city: query.city || this.data.city });
  },
};
```

The four filenames must share the same basename. The corresponding `app.json` route remains extensionless: `"pages/weather/index"`.

## Single-file `.ink`

```html
<script def>
{
  "navigationBarTitleText": "Weather"
}
</script>

<script setup>
export default {
  data: { city: 'Hangzhou' },
};
</script>

<page>
  <view class="page"><text>{{city}}</text></view>
</page>

<style>
.page { display: flex; }
</style>
```

- `<script def>` contains JSON configuration, not executable JavaScript.
- `<script setup>` contains one default-exported logic object.
- `<page>` or `<widget>` is the sole interface root.
- `<style>` contains page-local WXSS/CSS.

## Data Binding and the Current Tree

Patch only changed fields with `setData(patch, callback?)`. Its callback may call
`setData()` again; query current nodes there when work depends on the update.
Array `.length` bindings are supported.

Each `ink:for` iteration has its own item/index scope. Name nested-loop variables
explicitly when outer values are needed. On a node with both `ink:for` and
`ink:if`, the condition evaluates in the current item's scope. Keep
`ink:if` / `ink:elif` / `ink:else` branches adjacent. Inactive branches are absent
from the rendered tree; `hidden="{{isHidden}}"` retains the node and binds a
boolean visibility state. After list, condition, or attribute updates, query the
current tree rather than retaining an Entity removed by a condition.

## Widget Development

AIUI supports two Widget families on Rokid Glasses:

| Family | Occupied grid cells | Current Glasses size |
| --- | ---: | ---: |
| `1x1` | 1 | `239 × 140` |
| `1x2` | 2 adjacent cells | `480 × 140` |

Rokid Glasses provide four Widget grid cells. `family` is a size category, not a fixed canvas contract. Use Flexbox, percentages, available space, padding, and content-driven sizing. Never hardcode a Widget root to `239px × 140px`.

Declare the Widget in `app.json`. When using `assets/minimal-widget.ink`, add
its matching `app.json.widgets` entry before packaging:

```json
{
  "widgets": [
    {
      "path": "widgets/weather/index",
      "family": "1x2",
      "placement": "overlay",
      "displayName": "Weather",
      "description": "Shows current weather."
    }
  ]
}
```

The same family must appear in the Widget file:

```html
<script def>
{ "widget": { "family": "1x2" } }
</script>

<script setup>
export default {
  data: { temperature: 24 },
  refresh() {
    this.setData({ temperature: this.data.temperature + 1 });
  },
};
</script>

<widget>
  <view class="widget" bindtap="refresh">
    <text>{{temperature}}°C</text>
  </view>
</widget>

<style>
.widget {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
```

Widget callbacks are `onCreate(options)`, `onAttach()`, `onDetach()`, and `onDestroy()`. Attach and detach may repeat. Widgets do not use Page lifecycle callbacks or Page-only `enableWorldAwareness()` and `finish()`.

`displayName` and `description` are required default metadata. `placement` is
`persistent` by default; use `overlay` for a temporary Widget opened through
`window.open()`. Keep `placement` in `app.json`, not the Widget `<script def>`.
For localized metadata, add `app.<BCP-47-locale>.json` at the project root with
`locale` and a `widgets` object keyed by Widget path. Override only
`displayName` and `description`; missing translations fall back to `app.json`.
`onAttach()` and `onDetach()` may run as overlays appear and disappear. Keep
one-time initialization in `onCreate(options)`; do not rely on retaining an instance
after closing the overlay.

Open a declared `overlay` Widget with:

```javascript
window.open('widgets/weather/index?city=hangzhou', '_widget');
```

The path must match the declared Widget. Query parameters reach `onCreate(options)`
as strings, such as `options.city`; no parameters produces `{}`.
This API currently opens Widgets only, not other Pages. Close a completed
overlay with `window.close()`. Do not assume its instance survives closing.

## Permissions

Declare only capabilities the agent uses in `app.json.permissions`:

| Permission | Purpose |
| --- | --- |
| `GEOLOCATION` | Get the current location or watch position changes. |
| `CAMERA` | Access the camera and capture images or video. |
| `RECORD_AUDIO` | Access the microphone and capture audio. |

Names are case-sensitive. Unrecognized names grant no capability, and an API
that requires an undeclared permission fails. A manifest declaration does not
grant operating system permission; handle denial and unavailable hardware at
the API call.

Speech recognition has no separate `SPEECH_RECOGNITION` permission. Microphone
capture still requires `RECORD_AUDIO`; external-audio recognition sessions do
not open the microphone themselves.

## Agent Worker Development

Agent Workers are non-visual scripts for temporary shared state or one-time work. They are not Web Workers.

```json
{
  "agentWorkers": [{
    "name": "sync",
    "script": "workers/sync.js",
    "trigger": { "type": "open" },
    "lifetime": "foreground"
  }]
}
```

| Field | Contract |
| --- | --- |
| `name` | Required, non-empty, and unique in the agent. |
| `script` | Required project-relative `.js` or `.ts`; no URL, absolute path, `..`, or backslash. |
| `trigger` | Required; currently only `{ "type": "open" }`. Only one open-trigger Worker is allowed. |
| `lifetime` | Required: `instant` or `foreground`. `background` is reserved and invalid. |

Opening a Page or Widget invokes `onOpen(event)`. Register async work before the callback returns:

```javascript
export default {
  refreshPromise: null,
  onOpen(event) {
    event.waitUntil(this.ensureRefreshed());
  },
  ensureRefreshed() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  },
  async refresh() {
    this.latestStatus = 'ready';
  },
};
```

Making `onOpen()` async does not automatically extend the event. A running Worker retains values on `this`; values reset when it stops. Persist durable state in storage.

Workers provide timers, Promise, `console`, `performance`, URL/text encoding (including `TextEncoderStream` and `TextDecoderStream`), Web Crypto, WebAssembly, and project ES modules. They do not provide Page/Widget objects, `window`, `document`, `fetch`, routing, rendering, or media capture.

## Modules, Components, and Resources

- Declare custom components in `usingComponents`; use absolute project paths for shared components.
- Reference a concrete component file: `/components/card/index` can resolve `index.ink`, but `/components/card` does not automatically search for that directory entry. Missing entry, script, or configuration files fail loading.
- Component `lifetimes.ready()` runs once after a frame containing that component is presented. Dynamically mounted components wait for their own frame; updates, moves, and redisplay do not repeat ready. A component removed before presentation receives no late ready callback.
- Project-local ES module resolution is consistent across agent, Page, and Agent Worker entry points.
- Keep packaged images, fonts, audio, and data under project paths such as `/assets/icon.png`.
- Prefer source paths and the project packaging workflow; do not assume direct access to arbitrary device files.

## TypeScript and WebAssembly

Use project-supported `.ts` entry points where declared. Keep public values crossing JavaScript boundaries serializable. For WebAssembly, load packaged modules through the supported module/resource workflow rather than browser-only filesystem assumptions.
