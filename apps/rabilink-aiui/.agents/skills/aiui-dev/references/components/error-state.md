# ErrorState

Use `error-state` when a page cannot show its normal content and needs to explain what happened. Typical uses include a failed network request, an empty search result, or a screen with no data yet.

## Show a Message

Set the message with `text`:

```xml
<error-state text="Unable to load. Please try again later."></error-state>
```

## Add an Icon

Use `icon` to display an image to the left of the message. It accepts a local image path or a network URL.

```xml
<error-state
  icon="/assets/network-error.png"
  text="No network connection. Check your connection and try again."
></error-state>
```

When `icon` is omitted, the component only displays the message. You can place it next to a button when the user needs a retry action:

```xml
<view class="error-panel">
  <error-state text="Unable to load content"></error-state>
  <button bindtap="retry">Reload</button>
</view>
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `text` | String | `""` | Message displayed by the component. |
| `icon` | String | - | Image path or URL displayed to the left of the message. |

`error-state` does not support `title` or `description`. To display a separate title and description, compose them with `view` and `text`.
