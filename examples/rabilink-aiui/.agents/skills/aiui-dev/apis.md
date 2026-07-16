# AIUI API Reference

This file only documents APIs that have been checked against the current implementation.

- The current detailed scope covers the currently verified Canvas, Bluetooth, sensor, media, AI, Web speech, `wx`, and barcode APIs available to AIUI app code.
- Do not infer standard Web API behavior unless it is explicitly listed below or in the linked reference files.
- Do not add browser-compatible overloads or semantics that are not present in the source.

## Confirmed API Scope

The currently verified APIs are:

### Canvas runtime

- `Canvas`
- `CanvasRenderingContext2D`
- `ImageData`
- `CanvasGradient`
- `CanvasPattern`
- `Path2D`

### Barcode runtime

- `BarcodeDetector`

### Bluetooth runtime

- `navigator.bluetooth`
- `BluetoothScan`
- `DeviceFoundEvent`
- `BluetoothDevice`
- `BluetoothRemoteGATTServer`
- `BluetoothRemoteGATTService`
- `BluetoothRemoteGATTCharacteristic`
- `BluetoothCharacteristicProperties`

### Sensor runtime

- `Accelerometer`
- `AbsoluteOrientationSensor`
- `Gyroscope`

### wx module

- `default` export from `'wx'`
- `wx.arrayBufferToBase64(buffer)`
- `wx.exitMiniProgram(options?)`
- `wx.setBackgroundColor(options)`
- `wx.navigateTo(options)`
- `wx.redirectTo(options)`
- `wx.navigateBack(options?)`
- `wx.setStorage(options)`
- `wx.getStorage(options)`
- `wx.removeStorage(options)`
- `wx.clearStorage(options)`
- `wx.setStorageSync(key, data)`
- `wx.getStorageSync(key)`
- `wx.removeStorageSync(key)`
- `wx.clearStorageSync()`
- `wx.request(options)`
- `wx.createSocket(options)`
- `wx.connectSocket(options)`
- `wx.createEventSource(options)`

### wx speech runtime

- `wx.speech.playTTS(text)`
- `wx.speech.startRecognition()`

### wx media runtime

- `wx.media.getRecorderManager()`
- `wx.media.createCameraContext()`
- `RecorderManager`
- `CameraContext`

### Media runtime

- `Sound`

### wx networking task runtime

- `RequestTask`
- `SocketTask`
- `EventSourceTask`

### AI runtime

- `LanguageModel`
- `LanguageModelSession`
- `LanguageModelTextStream`

### Web speech runtime

- `speechSynthesis`
- `SpeechSynthesisUtterance`
- `SpeechRecognition`

### wx canvas entry point

- `wx.createCanvasContext(canvasId)`

## Entry Points

### `wx` module

```javascript
import wx from 'wx';
```

### Script-owned canvas

```javascript
const canvas = new Canvas(300, 150);
const ctx = canvas.getContext('2d');
```

### Page `<canvas>` node

```javascript
import wx from 'wx';

const ctx = wx.createCanvasContext('chartCanvas');
```

### Barcode detector

Global constructor:

```javascript
const detector = new BarcodeDetector();
```

Module import:

```javascript
import BarcodeDetector, { BarcodeDetector as NamedBarcodeDetector } from 'barcode';

const detector = new BarcodeDetector();
const namedDetector = new NamedBarcodeDetector();
```

### Bluetooth

```javascript
const bluetooth = navigator.bluetooth;
```

### Sensors

```javascript
const accelerometer = new Accelerometer({ frequency: 60 });
const orientation = new AbsoluteOrientationSensor({ frequency: 60 });
const gyroscope = new Gyroscope({ frequency: 60 });
```

### Sound

Global constructor:

```javascript
const click = new Sound('./click.wav');
```

Module import:

```javascript
import { Sound } from 'audio';
```

### Language model

Global object:

```javascript
const status = await LanguageModel.availability();
const session = await LanguageModel.create({ model: 'gpt-4o-mini' });
```

Module import:

```javascript
import { LanguageModel } from 'language-model';
```

### Web speech

Global objects:

```javascript
const utterance = new SpeechSynthesisUtterance('Hello Ink');
speechSynthesis.speak(utterance);

const recognition = new SpeechRecognition();
recognition.start();
```

Module import:

```javascript
import {
  speechSynthesis,
  SpeechSynthesisUtterance,
  SpeechRecognition,
} from 'speech';
```

Behavior notes:

- The `wx` module currently exports only `default`.
- `wx.createCanvasContext(canvasId)` looks up a `<canvas id="...">` node on the current page.
- If the page, node, or backing canvas cannot be found, it returns `null`.
- `canvas.getContext(type)` only accepts `'2d'`. Any other value returns `null`.
- The `barcode` module exports `BarcodeDetector` as both the default export and a named export.
- `navigator.bluetooth` is mounted by the runtime.
- `Accelerometer`, `AbsoluteOrientationSensor`, and `Gyroscope` are registered globally on `globalThis` and `window`.
- `Sound` is available globally and as a named export from `'audio'`.
- `LanguageModel` is mounted on `globalThis` and `window`, and is exported by `'language-model'`.
- `speechSynthesis`, `SpeechSynthesisUtterance`, and `SpeechRecognition` are registered globally and are exported by `'speech'`.

## Detailed References

- [Canvas and barcode APIs](./apis-canvas.md)
- [wx module and task APIs](./apis-wx.md)
- [Device and sensor APIs](./apis-device.md)
- [Media APIs](./apis-media.md)
- [AI and speech APIs](./apis-ai.md)

## Authoring Rules For Agents

- Only generate API usage that is explicitly listed in this file or in the linked domain reference files.
- Treat these files as implementation truth, not Web platform truth.
- Do not assume browser overloads, browser objects, or browser return shapes unless they are explicitly documented in these files.
- Prefer `wx.createCanvasContext(id)` for page `<canvas>` drawing.
- Prefer `new Canvas(width, height)` only when you need a script-owned canvas instance.
