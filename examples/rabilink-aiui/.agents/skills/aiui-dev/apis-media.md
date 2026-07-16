# AIUI Media API Reference

This file documents the verified media playback APIs available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
- Keep examples aligned with the current local-file-focused implementation.

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
- `volume` is a read/write number.
- `play()` stops any current playback on the instance and starts again from the beginning.
- `Sound` supports local files only.
- `Sound` does not expose `src` mutation, seeking, streaming, or event callbacks.

### Error behavior

- After `destroy()`, later method calls throw.
