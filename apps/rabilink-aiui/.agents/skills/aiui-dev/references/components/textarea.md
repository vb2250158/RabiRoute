# Textarea

`textarea` edits multiline text containing line breaks and displays an input cursor while focused.

## Edit Multiline Content

```xml
<textarea value="{{notes}}" placeholder="Add notes" maxLength="500" bindinput="handleInput" />
```

```javascript
export default {
  data: { notes: '' },
  handleInput(event) {
    this.setData({ notes: event.detail.value });
  },
};
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `value` | String | `""` | Current text, which may contain line breaks. |
| `placeholder` | String | `""` | Hint shown while the field is empty and unfocused. |
| `disabled` | Boolean | `false` | Whether keyboard input is ignored. |
| `maxLength` | Number | - | Maximum number of accepted characters. |

The component renders line breaks with `white-space: pre-wrap`. Placeholder colors follow the same rules as `input`.

## Events

| Event | Event Data | Description |
| --- | --- | --- |
| `bindinput` | `{ detail: { value: string } }` | Fires whenever the text changes. |

`event.detail.value` is the full updated text, including additions and
deletions. Replace the bound value with it rather than appending it as a delta.
