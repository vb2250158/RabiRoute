# Video

`video` plays video resources and automatically pauses or resumes playback with page and viewport visibility.

## Play a Video

```xml
<video
  id="preview"
  src="https://example.com/video.mp4"
  poster="assets/poster.jpg"
  autoplay="true"
  object-fit="contain"
  bindtimeupdate="handleTimeUpdate"
  bindended="handleEnded"
></video>
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | String | `""` | Video resource URL. |
| `poster` | String | `""` | Image shown before video frames are available. |
| `autoplay` | Boolean | `false` | Whether playback starts automatically. |
| `loop` | Boolean | `false` | Whether playback loops. |
| `muted` | Boolean | `false` | Whether audio is muted. |
| `volume` | Number | `1` | Volume clamped to `0` through `1`. |
| `playback-rate` | Number | `1` | Playback rate. |
| `start-time` | Number | `0` | Initial playback position in seconds. |
| `preload` | String | `metadata` | Preload policy: `none`, `metadata`, or `auto`. |
| `object-fit` | String | `contain` | Frame fitting: `contain`, `cover`, or `fill`. |
| `render-mode` | String | `normal` | Set to `wireframe` to enable wireframe preview. |

Wireframe mode also supports `wireframe-threshold`, `wireframe-thickness`, `wireframe-invert`, and `wireframe-quality`.

## Events

Use `bind<event>` or `catch<event>` for `loadstart`, `loadedmetadata`, `canplay`, `play`, `playing`, `pause`, `waiting`, `stalled`, `seeking`, `seeked`, `timeupdate`, `ended`, `volumechange`, `ratechange`, and `error`. `timeupdate` returns `{ currentTime }`; `error` returns `{ message }`.
