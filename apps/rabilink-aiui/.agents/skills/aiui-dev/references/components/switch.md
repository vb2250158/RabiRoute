# Switch

`switch` toggles a boolean state and can also use a checkbox appearance.

## Toggle a Setting

```xml
<switch checked="{{enabled}}" color="#04C160" bindchange="handleChange" />
```

```javascript
export default {
  data: { enabled: false },
  handleChange(event) {
    this.setData({ enabled: event.detail.value });
  },
};
```

## Display a Checkbox

```xml
<switch type="checkbox" checked="{{accepted}}" bindchange="handleAccept" />
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `checked` | Boolean | `false` | Current selection state. Both `true` and `1` are treated as selected. |
| `disabled` | Boolean | `false` | Whether toggling is disabled. |
| `type` | String | `switch` | Uses a checkbox appearance when set to `checkbox`. |
| `color` | String | `#04C160` | Selected-state color; CSS colors and custom properties are supported. |

## Events

| Event | Event Data | Description |
| --- | --- | --- |
| `bindchange` | `{ detail: { value: boolean } }` | Fires after a user click or touch ends. It does not fire while disabled. |
