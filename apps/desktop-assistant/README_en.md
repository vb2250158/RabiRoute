[简体中文](README.md)

# Desktop voice assistant

The Speech tab selects a provider, model, recognition mode and voice. Grouped parameters can be searched by label or API name. Invalid numbers show inline errors; unavailable dependencies remain disabled with reasons. See the [speech capability contract](../../packages/desktop-voice-service/SPEECH_CAPABILITIES.md) for implemented vendor fields and remaining limitations.

Configure conversation, recognition and synthesis services in a standalone window. This app uses the same voice loop and settings panel as DSH. Speaking interrupts playback while the text response continues. Host tools are not connected in this entry point.

## Use

Install dependencies here, run `npm run build`, then `npm start`. Node.js 24 and a local Electron executable are required. Set its path under Devices if automatic discovery is unavailable. The server listens on loopback only. Its local data directory contains `ready.json` with the entry URL. That URL includes an access credential; do not share it.

Data defaults to `%LOCALAPPDATA%/RabiAssistant`. Override the private directory with `ASSISTANT_DATA_DIR` and the port with `ASSISTANT_PORT`. Credentials use Windows current-user DPAPI encryption and are never returned to the browser. Closing the page does not stop active audio. Stop Voice ends capture; Exit Assistant releases resources and closes the server.

Under Settings → Conversation, choose a provider, save the connection and refresh the model list. Manual model entry is available when a service has no catalog. Endpoint fields are under Advanced Connection Settings. Speech configures ASR and TTS separately; Devices selects microphone and speaker.

## WorkBuddy China

This entry uses the local compatible gateway protocol used by the DSH WorkBuddy plugin: `GET /v1/models` and SSE `POST /v1/chat/completions`. Sign into a domestic account and start the existing gateway first, then enter its address and gateway key. Port 18088 is a template, not discovery.

A CodeBuddy CLI access key is distinct from a gateway key. This app does not import account tokens or migrate credentials across providers.

Inside DSH, use the host provider/model catalog directly. There is no duplicate conversation API key or endpoint configuration. Switching models also updates the DSH default.

## Validation

Configuration isolation, catalogs, shared voice lifecycle, Windows DPAPI and loopback API tests pass. Real device checks confirm streaming PCM playback, rejection of audio after cancellation, and Windows Job release. In-app browser checks used fictional data for provider switching, model selection, saving and DSH mode.

Real WorkBuddy conversations, Volcano ASR/TTS and acoustic interruption still require configured services and device acceptance. UI fixtures are not evidence of real model calls.

### Settings drafts and navigation

Conversation, recognition, speech output, devices and appearance have separate top-level entries. Provider/model/mode changes remain drafts until Save. Closing offers Continue editing, Discard or Save and close. Refresh, playback and microphone tests explicitly say Save and… when pending settings must be applied. DSH host model selection remains immediate and is labeled accordingly.

Hosts expose `previewSettings(patches)` and `saveSettingsBatch(patches)` with matching validation and profile reduction. Preview neither persists nor stops voice. Batch save accepts at most 64 patches and commits once; direct profile writes are rejected. Credentials are saved separately for the effective provider and endpoint. The UI distinguishes draft state, missing setup and disconnection.

### First use and preview boundaries

The DSH plugin reads providers and models from its current DSH host without duplicate chat credentials. Select a model and confirm a real text reply before configuring recognition, a voice and audio devices. An empty catalog or a default model name does not prove the model is callable. Isolated environments need the actual provider plugins and credentials.

UI previews explicitly state that conversation is unavailable, including inside settings and sample model results. Credentials, sending, voice start and audio tests are disabled in previews. First-use guidance proceeds through conversation, recognition, output and devices; model parameters may initially keep their defaults.
