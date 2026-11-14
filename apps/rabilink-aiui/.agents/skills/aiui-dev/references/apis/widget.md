# Widget API Reference

Read [Widget development](../framework.md#widget-development) for declaration,
`.ink` structure, family, placement, and localized metadata. The runtime
creates a Widget instance from a declared entry; the default-exported logic
object uses that instance as `this`.

## Instance properties

| Property | Type | Meaning |
| --- | --- | --- |
| `data` | `object` | Current bound state; defaults to `{}`. |
| `widgetId` | `string` | Stable identifier for this Widget instance. |
| `family` | `'1x1' \| '1x2'` | Declared size category. |
| `target` | `'_widget'` | Widget display target. |
| `isAttached` | `boolean` | Whether the Widget is currently displayed. |
| `interactive` | `boolean` | Whether the Widget currently accepts input. |
| `hostWidth` | `number` | Available width in logical pixels. |
| `hostHeight` | `number` | Available height in logical pixels. |

Properties other than `data` are read-only. Prefer adaptive WXSS layout;
read `hostWidth` and `hostHeight` when content logic depends on actual space.
The family is a category, not a fixed pixel size.

## `this.setData(patch, callback?)`

`patch` must be an object. Top-level keys replace existing values; dot paths
can update nested fields, creating intermediate objects as needed. The optional
callback runs after the data is synchronized to the interface. The method
returns `undefined`; a non-object patch throws.

```javascript
export default {
  data: { status: { label: 'Waiting' } },
  onAttach() {
    this.setData({ 'status.label': 'Visible' }, () => {
      console.log(this.hostWidth, this.hostHeight);
    });
  },
};
```

## Lifecycle callbacks

| Callback | When it runs |
| --- | --- |
| `onCreate(options)` | Once after creation; receives opening URL query parameters as strings, or `{}` if absent. |
| `onAttach()` | When first displayed or displayed again. |
| `onDetach()` | When hidden or before destruction. |
| `onDestroy()` | Once on final destruction. |

Attach and detach may repeat. Pause visible-only work on detach and release
final resources on destroy. A Widget does not receive Page lifecycle callbacks
or Page-only routing, world-awareness, and `finish()` methods. See
[Window](./window.md) for opening or closing an overlay Widget.

For `window.open('widgets/weather/index?city=hangzhou', '_widget')`:

```javascript
export default {
  data: { city: '' },
  onCreate(options) {
    this.setData({ city: options.city ?? 'hangzhou' });
  },
};
```

The path must match a Widget declared in `app.json`.
