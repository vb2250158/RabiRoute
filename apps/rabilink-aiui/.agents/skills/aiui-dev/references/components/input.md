# Input

`input` accepts a single line of text and displays an input cursor while focused.

## Enter and Synchronize Text

```xml
<input value="{{query}}" placeholder="Search" maxLength="100" bindinput="handleInput" />
```

```javascript
export default {
  data: { query: '' },
  handleInput(event) {
    this.setData({ query: event.detail.value });
  },
};
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `value` | String | `""` | Current text. |
| `placeholder` | String | `""` | Hint shown while the field is empty and unfocused. |
| `disabled` | Boolean | `false` | Whether keyboard input is ignored. |
| `maxLength` | Number | - | Maximum number of accepted characters. |

Placeholder color resolves from `--input-placeholder-color`, then `--color-text-secondary`, and finally the built-in gray fallback.

## Events

| Event | Event Data | Description |
| --- | --- | --- |
| `bindinput` | `{ detail: { value: string } }` | Fires whenever the text changes. |

`event.detail.value` is the full updated text, including additions and
deletions. Replace the bound value with it rather than appending it as a delta.
