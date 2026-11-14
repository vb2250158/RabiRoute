# Map

`map` renders a map from MVT vector tiles and can overlay GPX tracks and waypoints.

## Display a Specific Area

```xml
<map
  tile-url="https://tiles.example.com/{z}/{x}/{y}.mvt"
  longitude="116.397"
  latitude="39.908"
  zoom="12"
  style="width: 640px; height: 360px;"
></map>
```

The tile URL must contain `{z}`, `{x}`, and `{y}` placeholders. The map uses its final layout size, falling back to `300 × 200` when no layout size is available.

## Overlay a GPX Track

```xml
<map tile-url="https://tiles.example.com/{z}/{x}/{y}.mvt" style="width: 640px; height: 360px;">
  <map-gpx slot="overlays" src="https://example.com/route.gpx" stroke-color="#2563eb" />
</map>
```

When `longitude`, `latitude`, or `zoom` is omitted, the component fills the missing viewport values from loaded GPX content. `map-gpx` can also receive inline GPX XML through `data`.

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `tile-url` | String | `""` | MVT tile template; aliases are `url` and `src`. |
| `longitude` | Number | Auto | Center longitude clamped to `-180` through `180`; aliases are `lng` and `center-longitude`. |
| `latitude` | Number | Auto | Center latitude clamped to the valid Web Mercator range; aliases are `lat` and `center-latitude`. |
| `zoom` | Number | Auto | Rounded zoom level clamped to `0` through `22`. |
| `pitch` | Number | `0` | Pitch clamped to `0` through `60`. |
| `bearing` | Number | `0` | Rotation angle; alias is `rotation`. |
| `map-style` | JSON String | Built in | Map colors and stroke sizing; alias is `style-json`. |

`map-style` supports `background`, `land`, `water`, `road`, `building`, `boundary`, `labelPoint`, `lineWidth`, and `pointRadius`. Map styling is also available through `--map-*` CSS custom properties.

When no GPX content is available for automatic fitting, omitted center coordinates and zoom fall back to `0`.

## `map-gpx` Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `src` | String | - | GPX file URL; alias is `url`. |
| `data` | String | - | Inline GPX XML; alias is `content`, and it takes precedence over `src`. |
| `visible` | Boolean | `true` | Whether to display the overlay. |
| `stroke-color` | String | `#2563eb` | Track color. |
| `stroke-width` | Number | `3` | Track width with a minimum of `1`. |
| `waypoint-color` | String | `#0f172a` | Waypoint color. |
| `start-color` | String | `#16a34a` | Start-point color. |
| `end-color` | String | `#dc2626` | End-point color. |
| `point-radius` | Number | `4` | Point radius with a minimum of `2`. |
| `label-visible` | Boolean | `true` | Whether waypoint labels are visible. |
| `label-color` | String | `#0f172a` | Label color. |
