# Canvas

The `canvas` component provides a 2D drawing context, similar to the `<canvas>` element in HTML5. It allows 2D shapes and bitmap images to be rendered dynamically through scripts.

## Usage

```xml
<canvas id="myCanvas" width="300" height="150"></canvas>
```

After the component has mounted, draw in your JavaScript:

```javascript
// Get the 2D drawing context by element ID (without '#')
const ctx = wx.createCanvasContext('myCanvas');

ctx.fillStyle = 'red';
ctx.fillRect(10, 10, 150, 75);

ctx.flush();
```

## Properties

| Property | Type | Description | Default |
|-----------|------|-------------|---------|
| `width` | Number | The pixel width of the canvas. | `300` |
| `height` | Number | The pixel height of the canvas. | `150` |

## API

Use `wx.createCanvasContext(canvasId)` to obtain the page canvas's 2D drawing context. Pass the element ID without a `#` prefix; the method returns `null` if no matching canvas is available. Draw using the Canvas 2D API, then call `ctx.flush()` to submit the drawing operations.

For API details, use the [Canvas runtime reference](../apis/canvas.md).
