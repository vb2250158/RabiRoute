<!-- docs-language-switch -->
<div align="center">
English | <a href="./aiui-canvas-2d-reference.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# AIUI Canvas 2D API Quick Reference

This document records the web-standard-style Canvas 2D drawing interface provided by the AIUI `canvas` component and defines its usage boundaries for Rokid monochrome glasses and RabiLink. For guidance on choosing base components, see [AIUI Framework and Logic Development Notes](aiui-framework-and-logic-development_en.md).

## 1. Obtain the Drawing Context

```xml
<canvas id="myCanvas" width="300" height="150"></canvas>
```

```javascript
const canvas = this.selectComponent("#myCanvas");
const ctx = canvas.getContext("2d");
```

- `width` and `height` define the pixel dimensions of the drawing buffer.
- Call `selectComponent()` only after the Canvas component has been created. Do not assume in `onLoad()` that the view already exists.
- Store the `canvas`, `ctx`, images, and ImageData on the Page instance (`this`), not in JSON-serializable `data`.

## 2. `CanvasRenderingContext2D` Properties

| Property | Type | Description | Common values |
| --- | --- | --- | --- |
| `fillStyle` | String / CanvasGradient / CanvasPattern | Fill style | Color, gradient, pattern |
| `strokeStyle` | String / CanvasGradient / CanvasPattern | Stroke style | Color, gradient, pattern |
| `lineWidth` | Number | Line width | Positive number |
| `lineCap` | String | Line-end style | `butt`, `round`, `square` |
| `lineJoin` | String | Line-join style | `miter`, `round`, `bevel` |
| `lineDashOffset` | Number | Dash offset | Number |
| `shadowBlur` | Number | Shadow blur radius | Non-negative number |
| `shadowColor` | String | Shadow color | Color string |
| `shadowOffsetX` | Number | Horizontal shadow offset | Number |
| `shadowOffsetY` | Number | Vertical shadow offset | Number |
| `globalAlpha` | Number | Global opacity | `0.0` to `1.0` |
| `globalCompositeOperation` | String | Layer compositing mode | `source-over`, `copy`, `lighter`, `multiply`, and others |
| `font` | String | Current font | For example, `20px sans-serif` |
| `textAlign` | String | Horizontal alignment | `left`, `center`, `right`, `start`, `end` |
| `textBaseline` | String | Text baseline | `top`, `middle`, `bottom`, `alphabetic`, and others |

Rokid monochrome-green displays cannot reliably represent hue differences such as red versus blue. Even though the API accepts full color strings, design meaning must still be conveyed through brightness, opacity, line style, shape, and text.

## 3. Rectangles and Text

| Method | Purpose |
| --- | --- |
| `fillRect(x, y, width, height)` | Draw a filled rectangle |
| `strokeRect(x, y, width, height)` | Draw a rectangle outline |
| `clearRect(x, y, width, height)` | Clear the specified region |
| `fillText(text, x, y, maxWidth?)` | Draw filled text |
| `strokeText(text, x, y, maxWidth?)` | Draw outlined text |
| `measureText(text)` | Measure text and return a result containing `width` |

```javascript
ctx.fillStyle = "#40ff5e";
ctx.fillRect(10, 10, 100, 48);

ctx.font = "24px sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("RabiLink", 60, 34, 96);
```

Canvas text does not wrap, truncate, or participate in WXML layout automatically. Use `measureText()` to calculate width before drawing. Multilingual content, font fallback, and physical-device glyph rendering still require real verification. Prefer the `text` component for ordinary HUD text.

## 4. Paths

| Method | Purpose |
| --- | --- |
| `beginPath()` | Begin a new path |
| `closePath()` | Close the current path |
| `moveTo(x, y)` | Move the path origin |
| `lineTo(x, y)` | Draw a line from the current point |
| `arc(x, y, r, start, end, anticlockwise?)` | Draw a circular arc |
| `arcTo(x1, y1, x2, y2, r)` | Draw a tangent arc between two line segments |
| `rect(x, y, width, height)` | Add a rectangle to the current path |
| `ellipse(x, y, rx, ry, rotation, start, end, anticlockwise?)` | Draw an ellipse |
| `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)` | Draw a cubic Bezier curve |
| `quadraticCurveTo(cpx, cpy, x, y)` | Draw a quadratic Bezier curve |
| `fill()` | Fill the current path |
| `stroke()` | Stroke the current path |
| `clip()` | Use the current path to clip subsequent drawing |

```javascript
ctx.beginPath();
ctx.arc(60, 60, 40, 0, Math.PI * 2);
ctx.strokeStyle = "#40ff5e";
ctx.lineWidth = 3;
ctx.stroke();
```

Call `beginPath()` before each independent shape so that a previous path is not accidentally filled or stroked again. Because `clip()` changes the drawing region for subsequent operations, it should usually be paired with `save()` and `restore()`.

## 5. State and Transforms

| Method | Purpose |
| --- | --- |
| `save()` | Save the current drawing state |
| `restore()` | Restore the most recently saved state |
| `translate(dx, dy)` | Translate the coordinate system |
| `rotate(angle)` | Rotate the coordinate system in radians |
| `scale(sx, sy)` | Scale the coordinate system |

```javascript
ctx.save();
ctx.translate(100, 100);
ctx.rotate(Math.PI / 4);
ctx.scale(1.5, 1.5);
ctx.fillStyle = "#40ff5e";
ctx.fillRect(-25, -25, 50, 50);
ctx.restore();
```

Wrap local transforms in `save()` and `restore()` so that coordinate systems, opacity, clipping, and styles do not leak into later drawing. An animation loop must not call `save()` without a bounded matching `restore()`.

## 6. Images and Pixels

| Method | Purpose |
| --- | --- |
| `drawImage(image, ...args)` | Draw an image or another Canvas using the 3-, 5-, or 9-argument form |
| `createImageData(width, height)` | Create blank ImageData |
| `getImageData(x, y, width, height)` | Read RGBA pixels from the specified region |
| `putImageData(data, x, y)` | Write ImageData back to the canvas |

`ImageData` contains:

- `width`: image width.
- `height`: image height.
- `data`: a `Uint8ClampedArray` containing pixels in RGBA order.

Pixel reads and writes usually incur significant synchronous copy costs. Do not call `getImageData()` or `putImageData()` on every frame of a persistent HUD. Use them only for debug sampling, low-frequency analysis, or necessary local processing, and keep the region small.

The project's Craft redraw acceptance test uses `getImageData()` on the host Canvas, freezes one frame, and then analyzes pixel bands. That is test-tool behavior and must not be copied into glasses runtime code.

## 7. Gradients and Patterns

| Method | Purpose |
| --- | --- |
| `createLinearGradient(x0, y0, x1, y1)` | Create a linear gradient |
| `createRadialGradient(x0, y0, r0, x1, y1, r1)` | Create a radial gradient |
| `createPattern(image, repetition)` | Create a repeating pattern |

Use `CanvasGradient.addColorStop(offset, color)` to add color stops from `0.0` to `1.0`.

```javascript
const gradient = ctx.createLinearGradient(0, 0, 300, 0);
gradient.addColorStop(0, "rgba(64, 255, 94, 0.2)");
gradient.addColorStop(1, "#40ff5e");
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, 300, 40);
```

A `CanvasPattern` represents a repeating pattern, and its transform can be adjusted with `setTransform(matrix)`. Patterns and complex gradients increase drawing cost. RabiLink's monochrome HUD does not use decorative gradients or textures.

## 8. Compositing and Shadows

- Use `globalAlpha` to lower opacity uniformly for a drawing phase, then restore it afterward.
- `globalCompositeOperation` supports overlay, copy, and blending behavior. Verify non-basic modes on a physical device with the target Ink version.
- Shadow blur is generally more expensive than ordinary fills and strokes. Persistent wearable displays should avoid large-radius shadows and multiple stacked layers.
- Opacity levels are more predictable than color blending on a monochrome device.

## 9. Recommended Redraw Template

```javascript
redrawChart(points) {
  const canvas = this.chartCanvas || this.selectComponent("#chartCanvas");
  if (!canvas) return;
  this.chartCanvas = canvas;
  const ctx = this.chartContext || canvas.getContext("2d");
  this.chartContext = ctx;

  ctx.clearRect(0, 0, 300, 120);
  if (!Array.isArray(points) || points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = "#40ff5e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}
```

Redraw only when data actually changes. Release old references and obtain the context again after the page is hidden or unloaded, or after the Canvas dimensions change.

## 10. RabiLink Decisions

- The current main HUD does not use a page-level Canvas.
- Do not draw branding, the mode track, status text, the clock, the version, or the battery with Canvas.
- Do not fabricate an ASR waveform when no PCM or volume API is available.
- Future charts or sensor visualizations should use a fixed independent region, ordinary text values, and low-frequency redraws.
- A Canvas failure must leave a readable static status; core interaction must not depend on an empty canvas.
