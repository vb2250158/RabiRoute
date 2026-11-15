[简体中文](README.md)

# Desktop voice assistant

The Speech tab selects a provider, model, recognition mode and voice. Grouped parameters can be searched by label or API name. Invalid numbers show inline errors; unavailable dependencies remain disabled with reasons. See the [speech capability contract](../../packages/desktop-voice-service/SPEECH_CAPABILITIES.md) for implemented vendor fields and remaining limitations.

Configure conversation, recognition and synthesis services in a standalone window. This app uses the same voice loop and settings panel as DSH. The first accepted recognition text interrupts playback while the text response continues. Web search is available; other host tools are not connected in this entry point.

## Playback and captions

Chat bubbles and the independent desktop caption follow consumed audio. Volcano bidirectional TTS uses returned Chinese/English word timestamps. OpenAI PCM currently follows sentence boundaries without word timestamps. Late timing metadata catches up to the played position; text generation does not simulate playback. Enable the desktop overlay in Settings → Appearance → Independent captions.

The first accepted recognition text stops current audio. Highlighting freezes while the remaining reply continues and stays visible. Highlight progress is ephemeral, bounded to 16 recent responses; existing encrypted chat persistence is unchanged.

A tool wait seals the opening audio segment without ending its reply. Audio after the tool result starts a new segment; real word cues are offset into the same message. Starting a new segment reopens its playback state, while late cues/end events from older segments are rejected. Interruption stops current and queued audio without cancelling text or tool work.

## Use

Install dependencies here, run `npm run build`, then `npm start`. Node.js 24.14 or newer and a local Electron executable are required. Set its path under Devices if automatic discovery is unavailable. The server listens on loopback only. Its local data directory contains `ready.json` with the entry URL. That URL includes an access credential; do not share it.

Data defaults to `%LOCALAPPDATA%/RabiAssistant`. Override the private directory with `ASSISTANT_DATA_DIR` and the port with `ASSISTANT_PORT`. Credentials use Windows current-user DPAPI encryption and are never returned to the browser. Closing the page does not stop active audio. Stop Voice ends capture; Exit Assistant releases resources and closes the server.

Under Settings → Conversation, choose a provider, save the connection and refresh the model list. Manual model entry is available when a service has no catalog. Endpoint fields are under Advanced Connection Settings. Speech configures ASR and TTS separately; Devices selects microphone and speaker.

## WorkBuddy China

Choose “WorkBuddy 国内版 · 官方登录” under Settings → Conversation, refresh models, select one and save. The app reuses the domestic login owned by the official CodeBuddy CLI and reads its actual model catalog.

Install the official `@tencent-ai/codebuddy-code` package and sign into the Chinese site. Discovery defaults to the current user's global npm installation. Set `ASSISTANT_WORKBUDDY_CLI` and optionally `ASSISTANT_WORKBUDDY_NODE` in the local launcher to use another installation. WorkBuddy and CodeBuddy share credits for the same account, subject to the [official plan](https://www.codebuddy.cn/docs/workbuddy/Pricing).

The CLI handles one turn through print/stream-json. Text streams into the existing assistant loop, with bounded in-memory conversation and the configured persona as its system prompt. CLI tools are disabled for this conversation provider. The official client owns account authentication.

Existing compatible gateway profiles remain available through `GET /v1/models` and SSE `POST /v1/chat/completions`. They require their gateway address and key. Port 18088 is an endpoint template. The observed upstream channel rejection `11128` requires resolution by the service provider.

A CodeBuddy CLI access key is distinct from a gateway key. This app does not import account tokens or migrate credentials across providers.

Inside DSH, use the host provider/model catalog directly. There is no duplicate conversation API key or endpoint configuration. Switching models also updates the DSH default.

## Web search

Settings → Web search defaults to following the current conversation model. WorkBuddy uses the official CLI WebSearch tool with its existing domestic login and selected model. The ordinary conversation process keeps native CLI tools disabled; a separately restricted search call returns actual WebSearch receipts to the shared application tool loop. The standalone adapter binds observed native search syntax to the current request and declared read-only search tool. Native markup is hidden from prose; fabricated trailing observations are discarded from model history. The shared loop continues to own dispatch and accept actual receipts only. Only the search query is sent, without full chat history or speech estimates.

Official OpenAI endpoints use the Responses web_search tool with the selected model; actual support and quota are confirmed by the provider response. Compatible third-party endpoints do not automatically inherit this capability. Tavily is available as an independent service with a separate local encrypted API key. No automatic cross-provider fallback occurs.

Save and test search to view progress, failures and clickable sources. Chat search results are shown with their source links and saved with the local conversation. The search connection test uses a fixed public documentation query and consumes the selected service's quota. Search test status is for the current running process; saved sources remain in chat history. DSH continues using its own native tool registry, provider configuration and search, without duplicate standalone search settings.

Implementation references: [CodeBuddy CLI](https://www.codebuddy.cn/docs/cli/cli-reference), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).

## Validation

Configuration isolation, catalogs, shared voice lifecycle, Windows DPAPI and loopback API tests pass. Real device checks confirm streaming PCM playback, rejection of audio after cancellation, and Windows Job release. In-app browser checks used fictional data for provider switching, model selection, saving and DSH mode.

On 2026-11-15, official CLI 2.181.0 returned 20 actual models. DeepSeek-V4.1-Flash completed real replies through the shared model adapter and the standalone web interface. All 35 desktop-service and standalone-app regression tests passed. The standalone web app completed local Whisper sample recognition, a real WorkBuddy reply, Volcano playback completion, pause, resume and stop. A real-player check confirmed that injected speech onset stops playback while text continues. Gateway and human acoustic interruption acceptance remain specific to each connection and device.

### Settings drafts and navigation

Conversation, recognition, speech output, devices and appearance have separate top-level entries. Provider/model/mode changes remain drafts until Save. Closing offers Continue editing, Discard or Save and close. Refresh, playback and microphone tests explicitly say Save and… when pending settings must be applied. DSH host model selection remains immediate and is labeled accordingly.

Hosts expose `previewSettings(patches)` and `saveSettingsBatch(patches)` with matching validation and profile reduction. Preview neither persists nor stops voice. Batch save accepts at most 64 patches and commits once; direct profile writes are rejected. Credentials are saved separately for the effective provider and endpoint. The UI distinguishes draft state, missing setup and disconnection.

### First use and preview boundaries

The DSH plugin reads providers and models from its current DSH host without duplicate chat credentials. Select a model and confirm a real text reply before configuring recognition, a voice and audio devices. An empty catalog or a default model name does not prove the model is callable. Isolated environments need the actual provider plugins and credentials.

UI previews explicitly state that conversation is unavailable, including inside settings and sample model results. Credentials, sending, voice start and audio tests are disabled in previews. First-use guidance proceeds through conversation, recognition, output and devices; model parameters may initially keep their defaults.

### Connection and testing

Settings → Connection and testing shows configuration, test status and time for the model, recognition, speech output, microphone and voice loop. Test individual services or run the complete test. The complete test transcribes a bundled fixed sample, obtains a real model reply, waits for playback completion and checks pause, resume and stop. A separate three-second microphone recording checks local input levels. Playback uses the actual player completion event; the user confirms speaker volume and listening quality.

Tests show the current step and progress, with failure reasons and configuration actions. Provider, model, voice and credential changes invalidate affected results. Local `checks.json` retains evidence across refreshes and restarts. The home screen retains live status, conversation and voice controls.

For local recognition, configure absolute `localAsr.python`, `localAsr.dependencies` and `localAsr.model` paths in the private data directory's `host-options.json`, then restart and select “本机 Whisper · 离线”. The adapter uses installed faster-whisper weights with CPU/int8, voice activity detection and repetitive-output filtering. It does not download models. Audio travels through stdin and remains in memory. Acoustic echo and interruption quality require acceptance with the intended microphone and speakers.

### 2026-11-15 Interface and first use

First use opens setup once. Completing or closing it persists the completion flag through the host settings owner; refreshes and restarts do not reopen it. Configuration and diagnostics live under Settings → Connection and testing. The home screen keeps conversation, live status, the composer and voice controls visible. History scrolls independently; reading older messages preserves position until Return to latest is selected.

Capture, recognition, generation and actual playback remain distinct. Paused capture offers Resume. Stop current playback interrupts sound while text continues; persistent mute also suppresses later speech. Voice submits automatically at the sentence boundary and clears its temporary transcript on acceptance. Interim text appears inside the conversation; there is no manual review/send step. Assistant names are editable, duplicate model labels include actual IDs, and voices support search, favorites and expression filtering without removing advanced parameters.

Volcano sample recognition feeds bundled 16kHz mono PCM through the existing provider adapter without microphone capture. The complete test checks the microphone separately. Player completion and human listening confirmation are separate; users can report hearing sound or no sound.

Speech feedback follows provider capabilities: streaming recognition shows successive text revisions and presents the corrected final result as the submitted message, without a waveform. Whole-utterance recognition shows a rolling waveform derived from actual device RMS levels while waiting for text. At most 48 level samples stay in memory; no audio is persisted. Paused, stale and disconnected states do not fabricate animated input.

The earlier 41 regression tests passed. The fixed-sample Volcano recognition, WorkBuddy reply, playback completion and voice lifecycle checks passed. The fixed sample produced successive interim results and a final punctuated transcript, with its first interim result at about 0.75 seconds. Manual interruption stopped actual playback while the model was still responding; text completed afterward. Real microphone RMS feedback was checked in the narrow-screen waveform UI. Acoustic echo and human barge-in quality still require acceptance with the intended devices.

### Local access and recovery

On first use, open the complete startup URL from `ready.json`. The browser remembers the capability for this exact address and port, so later visits can use the plain address. Startup URLs force a fresh document load instead of merely changing an old page's fragment. This capability is separate from provider API keys.

The backend stores its capability in local `access.json`, encrypted with current-user Windows DPAPI, and retains it through ordinary restarts. The browser stores only this local capability, never provider keys. An unauthenticated page offers reconnection using the complete startup link; authentication remains enforced. To revoke prior access, stop the assistant, remove its private `access.json`, and restart to generate a new capability. Old links and browser credentials then fail.

### Continuous voice and automatic submission

Volcano recognition defaults to an 800 ms silence endpoint. Realtime and second-pass modes continuously feed audio and submit each definite utterance automatically. `vad_segment_duration` controls semantic segmentation and does not replace silence endpointing. Existing profiles can enable sentence endpointing under Recognition → Model parameters → Speed and segmentation. Capture, text generation and playback have independent status indicators; interrupting sound leaves the text task running.

Continuous recognition diagnostics do not send EOF, so ending a sample cannot conceal a sentence-finalization bug. On 2026-11-15, one continuously open PCM recording supplied the bundled fixture for two real Volcano recognition, automatic submission, WorkBuddy reply and Windows playback-completion turns. Both submissions cleared the temporary transcript and capture remained active. This fixture evidence does not replace human microphone echo and acoustic barge-in acceptance.

Before dynamic expression, the shared SDK passed 132 tests; the desktop service and standalone app passed 52 tests. While the actual Windows player was running and WorkBuddy was still generating, fixture speech stopped local playback in about 76 ms. The original text completed, the next utterance submitted automatically, and capture stayed on one connection. Ordinary answers prefer natural-language streaming; tool actions and explicitly requested structured answers retain their validation. Full playback buffers wait for queued audio to drain and pause transport reads; cancellation immediately releases waiting appends and fences late audio.

Historical invalid endpoints remain readable and editable through settings. Actual voice startup still validates endpoints. Feedback type comes from pure capability metadata; reading settings does not construct provider connections.

### Speech settings and dynamic expression

Recognition options are user settings. Playback separates user preferences, per-reply Agent expression and tool integration. Provider, model, voice, default speed and volume remain user-controlled. Style instructions, supported emotion/intensity and temporary speed/pitch appear as capability tags rather than manual inputs. The full inventory identifies ownership, restrictions and outputs that are not consumed yet.

Enable automatic tone in Speech playback and save. The Agent then attempts to generate prose and expression in the same turn from the conversation persona and situation. Control metadata is stripped before chat and synthesis. Missing/unsupported values fall back to defaults without persisting overrides. Disabling expression restores default behavior and preserves legacy fixed settings, which can be reset separately.

Volcano 2.0 style instructions, voice-specific emotion/intensity and temporary speed/pitch are wired. No multidimensional emotion-vector support is claimed. The pinned official OpenAI origin exposes model/voice catalogs, mini TTS instructions, speed and sentence-based PCM streaming. Arbitrary compatible endpoints retain basic configuration. OpenAI recognition remains utterance-based HTTP transcription. Local Whisper ASR is retained; no local TTS provider is added.

On 2026-11-15, real WorkBuddy, Volcano TTS and Windows playback accepted generated style and speed in one turn, completed playback and retained active capture without changing preferences. OpenAI request/cancellation fixtures passed; the original saved OpenAI key returned HTTP 401 at both speech endpoints, so that account's live acceptance remains incomplete. See the shared service's `SPEECH_CAPABILITIES.md` for ownership and host binding.

After the expression changes, the combined SDK, service and standalone suite passes 195 tests. With dynamic tone enabled, the real fixed-fixture interruption suite measured about 40 ms from active speech PCM onset to stopped playback. Text completed, the next utterance submitted and played automatically, and one continuous capture remained open. This does not replace human microphone echo/barge-in acceptance.

### Independent captions and locking

Enable independent captions under Settings → Appearance and save to open an always-on-top desktop window without starting voice. The caption-test button shows three seconds of diagnostic text without model or microphone use. Startup restores the saved visibility setting; window failures are reported.

Text and blank areas are draggable when unlocked; buttons remain clickable. Locking disables movement/resizing, hides the frame/background/controls and makes the window click-through. Unlock in web settings or the tray. Ending voice retains enabled captions; exiting the assistant releases the desktop process. Captions, audio and device diagnostics reuse one process and tray.

Fixed settings-only toggles that never created a window and voice shutdown that destroyed enabled captions. Startup, shared lifecycle, test and invisible-window retry regressions are covered; 199 combined tests pass. Real mouse dragging and final lock appearance are distinct from native-window state verification.

Playback model selection now displays Agent-callable capabilities beside the selector, scoped to the current endpoint, model and voice, with input/output and automatic-use status. Badges are checked against the actual expression whitelist. Unknown models, custom compatible origins, missing voices and unwired hosts are not advertised as callable. Available emotion labels are listed for the selected voice; Agent-owned values remain read-only capabilities rather than manual inputs.

### Per-message speech details and full-page settings

Settings now uses a full page with category navigation on the left, or at the top on narrow screens. Return to conversation preserves the chat position; unsaved changes offer continue, discard or save.

The ellipsis beside a voice message opens recognition details with actual returned emotion/intensity, estimated gender/age, scores, the model/mode and enabled features. Requested but missing fields are explicitly marked. Readable scores use four decimals; expandable interface data retains original values. Estimates and interface scores are not proof of identity or calibrated accuracy.

Assistant-message details separate Agent expression from the actual TTS payload, submitted text and synthesis/playback/interruption state. They explain when voice was inactive or muted. Details are fetched only while open and never enter model context. Credentials, headers and audio are excluded. Details are encrypted with chat history. The list loads 100 messages at a time; each message retains up to four recent TTS requests with bounded text.

Emotion, gender and age detection remain default-off. The official interface documents VAD activation but promises neither zero latency overhead nor identical billing for the switches. On 2026-11-15, three alternating runs per configuration on the same fixed sample measured median first-interim latency of 598 ms with emotion detection versus 594 ms without, and final latency of 3510 ms versus 3464 ms. This small sample does not establish causal overhead or actual charges. A real all-detection run returned additional fields and completed automatic submission, WorkBuddy response and TTS playback; fixed PCM interruption stopped sound in approximately 52 ms while text continued. This does not replace human microphone acceptance.

### Durable conversation history and context

The local web host restores the same conversation and messages after refresh, reopening the browser or restarting the assistant. Display history is retained independently of the model window. The list initially loads 100 messages and offers earlier pages.

Message bodies, speech details and provider history are AES-256-GCM encrypted in `conversation.sqlite` in the private data directory. Windows CurrentUser DPAPI protects the encryption key. Completed responses and their provider context commit transactionally. Streaming prose checkpoints every 500 ms and flushes at completion; an abnormal exit may lose the final checkpoint interval. Recovered unfinished messages are marked without replaying requests or audio. Read/decryption/save failures are reported instead of silently creating an empty conversation. One backend process owns each data directory.

WorkBuddy and compatible models carry up to 24 recent messages and 64,000 characters per turn. Older display history remains stored and readable; it is not automatically all sent to the model. Retained history is the durable conversation record for this host. No separate memory system or automatic retrieval across the full archive was introduced.

The home-page Clear context action requires confirmation, clears this assistant's current history and model context, and ends voice. Credentials and persona stay unchanged. Busy or stale-session requests are rejected. DSH uses its native session persistence and restoration; clearing switches to a new native session without using the web database or deleting unrelated DSH conversations.

### Wide-screen settings

Settings adapt to the available width: model and identity side by side, ASR connection beside model options, and TTS model/voice beside expression capabilities. Common model, voice, preview and automatic-tone controls stay visible. Voice search/favorites, speed/volume, the full capability inventory and connection details expand on demand, retaining existing settings and draft validation.

The header offers fullscreen with Esc to exit, or a maximize-window hint when the browser denies fullscreen. Settings uses one section heading with Back, a fixed save footer, and a single-column layout on narrow screens. This update changes static frontend assets only; it does not restart the backend, clear conversations or modify credentials.

TTS uses two aligned, equal-width cards for voice selection and expression capabilities. Voice preview is the primary action; playback preferences, the full parameter inventory and advanced options use consistent disclosures below. Click a capability to read its purpose, requirements, how the assistant uses it, and the official source with its checked date. Esc or Close returns focus to the same label. Unavailable capabilities still explain their limitations; reading help does not enable features or change settings.

Descriptions use Volcano's bidirectional V3 documentation and the OpenAI Speech API reference. Availability remains owned by the selected model, voice and host policy. Provider API ranges and this tool's Agent limits are explained separately. Other providers use their own catalog notes; missing documentation is reported without borrowing another provider's capabilities.

### Text-confirmed interruption

The November 15 correction makes raw onset, amplitude/VAD and empty or rejected transcripts non-interrupting. Streaming ASR stops audio on its first accepted nonempty partial text; final-only recognition waits for its final text. Final input is still automatically submitted. Earlier PCM-onset latency measurements describe the superseded onset policy.

All 217 regressions passed. A fixed sample injected through real Volcano ASR/TTS and a Windows player verified that VAD without text keeps playback active, the first partial text precedes the stop request/confirmation, response text continues, and final input is delivered on the same capture connection. This is not human microphone or acoustic echo acceptance.

The private data directory may contain `host-options.json` with `workbuddyCli: { "node": "C:/path/to/node.exe", "entry": "C:/path/to/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" }`. Conversation and automatic/manual catalogs share this configuration; environment variables take precedence. The runner validates official package metadata before launch. Incomplete installations are not reported as login or quota problems. Cancellation terminates only the owned text-only CLI and waits for observed exit.

Recognition separates capability switches from user preferences. Emotion, gender, age, speaker, language, speech rate and volume metadata default on; sensitive-word filtering defaults off. Users can disable individual capabilities or enable all compatible ones. New profiles use realtime recognition with second-pass correction. The tool supplies the current conversation’s latest assistant reply when opening recognition; context text and wire result format are not manual form fields. Returned estimates remain available in each speech message’s details.

Speech bubbles display the original transcript. Actual returned emotion, age/gender estimates, speaker/language, rate and volume are attached to that input as hidden speechObservation data. Successful-turn model context persists these values encrypted across refreshes and restarts. Missing attributes are not inferred; historical estimates describe their original utterance. Request bodies, credentials and log identifiers remain outside model context.
