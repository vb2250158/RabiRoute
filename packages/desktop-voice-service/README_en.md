[中文](README.md)

# Shared desktop voice service

Windows x64 audio service for DSH and standalone assistant hosts. A Windows Job owns the audio process tree. Closing the web page does not stop an active voice session; the host owns its lifetime.

Use `./node` for devices, PCM/WAV playback, capture, captions and tray presentation; `./services` connects these devices to the shared assistant loop. `./providers` supports compatible WAV services. `./speech-providers` adds Volcano streaming ASR/TTS. `./host`, `./settings` and `./speech-catalog` provide the shared lifecycle and provider/model-specific settings UI.

The host supplies an installed Electron executable. This package downloads no model or Electron runtime. Credentials remain in the host; the device process receives neither API keys nor chat/tool permissions. Network requests reject redirects and require TLS for remote endpoints.

Run `npm run build` to bundle the renderer, then `npm test`. Tests cover continuous capture, streamed playback cancellation, protocol framing, model profiles, typed parameters and Windows Job ownership. A real local generated-tone PCM playback and cleanup smoke test passed; real provider ASR/TTS and acoustic interruption remain unverified.

The settings panel supports model/voice selection, grouped parameter search, dependencies and range validation. Detailed vendor coverage currently starts with Volcano. Compatible endpoints expose basic settings only. Unsupported transports remain visibly unavailable. See the [capability contract](SPEECH_CAPABILITIES.md) for precise coverage and provider onboarding requirements.

### Settings drafts and navigation

Conversation, recognition, speech output, devices and appearance have separate top-level entries. Provider/model/mode changes remain drafts until Save. Closing offers Continue editing, Discard or Save and close. Refresh, playback and microphone tests explicitly say Save and… when pending settings must be applied. DSH host model selection remains immediate and is labeled accordingly.

Hosts expose `previewSettings(patches)` and `saveSettingsBatch(patches)` with matching validation and profile reduction. Preview neither persists nor stops voice. Batch save accepts at most 64 patches and commits once; direct profile writes are rejected. Credentials are saved separately for the effective provider and endpoint. The UI distinguishes draft state, missing setup and disconnection.
