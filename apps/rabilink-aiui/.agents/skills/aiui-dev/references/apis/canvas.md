# AIUI Canvas and Barcode API Reference

This file documents the verified Canvas and barcode APIs available to AIUI agent code.

- Common scope, entry points, and authoring rules live in [apis.md](./index.md).
- Do not infer standard Web API behavior unless it is explicitly listed here or in the index file.
- Do not add browser-compatible overloads or semantics that are not present in the source.

## Encoded Canvas Output

`canvas.convertToBlob({ type?, quality? })` asynchronously encodes a stable
snapshot of the current Canvas pixels as a `Blob`. PNG is the default and
fallback for unsupported types. PNG retains alpha; JPEG composites transparent
pixels over black. Keep encoded image bytes distinct from `ImageBitmap` pixel
data.

`quality` is a JPEG value from `0` to `1`. For an open `ImageBitmap`, use global
`createImageBlob(bitmap, { type?, quality? }): Promise<Blob>` without creating
a Canvas. It has the same PNG/JPEG selection. Close the bitmap after encoding
completes; closed input rejects with `InvalidStateError`, unsupported native
external/GPU pixels with `NotSupportedError`, and a full encoding queue with
`EncodingError`.

## `CanvasRenderingContext2D`

`CanvasRenderingContext2D` cannot be constructed directly. Its constructor panics if called directly. Always obtain it from `canvas.getContext('2d')` or `wx.createCanvasContext(id)`.

### Properties

#### Style properties

- `fillStyle`
- `strokeStyle`

Getter behavior:

- Returns either a color string, a `CanvasGradient`, or a `CanvasPattern`.

Setter behavior:

- Accepts a color string.
- Accepts a `CanvasGradient`.
- Accepts a `CanvasPattern`.
- Unsupported values are ignored.

Color strings are only parsed in these forms:

- `#rrggbb`
- `#rgb`
- `rgb(r, g, b)`
- `rgba(r, g, b, a)`
- `black`
- `white`
- `red`
- `green`
- `blue`
- `yellow`
- `transparent`

#### Line and shadow properties

- `lineWidth`
- `lineCap`
- `lineJoin`
- `lineDashOffset`
- `shadowBlur`
- `shadowColor`
- `shadowOffsetX`
- `shadowOffsetY`
- `globalAlpha`
- `globalCompositeOperation`

Value behavior:

- `lineCap` supports `butt`, `round`, `square`; unknown values fall back to `butt`.
- `lineJoin` supports `miter`, `round`, `bevel`; unknown values fall back to `miter`.
- `shadowColor` uses the same limited color parsing as `fillStyle`.
- `globalCompositeOperation` supports only the values mapped in the implementation:
  - `source-over`
  - `source-in`
  - `source-out`
  - `source-atop`
  - `copy`
  - `destination-over`
  - `destination-in`
  - `destination-out`
  - `destination-atop`
  - `xor`
  - `lighter`
  - `multiply`
  - `screen`
  - `overlay`
  - `darken`
  - `lighten`
  - `color-dodge`
  - `color-burn`
  - `hard-light`
  - `soft-light`
  - `difference`
  - `exclusion`
  - `hue`
  - `saturation`
  - `color`
  - `luminosity`
- Unknown `globalCompositeOperation` values fall back to `source-over`.

#### Text properties

- `font`
- `textAlign`
- `textBaseline`
- `letterSpacing` and `wordSpacing` (for example, `'2px'`)
- `direction`: `ltr`, `rtl`, or `inherit`
- `filter`
- `imageSmoothingEnabled`
- `imageSmoothingQuality`: `low`, `medium`, or `high`

Value behavior:

- `textAlign` supports `left`, `center`, `right`, `start`, `end`; unknown values fall back to `start`.
- `textBaseline` supports `top`, `hanging`, `middle`, `alphabetic`, `ideographic`, `bottom`; unknown values fall back to `alphabetic`.

### Methods

#### Rect and basic drawing

- `fillRect(x, y, width, height)`
- `strokeRect(x, y, width, height)`
- `clearRect(x, y, width, height)`

#### Path construction

- `beginPath()`
- `moveTo(x, y)`
- `lineTo(x, y)`
- `arc(x, y, radius, startAngle, endAngle, anticlockwise?)`
- `rect(x, y, width, height)`
- `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise?)`
- `arcTo(x1, y1, x2, y2, radius)`
- `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)`
- `quadraticCurveTo(cpx, cpy, x, y)`
- `closePath()`
- `roundRect(x, y, width, height, radii?)`

Argument behavior:

- `arc()` and `ellipse()` use `false` when `anticlockwise` is omitted.
- `roundRect()` accepts a number, elliptical `{ x, y }` radius, or iterable of 1–4 such entries; omitted radii default to `0`. Negative values, empty collections, or more than four entries throw `RangeError`. It only adds a path; call `fill()` / `stroke()` to draw it.

#### Path painting and clipping

- `clip(...args)`
- `fill(...args)`
- `stroke(...args)`

Argument behavior:

- `clip()` accepts either:
  - `clip()`
  - `clip(fillRule)`
  - `clip(path)`
  - `clip(path, fillRule)`
- `fill()` accepts either:
  - `fill()`
  - `fill(fillRule)`
  - `fill(path)`
  - `fill(path, fillRule)`
- `stroke()` accepts either:
  - `stroke()`
  - `stroke(path)`
- Supported `fillRule` strings are only `nonzero` and `evenodd`.

#### Text

- `measureText(text)`
- `fillText(text, x, y, maxWidth?)`
- `strokeText(text, x, y, maxWidth?)`

Return behavior:

- `measureText(text)` returns `TextMetrics`: width, actual/font bounds, em heights, and baselines. Metrics depend on current font, alignment, and direction and match text layout. For example, read `width`, `actualBoundingBoxAscent`, and `actualBoundingBoxDescent`.

#### State and transform

- `save()`
- `restore()`
- `translate(dx, dy)`
- `rotate(angle)`
- `scale(sx, sy)`
- `transform(a, b, c, d, e, f)`
- `setTransform(...args)`
- `resetTransform()`
- `getTransform()`

Behavior notes:

- `rotate(angle)` expects radians.
- `transform(a, b, c, d, e, f)` always takes six numeric arguments.
- `setTransform(...args)` delegates to the DOM matrix argument parser used by the runtime. Do not assume browser-complete overload coverage beyond what the parser accepts.
- `getTransform()` returns a `DOMMatrixReadOnly` object.

#### Line dash

- `setLineDash(dashArray)`
- `getLineDash()`

#### Hit testing

- `isPointInPath(...args)`
- `isPointInStroke(...args)`

Argument behavior:

- `isPointInPath()` accepts either:
  - `isPointInPath(x, y)`
  - `isPointInPath(x, y, fillRule)`
  - `isPointInPath(path, x, y)`
  - `isPointInPath(path, x, y, fillRule)`
- `isPointInStroke()` accepts either:
  - `isPointInStroke(x, y)`
  - `isPointInStroke(path, x, y)`
- If fewer than the required coordinate arguments are provided, the runtime throws.

#### Image data

- `createImageData(width, height)`
- `getImageData(x, y, width, height)`
- `putImageData(imageData, x, y)`

#### Gradients and patterns

- `createLinearGradient(x0, y0, x1, y1)`
- `createRadialGradient(x0, y0, r0, x1, y1, r1)`
- `createConicGradient(startAngle, x, y)`
- `createPattern(image, repetition)`

Behavior notes:

- `createPattern(image, repetition)` snapshots a Canvas source. Repetition is `repeat`, `repeat-x`, `repeat-y`, or `no-repeat`; `''` means `repeat`. Invalid repetition throws `SyntaxError`. Do not assume other source types work.

#### Image drawing

- `drawImage(image, dx, dy)`
- `drawImage(image, dx, dy, dw, dh)`
- `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`

Behavior notes:

- `drawImage()` accepts Canvas and open `ImageBitmap` sources. A closed `ImageBitmap` throws `InvalidStateError`; create another bitmap before drawing again.
- Only the 3-argument, 5-argument, and 9-argument forms are implemented.

#### Flush

- `flush()`
- For mounted Page canvases, obtain the context with `wx.createCanvasContext('id')` (no `#`); it returns `null` when no matching Canvas is available. Call `flush()` after a drawing batch.

#### Context management

- `reset()` restores the initial state and clears the Canvas.
- `getContextAttributes()` and `isContextLost()` inspect context settings/status.

### Dirty-mark behavior

When the context is bound to a page canvas node through `wx.createCanvasContext(id)`, these methods mark the page node dirty:

- `fillRect`
- `strokeRect`
- `clearRect`
- `arc`
- `rect`
- `ellipse`
- `arcTo`
- `bezierCurveTo`
- `quadraticCurveTo`
- `fill`
- `stroke`
- `fillText`
- `strokeText`
- `flush`
- `drawImage`
- `putImageData`

## `CanvasGradient`

### Methods

- `addColorStop(offset, color)`

### Behavior

- `color` uses the same limited parser as `fillStyle`.
- If the color string cannot be parsed, the call does nothing.

## `CanvasPattern`

### Methods

- `setTransform(matrix)`

### Behavior

- The runtime attempts to parse `matrix` as a DOM matrix object.
- If parsing fails, it falls back to the default transform.

## `ImageData`

### Constructor

- `new ImageData(width, height)`

### Properties

- `width`
- `height`
- `data`

### Behavior

- `data` is exposed as a typed byte array.
- The buffer length is initialized to `width * height * 4`.

## `Path2D`

### Constructor

- `new Path2D()`
- `new Path2D(path)`
- `new Path2D(svgPathString)`

### Methods

- `moveTo(x, y)`
- `lineTo(x, y)`
- `rect(x, y, width, height)`
- `roundRect(x, y, width, height, radii?)`
- `closePath()`
- `arc(x, y, radius, startAngle, endAngle, anticlockwise?)`
- `arcTo(x1, y1, x2, y2, radius)`
- `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)`
- `quadraticCurveTo(cpx, cpy, x, y)`
- `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise?)`
- `addPath(path, transform?)`
- `toString()`

### Behavior

- `new Path2D(path)` clones another `Path2D`.
- `new Path2D(svgPathString)` parses SVG path data. Parse failure throws.
- Passing any other constructor value throws.
- `arc()` and `ellipse()` use `false` when `anticlockwise` is omitted.
- `addPath(path, transform?)` requires the first argument to be a `Path2D`.
- `addPath(path, transform?)` throws when `transform` is present but is not an accepted DOM matrix object.
- `toString()` returns SVG path data.
- `roundRect()` uses the same scalar, elliptical, or 1–4 entry radii rules and `RangeError` checks as the 2D context.

## `BarcodeDetector`

### Constructor

- `new BarcodeDetector()`
- `new BarcodeDetector(options)`

### Constructor options

- `formats`

Behavior notes:

- `options` is optional.
- `formats`, when supplied, must be a nonempty array of supported canonical names. Empty lists, unknown names, and `'unknown'` are invalid; do not rely on silently ignoring them.
- Omit `formats` to use the runtime's default detection set. Query `getSupportedFormats()` before selecting a subset.

### Static methods

- `BarcodeDetector.getSupportedFormats()`

Return behavior:

- `getSupportedFormats()` returns a `Promise`.
- The promise resolves to an array of strings.
- Prefer these canonical Web names, such as `qr_code`, `code_128`, and `ean_13`; detection results use canonical `format` names. Do not assume arbitrary platform/library aliases work.

### Instance methods

- `detect(image)`

Argument behavior:

- Prefer an `ImageData`, encoded-image `Blob`, or open `ImageBitmap`.
- A legacy raw object requires `width`, `height`, and `data` as an ArrayBuffer or byte typed array; do not confuse raw pixels with encoded photo bytes.
- `OffscreenCanvas`, `VideoFrame`, and HTML/SVG image, video, or Canvas elements are outside the supported input surface.

Return behavior:

- `detect(image)` returns a `Promise`.
- The promise resolves to an array of result objects with:
  - `format`
  - `rawValue`
  - `boundingBox`: `DOMRectReadOnly`
  - `cornerPoints`: four `{ x, y }` coordinates

Error behavior:

- Invalid inputs, closed bitmaps, malformed images, and missing legacy raw-object fields can fail; handle synchronous errors and Promise rejection.
