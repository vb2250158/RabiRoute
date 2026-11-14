# Desktop voice assistant

The independent Manager/Web plugin registers `/voice-assistant`. Users explicitly select a running persona Route and available ASR/TTS models. It never selects another Agent, persona or cloud provider on their behalf.

The first layer uses native role-panel admission and the selected Agent's prompt, persona, tools and durable work. The second layer imports `createVoiceInteraction` from `packages/assistant-runtime`, shared with glasses and the Web simulator. Host adapters provide browser PCM capture, manual ASR and RabiSpeech FIFO playback. Remote tool connectivity remains separate and deferred.

Capture continues during recognition, model work and output. Barge-in stops speech without cancelling native model/tool work. Committed replies must match authoritative outbox `replyToMessageId`, Route and persona. Old work remains visible as text; acceptance is not completion and uncertain admission is never blindly replayed. Reconnection reads the native timeline and deduplicates message IDs.

Each spoken segment has an immutable playback scope. `POST /api/speech/playback/cancel-session` preserves authority/lifecycle checks and fences late synthesis without stopping unrelated jobs. Only native `done` events establish playback completion. Existing pet message/playback subscriptions render text and animation without another microphone or player. Leaving the page closes voice resources, not already accepted Agent work.

Keep source/build/fixture results separate from installation, browser acceptance and physical microphone/speaker/AEC validation. Requesting browser echo cancellation does not prove cancellation of host speaker output. PCM capture segments at 20 seconds and limits pending recognition to four segments; overload stops capture with an error. This is not a duplex model and does not claim GPT Realtime latency.

Deploy Manager and Web together: authoritative reply correlation and scoped playback cancellation are required. Replies from an old server without correlation are not spoken. Use the repository's plugin/Web build and generation lifecycle; do not overwrite active plugin directories.

Hiding the window or choosing Pause voice stops capture and speech while retaining message subscriptions and admitted work. Showing the window neither opens the microphone nor replays old replies; use Reopen microphone to resume input. The reading toggle independently controls output and preserves manual mute across visibility changes. Re-enabling reading speaks only new response turns. The shared loop uses the output gate in assistant-runtime 0.10.3.
