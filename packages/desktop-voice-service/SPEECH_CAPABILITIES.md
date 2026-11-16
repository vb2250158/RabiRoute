# Speech capability contract

The shared panel renders `state.speechCatalogs[providerId][asr|tts]`. Catalogs own verified model IDs, modes, resource choices, voices, parameter groups, restrictions and source dates. Hosts reuse the shared interaction loop; a provider name alone never enables extensions.

## Parameter ownership

- **Recognition:** users own language, normalization, endpointing, domain vocabulary, filtering and optional returned-information switches. The tool owns current-conversation context and wire result handling. Neither is a manual model-payload input. ASR options do not change halfway through a connection.
- **Playback preferences:** user-selected provider, model, voice, default speed, volume, encoding and compatible account resources. Preferences persist independently per provider/model.
- **Per-reply expression:** optional Agent-generated style instruction, supported emotion label/intensity, temporary speed factor and pitch. The panel shows capability tags and the opt-in automatic-tone switch. It does not expose these as manual form fields. Persona remains in conversation settings; the Agent derives expression from both persona and the current situation.
- **Tool integration:** context IDs, inline-tag parsing and timing/file metadata appear in the full inventory with actual integration status. These are not silently presented as automatic features. Existing saved values remain compatible. Supported TTS timing drives response-scoped captions from consumed PCM, rather than model generation or queued audio.

Disabling automatic expression uses provider defaults and any legacy fixed settings. The UI identifies retained legacy tone and offers restoring defaults. Enabling it uses per-call overrides without changing saved preferences. Unsupported or omitted Agent values fall back to defaults. Audio interruption continues to suppress only the current response's sound; text and work continue.

## Shared host binding

1. Append `speechExpressionInstruction({enabled:true})` from `@rabilink/assistant-runtime/voice` once to the editable persona/profile. Do not rebuild a conversation when the selected voice changes.
2. Compute `speechExpressionPolicy(settings)` from `@rabilink/desktop-voice-service/expression` per request and pass it through `runOptions.speechCapabilities`. The disabled policy omits the application-message capability envelope.
3. Feed raw visible model deltas through `createSpeechExpressionDecoder(policy)`. Before the first decoded prose delta, pass the normalized expression to `responseToken.setSpeech({expression})`. Send only decoded prose to chat and TTS. Finish the decoder before finishing the response token.
4. Set the resident host's `supportsDynamicExpression:true` only after this binding is present. Older hosts remain default-off. Use the same player, cancellation and listening owner.

Control header and prose are generated in one model turn. The decoder incrementally strips the bounded header; it does not buffer the full answer or make a second model call. Whitelisted expression fields cannot change endpoints, credentials, provider or voice. Capability metadata is read without constructing provider connections.

## Current coverage (2026-11-16)

Volcano streaming ASR inventories 32 typed settings/capability fields covering normalization, punctuation, disfluency, result mode, speaker/language/emotion/gender/age information, speech rate/volume, acceleration, VAD, segmentation, initial protection, Chinese variants, hotwords/tables and filtering. Realtime, second-pass and utterance modes share one loop. File ASR models are listed as unavailable in this transport. Local Whisper ASR remains available only when configured by the host.

Volcano TTS inventories 42 parameters and 577 public voice entries. Style instructions depend on model/version; emotion labels and intensity depend on the actual voice. User speed is a baseline multiplied by the Agent's temporary speed factor within provider bounds. The current adapter does **not** claim support for a multidimensional emotion vector. PCM streaming is playable; compressed formats and file-header metadata remain unavailable. The adapter automatically requests supported subtitle/timestamp output and maps Chinese/English word timing to the submitted text. Both chat and desktop captions follow consumed PCM; late metadata catches up, and cancellation freezes the highlighted prefix. HTTP/unidirectional TTS transports remain listed as unavailable.

For the pinned official OpenAI origin, the adapter catalogs mini TTS, legacy TTS voices and file transcription models. Mini TTS accepts Agent-generated instructions; legacy TTS accepts speed but not instructions. Text is submitted sentence by sentence; each 24 kHz PCM response streams into the same cancellable player. This is not a bidirectional text-input session. ASR uses utterance recording and HTTP transcription, with user language/prompt/temperature and model-specific timestamps/logprobs. PCM playback provides sentence-level highlighting using actual sample counts, explicitly labeled as sentence following. Realtime ASR, SSE audio events, compressed playback and word-aligned captions are not implemented. Arbitrary compatible origins retain basic settings and do not inherit official OpenAI extensions. No local TTS provider is added.

Real WorkBuddy + Volcano TTS + Windows playback accepted a generated style instruction and speed factor on 2026-11-15 while capture stayed active; preferences were unchanged. OpenAI adapter fixtures passed, but the user's original saved OpenAI credential returned HTTP 401 for both speech endpoints, so live OpenAI acceptance is incomplete. Fixture and service-account acceptance must be reported separately.

## Extending a provider

Inventory public inputs and outputs from official documentation. Assign ownership before adding controls. User fields need typed validators, per-model persistence, dependency checks and encoder tests. Agent fields need a bounded capability policy and encoder tests; declare vectors only after implementing their typed adapter. Tool-owned outputs need honest consumption status. Preserve restrictions, unknown-model fallback and cancellation. Verify non-default requests, switching profiles, unsupported voice/model combinations and real service behavior separately.

Sources: [Volcano ASR](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh), [Volcano TTS](https://docs.volcengine.com/docs/doubao-voice/websocket-bidirectional-streaming-v3?lang=zh), [voices](https://www.volcengine.com/docs/6561/1257544), [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

## Per-message diagnostics host binding

Use `asrMessageDetails(config, result)` from `@rabilink/desktop-voice-service/speech-details` to retain the exact ASR request and bounded provider result from the accepted utterance. `createResidentHost` supplies this value as `native.submit(text, requestId, {source, details})` for speech input. Store it with that user message. Only the semantic projection returned by asrAgentContext(details) enters model context; raw diagnostic/request data remains local.

The shared response token forwards its `id` as `speech.responseId`. The desktop service's optional `onSpeechRequest` reports actual send/accept/finish/failure/cancel events, sanitized parameters and submitted text, with a composite request ID. The resident host forwards these and playback events to optional `native.recordSpeechDetails(responseId, event)`. Associate them with the original assistant message even after interruption; diagnostic failure must never own audio lifetime.

Hosts implement optional `native.messageDetails(messageId)` and expose only `hasDetails` in normal message summaries. The existing command channel accepts `{action:'message-details', messageId}`. The shared panel reads and refreshes details only while open; fetching details must not clear unrelated runtime errors. Bound retention and exclude credentials, request headers and audio. The standalone host caches 100 messages for display and encrypts retained history/details in its local store, with four recent TTS requests per message and bounded sanitized data. DSH binds native history; extra-detail retention follows its host adapter.

`createAssistantPanel` accepts optional `settingsPresentation:'page'` with the host's full-page settings primitive. Existing hosts keep the modal default. This presentation option does not create another voice or model owner.

Recognition information defaults on, following the user’s preference to enable supported features; sensitive filtering stays off. New profiles default to second-pass correction. Context is projected from the current conversation’s latest assistant reply and sent at recognition connection setup; an existing long connection receives updates at its next connection. OpenAI utterance requests refresh context per request. Users can disable context sharing or individual returned-information capabilities. Estimates do not assert identity or accuracy; no claim is made that billing or latency is unchanged.

## Context persistence ownership

Standalone web owns a local encrypted conversation store and restores provider protocol history separately from display projections. Initial model history is injected at model acquisition, including after profile changes. Only confirmed successful turns advance the durable model context; partial or failed output stays visible with its status and is not replayed on recovery. Raw voice diagnostics remain excluded from model input. Actual semantic ASR returns are included in the corresponding user input as speechObservation. Completed-turn context and messages share a transaction.

DSH uses its original native session ID and native persistence rather than importing standalone history. Other hosts bind their own persistence owner. The shared panel optionally exposes `capabilities.contextManagement` and a `context` status/count projection. `clear-context` carries `{sessionId, confirm:true}` and must reject pending work and stale identities. Native hosts start a fresh native session and retain other host-managed conversations. The optional `messageHistory` capability adds `message-history` with an exclusive `before` message ID, returning `{sessionId,messages,hasMore}`. Hosts must not advertise capabilities before wiring their actual owner.

## Caption acceptance (2026-11-16)

223 shared/desktop/standalone tests passed. Real Volcano TTS, Windows PCM playback, web highlighting and the independent caption window were exercised with a fixed reply. Stopping playback froze the highlighted prefix and retained remaining text. This acceptance did not call a model or use a human microphone. OpenAI sentence timing is fixture-verified; live OpenAI acceptance remains incomplete. Progress is an ephemeral projection bounded to 16 recent responses and is not restored as live playback after restart.

## ASR capability acceptance (2026-11-16)

234 tests passed, including intentional empty host-context handling, GUI ownership, enabled defaults, conversation fencing, fresh context per connection/utterance and metadata request encoding. A real Volcano fixed-audio request accepted all enabled compatible features and returned emotion, age/gender estimates, speaker/language, speech rate and volume. Sensitive filtering was absent. No human microphone was used for that provider validation.

## Hidden ASR observations for Agent context

Use asrAgentContext(details) from ./speech-details for actual received utterance metadata. It returns source/provider/model and primitive estimates for emotion, age/gender, speaker/language, speech rate/volume and confidence when present; it never derives missing values from text or settings. Request parameters, authentication, log IDs, audio and duplicate transcript text are not included.

Pass the result as the per-turn speechObservation option through createAssistantConversation/run or createAssistantSession/run. The shared protocol attaches it beside the original text in the application user-input envelope and describes it as untrusted model estimates, not user-stated identity or instructions. Native hosts must persist it with the correct user message and include it in model projection while retaining transcript-only display. Standalone does this in encrypted provider context. Plain text inputs receive no new speechObservation; historical observations remain attached to their own turns. Clear-context removes their model visibility with that conversation.

Hidden-context acceptance: all 237 tests passed. Real fixed-audio ASR → WorkBuddy → TTS/Windows playback passed. After restarting the isolated assistant, a second real model turn read the original emotion, age and gender estimates from restored hidden context. The visible user bubble remained transcript-only. This was a fixed audio sample, not a human microphone test.
