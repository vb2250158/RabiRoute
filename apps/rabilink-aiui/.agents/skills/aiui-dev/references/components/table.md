# Table

`table` renders structured tabular content from column definitions and row data.

## Display a Data Table

```xml
<table
  caption="Scores"
  columns='[{"key":"name","title":"Name"},{"key":"score","title":"Score","align":"right"}]'
  rows='[{"name":"Alice","score":98},{"name":"Bob","score":87}]'
  empty-text="No data"
></table>
```

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | JSON Array | `[]` | Column definitions containing `key` and optional `title` and `align`. |
| `rows` | JSON Array | `[]` | Row objects whose cells are read using column keys. |
| `caption` | String | - | Table caption. |
| `empty-text` | String | - | Text shown when there are no rows; alias is `emptyText`. |

`align` supports `left`, `center`, and `right`. Array and object cells are serialized as JSON text, while non-object rows are ignored.
