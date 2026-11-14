# Chart

Use `chart` to display array data as a line, area, bar, scatter, pie, radar, or funnel chart. You provide the data and chart type instead of drawing the result manually with Canvas.

## Draw Your First Chart

This line chart reads the `value` field from each data item:

```xml
<chart
  class="trend-chart"
  type="line"
  series="value"
  data="{{chartData}}"
></chart>
```

```javascript
export default {
  data: {
    chartData: [
      { label: 'Mon', value: 120 },
      { label: 'Tue', value: 168 },
      { label: 'Wed', value: 142 },
      { label: 'Thu', value: 196 }
    ]
  }
};
```

```css
.trend-chart {
  width: 350px;
  height: 180px;
}
```

`data` accepts an array. `series="value"` tells the chart to use the `value` field from each item. Set the chart size with CSS rather than chart-specific width and height properties.

## Choose a Chart Type

| What you want to show | Recommended chart | `type` value |
| --- | --- | --- |
| Change over time | Line or area | `line`, `area` |
| Values across categories | Bar | `bar` |
| Distribution between two values | Scatter | `scatter` |
| Parts of a whole | Pie | `pie` |
| Several dimensions | Radar | `radar` |
| Values across process stages | Funnel | `funnel` |

Change `type` to switch the basic chart type:

```xml
<chart type="bar" series="value" data="{{chartData}}"></chart>
```

## Display Multiple Series

When one chart needs several data series, set `series` to a JSON array. Each item needs at least a `yName` for the numeric field. `xName` identifies the horizontal-axis field.

```xml
<chart
  type="line"
  data="{{weatherData}}"
  series='[
    {"xName":"day","yName":"high","color":"#ff6b6b","smooth":true},
    {"xName":"day","yName":"low","color":"#4dabf7","smooth":true}
  ]'
></chart>
```

```javascript
export default {
  data: {
    weatherData: [
      { day: 'Mon', high: 26, low: 18 },
      { day: 'Tue', high: 28, low: 19 },
      { day: 'Wed', high: 25, low: 17 }
    ]
  }
};
```

Each series may also provide its own array through `dataSource`, and use `width` to set its line width.

## Show a Horizontal Bar Chart with Values

Bars are vertical by default. Set `direction="horizontal"` when category names are long and need more room.

```xml
<chart
  type="bar"
  direction="horizontal"
  series="value"
  data="{{ranking}}"
  show-value-labels="true"
></chart>
```

`show-value-labels` displays each value next to its shape. Use `value-label-format` to format the text, for example `percent` for a percentage or `compact` for abbreviated large values.

## Configure the Axes

`x-axis` and `y-axis` accept JSON objects. Common settings include the title, minimum and maximum values, labels, and grid lines.

```xml
<chart
  type="line"
  data="{{chartData}}"
  series='[{"xName":"label","yName":"value"}]'
  x-axis='{"title":"Date","showGridLines":false}'
  y-axis='{"title":"Requests","minimum":0,"showGridLines":true}'
></chart>
```

When axis settings are omitted, the component chooses defaults from the data. Beginners usually do not need to configure the axes immediately.

## Common Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | String | `line` | `line`, `area`, `bar`, `scatter`, `pie`, `radar`, or `funnel`. |
| `data` | Array | `[]` | Data array used by the chart. |
| `series` | String / JSON Array | `value` | Numeric field name or a multiple-series configuration. |
| `color` | String | Theme color | Main color for a single series. |
| `animate` | Boolean | `false` | Whether to animate the initial drawing and data changes. |
| `smooth` | Boolean | `true` | Whether line and area charts use smooth curves. |
| `show-average` | Boolean | `false` | Whether line and area charts show a dashed average line. `showAverage` is also accepted. |
| `direction` | String | `vertical` | Bar direction: `vertical` or `horizontal`. |
| `show-value-labels` | Boolean | `false` | Whether values are shown next to their shapes. `showValueLabels` is also accepted. |
| `value-label-format` | String | - | Value text format: `number`, `grouped`, `percent`, `compact`, `integer`, or `datetime`. `valueLabelFormat` is also accepted. |
| `value-label-color` | String | Theme text color | Value text color. `valueLabelColor` is also accepted. |
| `x-axis` | JSON Object | Default x-axis | Horizontal-axis settings. `xAxis` is also accepted. |
| `y-axis` | JSON Object | Default y-axis | Vertical-axis settings. `yAxis` is also accepted. |

## Properties for Specific Chart Types

These properties only affect the listed chart types. Ignore them when they are not needed.

| Chart | Property | Default | Description |
| --- | --- | --- | --- |
| Scatter, radar | `point-size` | `4` | Point size. `pointSize` is also accepted. |
| Scatter, radar | `point-color` | Theme color | Point color. `pointColor` is also accepted. |
| Pie | `show-percentage` | `false` | Whether percentages are displayed. `showPercentage` is also accepted. |
| Pie | `max-disk-diameter` | - | Maximum pie disk diameter. `maxDiskDiameter` is also accepted. |
| Pie | `min-radius` | - | Minimum pie radius. `minRadius` is also accepted. |
| Radar, funnel | `label-key` | - | Data field used as the item name. `labelKey` is also accepted. |
| Funnel | `value-key` | - | Data field used as the numeric value. `valueKey` is also accepted. |
| Radar | `levels` | Theme default | Number of grid levels. |
| Radar | `show-points` | Theme default | Whether data points are displayed. `showPoints` is also accepted. |
| Radar | `max` | Calculated | Maximum radar value. |
| Funnel | `show-conversion` | `true` | Whether stage conversion rates are displayed. `showConversion` is also accepted. |
| Funnel | `funnel-conversion-key` | - | Data field containing a precomputed conversion rate. `funnelConversionKey` is also accepted. |
| Funnel | `funnel-conversion-title` | `转化率` | Conversion-rate title. `funnelConversionTitle` is also accepted. |

Charts also read color, line, and text settings from the current theme. Start with the defaults, then override colors such as `color`, `label-color`, `grid-color`, or `fill-color` only when the visual design requires it.

## `series` Configuration

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `yName` | String | Yes | Numeric field name. `yKey` is also accepted. |
| `xName` | String | No | Horizontal-axis field name. `xKey` is also accepted. |
| `dataSource` | Array | No | Separate data array for this series. |
| `color` | String | No | Color for this series. |
| `width` | Number | No | Line width. |
| `smooth` | Boolean | No | Whether this line is smooth. |

## Axis Configuration

Both `x-axis` and `y-axis` support these common fields:

| Field | Type | Description |
| --- | --- | --- |
| `minimum` / `maximum` | Number | Minimum and maximum axis values. `y-axis` also accepts `min` and `max`. |
| `showAxisLine` | Boolean | Whether the axis line is visible. |
| `showGridLines` | Boolean | Whether grid lines are visible. |
| `showLabels` | Boolean | Whether labels are visible. |
| `showTicks` | Boolean | Whether tick marks are visible. |
| `tickCount` | Number | Preferred number of ticks. |
| `tickLength` | Number | Length of each tick mark. |
| `title` | String | Axis title. |
| `labelFormat` | String | Label format. `format` is also accepted. |
| `opposedPosition` | Boolean | Whether the axis appears on the opposite side. |

`y-axis` additionally supports `interval` and `stripLines`. `x-axis` additionally supports `valueType` and `intervalType`.

Vertical bar charts also support `show-value-labels="true"`,
`value-label-format`, and `value-label-color`. Labels follow bar positions
and data animation without changing bar colors.
