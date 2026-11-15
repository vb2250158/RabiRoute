[中文](README.md)

# Shared desktop voice service

Windows x64 audio service for DSH and standalone assistant hosts. A Windows Job owns the audio process tree. Closing the web page does not stop an active voice session; the host owns its lifetime.

Use `./node` for devices, PCM/WAV playback, capture, captions and tray presentation; `./services` connects these devices to the shared assistant loop. `./providers` supports compatible WAV services. `./speech-providers` adds Volcano streaming ASR/TTS. `./host`, `./settings` and `./speech-catalog` provide the shared lifecycle and provider/model-specific settings UI.

The host supplies an installed Electron executable. This package downloads no model or Electron runtime. Credentials remain in the host; the device process receives neither API keys nor chat/tool permissions. Network requests reject redirects and require TLS for remote endpoints.

Run `npm run build` to bundle the renderer, then `npm test`. Tests cover continuous capture, streamed playback cancellation, protocol framing, model profiles, typed parameters and Windows Job ownership. Real Volcano TTS and the Windows player completed a 540-character, 99.8-second reply, including playback-confirmed timing through the last character and device cleanup. Live human-microphone ASR and acoustic interruption still require separate acceptance.

The settings panel supports model/voice selection, grouped parameter search, dependencies and range validation. Detailed vendor coverage currently starts with Volcano. Compatible endpoints expose basic settings only. Unsupported transports remain visibly unavailable. See the [capability contract](SPEECH_CAPABILITIES.md) for precise coverage and provider onboarding requirements.

### Settings drafts and navigation

Conversation, recognition, speech output, devices and appearance have separate top-level entries. Provider/model/mode changes remain drafts until Save. Closing offers Continue editing, Discard or Save and close. Refresh, playback and microphone tests explicitly say Save and… when pending settings must be applied. DSH host model selection remains immediate and is labeled accordingly.

Hosts expose `previewSettings(patches)` and `saveSettingsBatch(patches)` with matching validation and profile reduction. Preview neither persists nor stops voice. Batch save accepts at most 64 patches and commits once; direct profile writes are rejected. Credentials are saved separately for the effective provider and endpoint. The UI distinguishes draft state, missing setup and disconnection.


### Independent desktop captions

Captions can open while voice is stopped, without microphone capture or model calls. Voice, captions and device diagnostics borrow the same process and tray. Stopping voice releases audio while enabled captions keep showing text; an idle process closes after captions are disabled, and host exit releases it completely. Call `await host.initialize()` at startup to restore saved caption visibility.

All non-button caption areas, including text and blank space, are draggable when unlocked. Locking disables native movement/resizing, makes the window click-through and hides its border, background and controls. Unlock through web settings or the tray. Geometry persists through the settings owner and is clamped to available displays. `test-captions` presents diagnostic text for three seconds without conversation messages. `state.caption` reports native-window acknowledgement, lock state and the last test time.

### Text-confirmed interruption

Capture onset/VAD is feedback only. The shared interaction owner stops TTS on the first accepted nonempty ASR text; empty or rejected results keep audio active. Streaming ASR can interrupt at its first partial text, while final-only ASR waits for its final text. Automatic final submission and continuing model text remain unchanged.

## Playback-following captions

`onTiming` receives provider timestamps; `player.progress` reports only PCM consumed by the local player. Response-scoped progress drives both chat and desktop captions. Queued audio, model text deltas and events after cancellation cannot advance highlighting. Volcano Chinese/English follows word timing; OpenAI PCM follows sentence boundaries. Other transports without timing do not claim word alignment.

The tool requests supported subtitles automatically without mutating persisted preferences. Late metadata catches up to consumed audio. Interruption freezes audio and highlighting while model text and tool work continue.

Incoming PCM is spooled in order to a private temporary file independently of the player's scheduling window. Playback backpressure cannot hold up subtitles or completion frames on the same connection. Completion drains all accepted PCM into the player; cancellation fences late frames, stops output and removes the spool. Each spool is bounded to one hour of PCM, matching the timing limit. Write, playback and cleanup failures remain failures.
