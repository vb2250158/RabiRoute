# Voice assistant

For a full repository build, run `npm ci` at the root, then `npm run build`. This repository is not an npm workspace: root dev dependencies and the root lockfile supply React and React DOM for Web compilation, alongside Vue/Vite, at the versions declared by this plugin. Its own dependencies still describe the standalone package. Existing local `node_modules` do not replace clean root-lockfile validation.

Recognition diagnostics use the packaged Microsoft MIT-licensed Mandarin question “今天天气怎么样？” (What is the weather like today?). No system voice, PowerShell, Azure SDK or runtime download is required. The [diagnostic resources](../../../apps/desktop-assistant/assets/diagnostics/README_en.md) record the source, fixed hash and complete license, also shipped in the plugin’s `diagnostic-assets`. The selected ASR must support Mandarin. A sample failure still permits independent model and playback checks and leaves the voice chain untested. Normal microphone recognition does not depend on this sample.

The unique Rabi PC plugin adds **语音助手** at `/voice-assistant`. It owns its model session and does not require a Codex, DSH or persona Route. Its model/voice loops and settings UI reuse the same shared runtime as the standalone Web assistant. WorkBuddy uses the existing official domestic login; no account tokens are copied.

Configure API connections under **Model services** for language models, web search, speech recognition and text to speech. Previously saved connections appear in the catalog. Multiple services can use the same endpoint with separate credentials. Keys are stored encrypted on the host. Enter a new key when changing the endpoint or protocol of a keyed connection.

Voice Assistant settings select saved services. For live recognition and playback, select a connected device and its model in the same searchable panel, or select an API service from the catalog. Background transcription continues to use a device model. Speaker recognition, image and video tabs can also save API connections for consumers that support the configured protocol.

Connection settings, encrypted credentials and onboarding are shared between personas. Encrypted conversation history and model context are isolated by persona and survive refresh/restart. Switching back restores the original history. The selected public persona document is applied in full; native voice settings remain with their original speech owner. Automation and Hook configuration are not silently converted into system instructions.

Open a model in Model Services to view its usage. API calls observed from this release onward are attributed to the saved connection and model. Token, cache and credit values come from provider receipts. Cache rates use only requests with both input and cache-hit measurements. Speech totals use records held by the computer providing the model. Media totals use jobs retained by this workbench. Empty records show “No usage yet.” Unreported measures show “Unknown.”

The Rabi PC **Voice Assistant** switch controls background microphone capture. Detected utterances are saved as transcripts. Turning the switch off ends that PC's capture and voice conversation. The first upgrade adopts the previous host streaming setting. The mobile assistant controls the phone's recorder and recording history independently.

The voice assistant selects configured models from Model Services. The menu has a single search field. Selecting a group on the left updates the model list on the right. Selecting a model displays its name in the field. Background transcription supports local recognition models on this PC and connected computers. Live recognition and playback can also use configured API models. Model Services starts local models on demand. Synthesis requests `play:false`, and the assistant plays the audio on its device. Personas without a host voice can still chat and use API TTS.

A paired Rabi mobile app can use the PC's selected custom TTS provider. The PC synthesizes segments of the assistant reply from the current conversation, and the phone plays the returned audio. The model can keep working during synthesis and playback.

The dictionary in **Settings → Speech Recognition → Transcription Dictionary** is shared by Rabi PC and the Android assistant connected to that PC. Manager supplies hotwords, a prompt, or context as supported by the selected model. Android's recognition fallback uses the paired PC. The phone's background recorder follows its existing archive and transcription policy. FireRedASR2-AED, on-device keyword spotting, and the native AIUI glasses recognizer have no dictionary input.

The shared SDK interrupts speech after the first valid ASR text while model/tool work continues. Streaming recognition shows live text; utterance recognition shows input feedback. Desktop-pet presentation consumes the same real playback state, fenced by owner/persona/response/playback/revision. It does not start a second recorder or player.

Desktop capture filters matching playback transcripts during speech and briefly after it ends. New speech can still interrupt playback.

Turning on desktop-pet companionship starts live voice capture. When capture has stopped in the same persona's running session, companionship resumes capture in that session. Turning companionship on again while listening continues the current voice round.

Enable keyword wake independently in PC **Speech Recognition** settings. It borrows the background recorder's microphone and uses the selected persona's wake words to start live conversation. Ending the conversation returns the assistant to background transcription. Use **Upload audio for transcription** at the top of the page to transcribe a file.

The plugin registers an addressable `voice-assistant` Agent through `ownAgentAdapter`. Web and Agent deliveries share the same durable session. `nativeThreadOperations` supports listing and reading only the current provider session. `rabi_agent_deliver` uses a native sender bound to the actual published provider object and current session: JSON cannot supply source identity. Sending/reconciliation use the original Manager delivery permissions and receipts.

Other tools use the unified OperationSdk for current categories, pagination, search, schemas, invocation and native streams. No plugin operation allowlist is maintained. RabiLink determines reachable and authorized computers. Unknown writes retain their original identity, allow readback and block new writes until reconciled.

On Windows, the assistant can look up the foreground application's name and window title when a request depends on what is open. It reads the current window on demand before looking for related plans.

Build through the repository plugin/Web flow. The package includes shared-module closure, device scripts, Koffi, its Windows platform module and ws. Official CLI/Electron paths belong only in private host options; there is no dependency on the standalone Web server. Controlled-device four-source tests do not prove physical microphone, speaker, echo cancellation or remote-PC acceptance. Source, build, isolated preview, formal installation and live service results must be reported separately.

The mobile streaming API emits `speech-start` and `speech-end` around speech and delivers the final transcript separately. The end event updates the speaking state. The client still waits for the final transcript before settling the input.
