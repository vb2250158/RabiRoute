# AIUI Canvas and Barcode API Reference

This file documents the verified Canvas and barcode APIs available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
- Do not infer standard Web API behavior unless it is explicitly listed here or in the index file.
- Do not add browser-compatible overloads or semantics that are not present in the source.

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
- `roundRect(x, y, width, height, ...radii)`

Argument behavior:

- `arc()` and `ellipse()` use `false` when `anticlockwise` is omitted.
- `roundRect()` accepts a variadic radii list.

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

- `measureText(text)` returns an object with only one confirmed field: `width`.

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
- `createPattern(image, repetition)`

Behavior notes:

- `createPattern(image, repetition)` currently ignores the incoming JavaScript image value and creates the pattern from an internal 1x1 surface.

#### Image drawing

- `drawImage(image, dx, dy)`
- `drawImage(image, dx, dy, dw, dh)`
- `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`

Behavior notes:

- `drawImage()` only recognizes another `Canvas` instance as the source image.
- If the first argument is not a `Canvas`, the call returns without drawing.
- Only the 3-argument, 5-argument, and 9-argument forms are implemented.

#### Flush

- `flush()`

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
- `roundRect(x, y, width, height, ...radii)`
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

## `BarcodeDetector`

### Constructor

- `new BarcodeDetector()`
- `new BarcodeDetector(options)`

### Constructor options

- `formats`

Behavior notes:

- `options` is optional.
- If `options.formats` is present and is readable as `Vec<String>`, each string is parsed as a barcode format name.
- Unrecognized format strings are ignored.
- If `options` is omitted, or `formats` is missing or unreadable, the detector is created with an empty format list.

### Static methods

- `BarcodeDetector.getSupportedFormats()`

Return behavior:

- `getSupportedFormats()` returns a `Promise`.
- The promise resolves to an array of strings.

### Instance methods

- `detect(image)`

Argument behavior:

- `image` must be an object.
- `image.width` is required.
- `image.height` is required.
- `image.data` is required.
- `image.data` is accepted only when it can be read as an `ArrayBuffer` or a byte typed array.

Return behavior:

- `detect(image)` returns a `Promise`.
- When `image.data` is readable, the promise resolves to an array of result objects.
- Each result object currently has these confirmed fields:
  - `format`
  - `rawValue`
- When `image.data` cannot be read as supported binary data, the promise resolves to an empty array.

Error behavior:

- `detect(image)` throws if `image` is not an object.
- `detect(image)` throws if `data`, `width`, or `height` is missing.
