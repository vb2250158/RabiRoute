# Third-party notices

This package is copyright 2026 vb2250158 under the MIT license (LICENSE).

`runtime/recording.ts` retains the PCM16 WAV/base64 encoding helpers from DeepSeek Harness, copyright 2026 DeepSeek, MIT. The original MediaRecorder capture class is not shipped; continuous acquisition is implemented by `runtime/capture.mjs` and `capture-worklet.js`. The license is included at `licenses/deepseek-mit.txt`.

Koffi 3.1.1 provides the native Win32 FFI. Copyright 2026 Niels Martignène, MIT; `licenses/koffi-mit.txt`. It remains an installed dependency rather than embedded third-party source.

Electron is supplied and licensed by the host installation. It is not redistributed in this package. esbuild is a build-only dependency and is not loaded by the production Host.
