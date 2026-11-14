# LottieView Lottie Animation

The `lottie-view` component is used to render Lottie animations, a JSON-based animation format exported from After Effects.

## Usage

```xml
<lottie-view 
  src="assets/animation.json" 
  auto-play="true" 
  loop="true" 
  speed="1.0"
  width="200"
  height="200"
></lottie-view>
```

## Properties

| Property | Type | Description | Default |
|-----------|------|-------------|---------|
| `src` | String | The path or URL of the Lottie JSON file. | `""` |
| `auto-play` | Boolean | Whether to automatically start playback after loading is complete. | `true` |
| `loop` | Boolean | Whether to loop the animation after it reaches the end. | `true` |
| `speed` | Number | The animation playback speed multiplier (for example, `1.0` is normal speed). | `1.0` |
| `progress` | Number | The value used to manually control animation progress (from `0.0` to `1.0`). | `None` |

## Events

Currently, the `lottie-view` component does not expose public events to WXML/JS and mainly handles loading-related events internally.

## Bound Attributes in Projected Content

Slot/template content uses the current resolved attributes. Updating bound
`src` or playback/display settings through `setData()` updates projected
content without recreating the custom component.
