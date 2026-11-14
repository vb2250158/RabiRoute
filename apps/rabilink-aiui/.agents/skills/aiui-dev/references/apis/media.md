# AIUI Media API Reference

This file documents the verified media playback, capture, and recording APIs available to AIUI agent code.

- Common scope, entry points, and authoring rules live in [apis.md](./index.md).
- Keep examples aligned with the current local-file-focused implementation.

## `AudioPlayer`

### Constructor

- `new AudioPlayer(options?)`

### Common properties

- `src`
- `autoplay`
- `loop`
- `volume`
- `currentTime`
- `paused`

### Common methods

- `play()`
- `pause()`
- `stop()`
- `seek(position)`
- `destroy()`
- `append(buffer)`
- `finish()`

### Behavior notes

- `AudioPlayer` is the general-purpose playback API for full audio files and streaming audio data.
- Assigning `currentTime` performs a real seek in seconds. Observe seek completion events when UI work depends on it; seekable streaming ranges depend on the player/source.
- For file playback, set `player.src` to either a relative local path or a project-root absolute path such as `/assets/intro.ogg`.
- Local path handling explicitly covers leading-slash asset paths in the agent package.
- Network URLs are supported for `src`, but local packaged assets remain the preferred choice for bundled media.
- Streaming playback is enabled through the constructor `options` object and currently documented for `format: 'pcm'` and `format: 'ogg_opus'`.
- Use `append()` to push streaming chunks and `finish()` when the stream ends.

### Example

```javascript
import { AudioPlayer } from 'audio';

const player = new AudioPlayer();
player.src = '/assets/intro.ogg';
player.loop = true;
player.play();
```

### Text tracks and subtitle cues

`player.textTracks` is a read-only `TextTrackList`.
`player.addTextTrack(kind, label?, language?)` returns a `TextTrack`; optional
label/language default to `''`. Do not construct `TextTrack` directly.

| Object | Members |
| --- | --- |
| `TextTrack` | Read-only `id`, `kind`, `label`, `language`, `cues`, `activeCues`; writable `mode: 'disabled' | 'hidden' | 'showing'`. |
| Track updates | `addCue(cue)` / `removeCue(cue)` return `undefined`; a cue cannot be added twice while owned, and removing a foreign cue throws `NotFoundError`. `cuechange` / `oncuechange` signals active-set changes. |
| `TextTrackCueList` | `length`, `item(index)`, `getCueById(id)`; missing entries return `null`. |
| `TextTrackList` | `length`, `item(index)`, `getTrackById(id)`; missing entries return `null`. |
| `new VTTCue(startTime, endTime, text)` | Finite nonnegative seconds, end at least start. Writable `id` (default `''`), `startTime`, `endTime`, `text`; read-only `charIndex` / `charLength` may be `null`. |

Cue identity is preserved through `cues`, `activeCues`, and ID lookup. Keep the
same object to edit text/times or pass to `removeCue()`. Generated
`SpeechAudioPlayer.textTrack` cues follow the same rule. `cue.pauseOnExit`
stores a boolean (default `false`) but does not automatically pause; implement
that behavior in cue-change logic if needed. Use track mode `hidden` to observe
active cues without requiring automatic subtitle display.

```javascript
const track = player.addTextTrack('subtitles', 'Subtitles', 'en-US');
track.mode = 'hidden';
const cue = new VTTCue(0, 2, 'Welcome to AIUI');
cue.id = 'greeting';
track.addCue(cue);
console.log(track.cues.getCueById('greeting') === cue); // true
track.addEventListener('cuechange', () => {
  console.log(track.activeCues.item(0)?.text ?? '');
});
```

## `Sound`

### Constructor

- `new Sound(src)`

### Properties

- `volume`

### Methods

- `play()`
- `stop()`
- `destroy()`

### Behavior notes

- `src` must be a non-empty local file path.
- Remote URLs such as `http://` and `https://` are rejected.
- The source is bound during construction so the instance is ready for replay-oriented playback.
- Local sound effect paths can be relative or project-root absolute, for example `/assets/click.wav`.
- `volume` is a read/write number.
- `play()` stops any current playback on the instance and starts again from the beginning.
- `Sound` supports local files only.
- `Sound` does not expose `src` mutation, seeking, streaming, or event callbacks.

### Error behavior

- After `destroy()`, later method calls throw.

## Web Audio

Web Audio classes are global and are also named exports from `'audio'`. Start with `new AudioContext(options?)`; its initial state may be `suspended`, so call `resume()` before expecting processing.

### Context creation methods

| Method | Returns | Purpose |
| --- | --- | --- |
| `createBuffer(channels, length, sampleRate)` | `AudioBuffer` | Creates PCM storage. |
| `createBufferSource()` | `AudioBufferSourceNode` | Plays an `AudioBuffer`. |
| `createOscillator()` | `OscillatorNode` | Generates sine, square, sawtooth, or triangle audio. |
| `createGain()` | `GainNode` | Adjusts volume. |
| `createBiquadFilter()` | `BiquadFilterNode` | Filters audio. |
| `createAnalyser()` | `AnalyserNode` | Reads waveform and frequency data. |
| `createMediaStreamSource(mediaStream)` | `MediaStreamAudioSourceNode` | Reads an audio track from a media stream. |
| `decodeAudioData(data, success?, error?)` | `Promise<AudioBuffer>` | Decodes encoded audio bytes. |

`AudioContext` also exposes `state`, `currentTime`, `sampleRate`, `destination`, `resume()`, `suspend()`, and `close()`.

### Audio graph

All nodes inherit `connect(destination, output?, input?)` and `disconnect()`. A common graph is source → processing nodes → `context.destination`. Analyser-only microphone input should not connect to the destination because speaker playback can cause feedback.

### `MediaStreamAudioSourceNode`

Create it with `context.createMediaStreamSource(stream)` or `new MediaStreamAudioSourceNode(context, { mediaStream: stream })`. `mediaStream` is read-only and `numberOfInputs` is `0`.

- A stream without an audio track throws `InvalidStateError`.
- A value that is not a `MediaStream` throws `TypeError`.
- `track.enabled = false` temporarily silences input; setting it back to `true` resumes it.
- `track.stop()` ends the track and the node then outputs silence.

```javascript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const context = new AudioContext();
const source = context.createMediaStreamSource(stream);
const analyser = context.createAnalyser();
const waveform = new Float32Array(analyser.fftSize);

source.connect(analyser);
await context.resume();
analyser.getFloatTimeDomainData(waveform);

// During cleanup:
source.disconnect();
stream.getTracks().forEach((track) => track.stop());
await context.close();
```

Declare `RECORD_AUDIO` in `app.json` and call `getUserMedia()` from a valid user interaction.

### Key node details

- `AudioBuffer`: `numberOfChannels`, `length`, `sampleRate`, `duration`, `getChannelData()`, `copyFromChannel()`, `copyToChannel()`.
- `AudioBufferSourceNode`: `buffer`, `playbackRate`, `detune`, `loop`, `loopStart`, `loopEnd`, `start(when?, offset?, duration?)`, `stop(when?)`.
- `GainNode`: `gain: AudioParam`.
- `OscillatorNode`: `type`, `frequency`, `detune`, `start()`, `stop()`.
- `BiquadFilterNode`: `type`, `frequency`, `detune`, `Q`, `gain`, `getFrequencyResponse()`.
- `AnalyserNode`: `fftSize`, `frequencyBinCount`, decibel range, smoothing, and float/byte waveform/frequency getters.
- `AudioParam`: `value`, automation scheduling methods, and cancellation methods.

## Media Capture and Recording

### `navigator.mediaDevices`

- `getUserMedia(constraints): Promise<MediaStream>`
- `enumerateDevices(): Promise<MediaDeviceInfo[]>`
- `getSupportedConstraints(): MediaTrackSupportedConstraints`

Audio/video constraints may be booleans or objects. Supported request fields include `deviceId`, `captureSource`, `microphoneMode`, `sampleRate`, `channelCount`, `echoCancellation`, `facingMode`, `width`, `height`, and `frameRate`. Read the final device-selected values from `track.getSettings()`.

### Recording source and microphone mode

Choose the input in `getUserMedia({ audio: { ... } })`, then pass that stream
to `MediaRecorder`. Recorder options select output encoding, not the input
source. Defaults are `captureSource: 'microphone'` and
`microphoneMode: 'wearer'`.

| Constraint | Values and behavior |
| --- | --- |
| `captureSource` | `'microphone'` captures microphone input; `'system-audio'` captures the device playback mix. Also accepts `{ exact?, ideal? }` using these values. |
| `microphoneMode` | `'wearer'` prioritizes the device wearer's voice; `'far-field'` captures distant sounds; `'near-field'` captures nearby sounds; `'omnidirectional'` captures without favoring a direction. Also accepts `{ exact?, ideal? }`. Microphone only. |
| `echoCancellation` | Optional boolean for microphone echo cancellation; omit to leave the constraint unspecified. `true` cannot be combined with `'system-audio'`. |

- Invalid or device-unsupported sources/modes reject with `OverconstrainedError`.
  Do not assume all devices support every mode or system audio.
- Omit `microphoneMode` for `'system-audio'`; specifying it rejects with
  `OverconstrainedError`. System audio does not automatically fall back to the
  microphone.
- `getSupportedConstraints()` reports recognized fields, not the sources or
  modes available on the current device. Read actual values from the audio
  track's `getSettings()`.
- `deviceId` selects a specific input device; it is distinct from source type.
- To change the source or mode, end the recording, stop the old tracks, and
  request a new stream. Stop tracks on recording completion and errors.
- `wx.media.getRecorderManager().start()` uses the default microphone and
  exposes no source/mode selection parameters. Use Web capture when selection
  is required; do not invent wx `audioSource` or `captureSource` options.

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    captureSource: 'microphone',
    microphoneMode: 'far-field',
    echoCancellation: true,
  },
});
console.log(stream.getAudioTracks()[0].getSettings());

function releaseTracks() {
  stream.getTracks().forEach((track) => track.stop());
}

let recorder;
try {
  recorder = new MediaRecorder(stream, { mimeType: 'audio/wav' });
  recorder.addEventListener('dataavailable', ({ data }) => console.log(data.size));
  recorder.addEventListener('stop', releaseTracks);
  recorder.addEventListener('error', releaseTracks);
  recorder.start(250);
} catch (error) {
  releaseTracks();
  throw error;
}
// Call recorder.stop() when recording is complete.
```

For system playback, use `audio: { captureSource: 'system-audio' }` in the same
flow, without a microphone mode or enabled echo cancellation.

### `MediaStream`

Use `getTracks()`, `getAudioTracks()`, `getVideoTracks()`, and `getTrackById(id)`. Stop tracks when finished.

### `MediaRecorder`

`new MediaRecorder(stream, options?)` records a stream. Check formats with `MediaRecorder.isTypeSupported(mimeType)`. Key members include `state`, `mimeType`, `start(timeslice?)`, `stop()`, `pause()`, `resume()`, `requestData()`, `ondataavailable`, `onstart`, `onstop`, `onpause`, `onresume`, and `onerror`.

Supported media types currently include `audio/wav`, `audio/ogg;codecs=opus`, `video/webm;codecs=vp8,opus`, and `video/mp4`.
Call `isTypeSupported()` on `MediaRecorder` itself, never on an instance.

### `ImageCapture`

Construct with a video `MediaStreamTrack`. `takePhoto(options?)` returns an encoded `Blob`; `grabFrame()` returns an in-memory `ImageBitmap`.

`takePhoto()` supports `mode: 'wide'` for barcode scanning, `telephoto` for
reading distant text, and `default` for general photos, with `quality` and
`enableSystemPreview` options. The documented default output orientations and
sizes differ by mode; inspect the decoded image if dimensions matter. The Blob
does not itself expose width or height. Decode it with `createImageBitmap()` and
close the bitmap after use. `grabFrame()` provides pixels without encoding an
image file. Stop the video track in a `finally` block. For wx capture, wrap
the returned encoded `data` with its `mimeType` before barcode detection.
The default encoded dimensions are `2016 × 2688` for `wide`, `2016 × 1512`
for `telephoto`, and `3024 × 4032` for `default`. Read the selected video
track's `getSettings()` for actual stream dimensions; photo dimensions may
differ from the video stream.
