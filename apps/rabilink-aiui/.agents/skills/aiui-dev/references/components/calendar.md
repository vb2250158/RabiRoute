# Calendar

`calendar` displays a month or week and can parse iCalendar data into date annotations. The current component is display-only and does not expose date-selection events.

## Display a Month

```xml
<calendar value="2026-05-02" today="2026-05-01" locale="en-US" weekStart="monday"></calendar>
```

## Display the Week Containing a Date

```xml
<calendar mode="week" displayDate="2026-05-02" locale="en-US"></calendar>
```

## Annotate Scheduled Dates

```xml
<calendar value="2026-05-02" eventSource="{{calendarData}}"></calendar>
```

`eventSource` accepts raw iCalendar text to generate holiday, workday, and schedule annotations.

## Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | String | `month` | Display mode: `month` or `week`. |
| `value` | String | - | Selected date in ISO date format. |
| `displayDate` | String | - | Visible anchor in ISO date format; falls back to `value`. |
| `today` | String | Current date | ISO date treated as today. |
| `locale` | String | `en` | Supports `zh`, `zh-CN`, `en`, and `en-US`. |
| `weekStart` | String | `monday` | First weekday; supports `0`/`sun`/`sunday` and `1`/`mon`/`monday`. |
| `eventSource` | String | - | Raw iCalendar text. |
