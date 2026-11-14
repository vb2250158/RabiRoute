# Card

`card` composes a cover, title, body, and footer into a content card. The cover, title, and footer are optional, while authored child nodes form the body.

## Present a Content Card with a Cover

```xml
<card cover="assets/cover.jpg" title="Today's pick" footer="Updated just now">
  <text>Card body content.</text>
</card>
```

## Present a Compact Information Card

```xml
<card title="Device status">
  <text>Running normally</text>
</card>
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `cover` | String | - | Path or URL for the top cover image. |
| `title` | String | - | Title text. |
| `footer` | String | - | Supporting text at the bottom. |

Properties support WXML data binding. Internal styling can be adjusted with CSS custom properties including `--card-cover-height`, `--card-padding`, `--card-title-*`, `--card-footer-*`, and `--card-divider-*`.
