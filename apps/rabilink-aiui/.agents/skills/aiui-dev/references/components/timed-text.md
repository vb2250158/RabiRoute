# TimedText

`timed-text` highlights an active range inside complete text, making it suitable for captions synchronized to audio progress.

## Highlight the Current Caption Range

```xml
<timed-text text="Welcome to AIUI" active-start="8" active-length="2"></timed-text>
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `text` | String | `""` | Complete text. |
| `active-start` | Number | `0` | Active-range start as a UTF-16 offset. |
| `active-length` | Number | `0` | Active-range length in UTF-16 code units. |

Regular text uses `--timed-text-color`, defaulting to the current text color at 45% opacity. The active range uses `--timed-text-active-color`, defaulting to the inherited text color.
