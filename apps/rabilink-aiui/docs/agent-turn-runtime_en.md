# AIUI Agent execution loop

English | [简体中文](agent-turn-runtime.md)

Status: application loop wired in source; real Rokid host and Route delivery acceptance remain pending. `utils/agent-turn-runtime.js` serializes decisions, tools, actual observations and continued reasoning on the same Rokid model session. The page owns ASR, TTS, HUD, persona configuration and history; RabiPC owns API business state and formal receipts.

## One task

The model remains the Rokid host default, without a PC model. Persona instructions are retained; application framing and connected tool declarations join the same initial system message. Native `tools` is empty and no second native `toolcall` execution path is registered.

Natural-language final replies are displayed and spoken by sentence. An API action is one complete `rabi-agent/v1` JSON frame with the current `requestId`, tool name, arguments and optional narration. The application validates the full frame, ID and connected tool before calling `rabi_api_help`, `rabi_api_call` or local exit. API help is live; public paths are not enumerated in a static allowlist.

Actual results return to the same model as explicit `tool-observation` application messages. They use supported `user` messages, preserve real receipts and mark outputs as untrusted data. They are not native `tool` roles or a claimed native result-submission API. A new request starts only after the current model request and dispatched tool settle. The model can read current help, call existing or future APIs, reason from outcomes and continue or answer.

Plain replies can stream; action JSON is withheld from HUD, speech and execution until fully parsed. A structured action's optional `say` is visible model narration and uses sentence TTS. Empty output, partial JSON, wrong IDs, disconnected tools, stream errors and timeouts fail explicitly without another executor. Defaults are 32 model steps, 16 tool dispatches and 180 seconds per turn; each model wait is at most 30 seconds. Visible output is limited to 16000 characters; frames and observations to 262144. Limits stop new actions while preserving actual results.

## Writes and interruption

Tools persist stable intent before HTTP dispatch. Identity checks, API preconditions and receipts retain existing contracts. Equivalent writes within a turn reuse the original outcome. Unknown write outcomes block subsequent writes in that turn while permitting receipt/resource reads. Changing step IDs cannot automatically replay a write. Failure does not undo dispatched HTTP.

ASR stays active during reasoning and playback. Non-echo interim text stops only TTS. Final speech queues guidance for the next model decision. Guidance arriving during inference supersedes a generated but undispatched action; the same model decides again with that guidance. Already dispatched APIs settle first and their actual outcomes accompany the guidance.

Adopting guidance stores existing actual text in the preceding user record, keeps the new input's original history ID, and saves its actual response there. The same model, persona and source PC continue. Persona changes wait for the whole turn and queued guidance. Explicit cancellation, hiding and disposal fence late text and later actions; the caller destroys a cancelled model before starting a new turn.

A tap or supported wake event must call `SpeechRecognition.start()` synchronously before any `await`. The same continuous recognizer receives segments during model work and playback; end or error waits for new interaction instead of a timer restart. The official contract requires interaction for every `start()` and does not exempt later starts after permission. Interim results depend on the host; they stop playback only when actually received.

Conversation uses only `speechSynthesis.synthesize()` and an owned `SpeechAudioPlayer`. Interim text calls the actual player's `stop()`, releases it and aborts the old task. Late synthesis never plays, and later old-stream text remains silent; the next step resumes speech after adopting final guidance. Missing APIs or synthesis failure show an explicit unavailable/failure status without the uncontrollable shared `speak()` fallback, whose `cancel()` and utterance lifecycle events are not exposed officially. Source fixtures establish event and object calls, not simultaneous OEM microphone and speaker operation.

## Validation

`npm run check:agent` covers live-help/future-API/result reasoning on one model, serial settlement, duplicate writes, uncertain writes/readback, partial JSON, invalid actions, timeout, cancellation, step-boundary guidance and deferred persona application. An exit request accepted by the host ends the loop without another model request.

A separate read-only integration used a fixture Relay, the current source PC worker and the actual Manager: `GET /meta` and `GET /api/agent/help` both returned 200, and both actual receipts entered the next step of the same application loop, with zero mutations. Its model remains a fixture and the installed worker was not updated. The real host model, concurrent ASR/TTS, two-finger wake and original delivery response require device acceptance; no formal Route Agent is registered.

See [native tool contract](agent-tool-contract_en.md) and [two-finger wake probe](aiui-wake-probe_en.md).
