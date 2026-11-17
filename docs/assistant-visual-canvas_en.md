English | [简体中文](assistant-visual-canvas.md)

# Voice assistant canvas

The assistant uses `assistant_canvas` to maintain one updateable 16:9 surface. Users request it by voice rather than filling chart parameters. A scene can combine line, area, bar, scatter and pie charts with text, rectangles, ellipses, arrows and tables.

`show` atomically replaces the document; `inspect` reads state; `close` hides it. `persistent: true` survives subsequent turns until the assistant or user closes it. Every model request includes the current canvas state. A temporary canvas hides on the next accepted nonempty speech transcript or new text input. The original reply retains its snapshot. Clearing context clears the active canvas. A stale turn cannot reopen or close a newer surface.

| Host | Presentation |
| --- | --- |
| WebGUI | Temporary charts appear in the reply; persistent charts float independently with drag, enlarge and close controls. |
| Desktop | The chart window docks above captions and follows them. Undocking permits independent movement and resizing; it can dock again. |
| AIUI glasses | A monochrome central surface keeps concise captions below it, without a chat composer. |

The shared SDK owns document validation, drawing and lifetime. Hosts own their existing message stores and windows. Web/Rabi snapshots use the existing encrypted conversation records. AIUI stores persistent state within the current configuration scope. Desktop placement is presentation state only.

Documents use a logical `960×540` coordinate space with proportional scaling. Each node provides `kind,x,y,width,height`. Prefer text of at least 24 logical pixels. Charts use `chartType,labels,series:[{name,values}]`; missing data is `null`. Pie charts require one nonnegative series with a positive total. `title,description,sources:[{label,url}]` describe the basis and provenance. Sources are displayed links, never automatically fetched.

Obtain real data before drawing statistics. Price trends must identify dates, currency, model and quotation basis. A few current search prices are not a historical time series. Do not invent values to complete a chart.

Only structured display data is accepted. No HTML, JavaScript, arbitrary component events or remote images execute. Monochrome series use line styles, markers and numbered labels. This implements the explicitly listed display components, not every AIUI interactive component or arbitrary A2UI commands.
