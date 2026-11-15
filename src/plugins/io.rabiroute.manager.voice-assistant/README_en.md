# Voice assistant

The unique Rabi PC plugin adds **语音助手** at `/voice-assistant`. It owns its model session and does not require a Codex, DSH or persona Route. Its model/voice loops and settings UI reuse the same shared runtime as the standalone Web assistant. WorkBuddy uses the existing official domestic login; no account tokens are copied.

Connection settings, encrypted credentials and onboarding are shared between personas. Encrypted conversation history and model context are isolated by persona and survive refresh/restart. Switching back restores the original history. The selected public persona document is applied in full; native voice settings remain with their original speech owner. Automation and Hook configuration are not silently converted into system instructions.

ASR and TTS independently select host services or custom providers. Host services reuse `manager.speech@1`, including the selected persona voice; synthesis requests `play:false` and the shared device owns the single player. Personas without a host voice can still chat and use custom TTS. Stop/disable removes registrations, subscriptions and owned audio resources without exiting Rabi or replaying accepted remote work.

The shared SDK interrupts speech after the first valid ASR text while model/tool work continues. Streaming recognition shows live text; utterance recognition shows input feedback. Desktop-pet presentation consumes the same real playback state, fenced by owner/persona/response/playback/revision. It does not start a second recorder or player.

The plugin registers an addressable `voice-assistant` Agent through `ownAgentAdapter`. Web and Agent deliveries share the same durable session. `nativeThreadOperations` supports listing and reading only the current provider session. `rabi_agent_deliver` uses a native sender bound to the actual published provider object and current session: JSON cannot supply source identity. Sending/reconciliation use the original Manager delivery permissions and receipts.

Other tools use the unified OperationSdk for current categories, pagination, search, schemas, invocation and native streams. No plugin operation allowlist is maintained. RabiLink determines reachable and authorized computers. Unknown writes retain their original identity, allow readback and block new writes until reconciled.

Build through the repository plugin/Web flow. The package includes shared-module closure, device scripts, Koffi, its Windows platform module and ws. Official CLI/Electron paths belong only in private host options; there is no dependency on the standalone Web server. Controlled-device four-source tests do not prove physical microphone, speaker, echo cancellation or remote-PC acceptance. Source, build, isolated preview, formal installation and live service results must be reported separately.
