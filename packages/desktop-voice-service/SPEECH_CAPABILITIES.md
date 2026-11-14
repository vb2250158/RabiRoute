# Speech capability contract

The shared panel renders `state.speechCatalogs[providerId][asr|tts]`. Each catalog owns its model IDs, recognition modes, resource/billing choices, voices, parameter groups and official documentation date. Host adapters reuse this catalog; they must not create a second voice loop or infer support from provider names.

## Adding a provider or model

1. Verify the vendor's current model and protocol documentation. Inventory every public request parameter and output capability, including optional fields and model/voice restrictions.
2. Add typed parameter descriptors with a stable settings key, label, type, default, group, range, enums and dependency conditions. Every supported field must have a settings validator, per-model profile round trip and protocol encoder. New structured types such as emotion vectors require typed persistence and encoder tests before enabling the GUI control.
3. Advertise unavailable protocols/features explicitly with a reason. Do not silently hide capabilities, enable a field without an encoder, or imply that the generic compatible endpoint supports vendor extensions.
4. Preserve numeric enum types and independent provider/model settings. Mode restoration must update transport addresses unless the user explicitly overrides the address.
5. Test requests with non-default values, unsupported model/voice combinations, switching away and back, dependency changes, and cancellation. Confirm the real service separately from fixtures.

## Current coverage (2026-11-08)

Volcano streaming ASR has 31 controls: normalization, punctuation, disfluency, result mode, speaker/language/emotion/gender/age information, speech rate/volume, acceleration, VAD, semantic segmentation, initial protection, Chinese variants, hotwords/context/tables, POI/music hints and filtering. The three recognition modes share one loop. File ASR models are listed but unavailable in the continuous conversation adapter.

Volcano TTS has 42 controls covering expression/version, style prompts, voice-specific emotion labels, rate/volume/pitch, output format/rate, timestamps, language/text handling, output marking, caching, context/tags and mixing. The public voice snapshot has 577 entries (473 for 2.0, 104 for 1.0); unsupported bidirectional voices remain disabled. Private cloned voices require their account-owned ID.

The player currently accepts PCM only. Compressed formats and file-header metadata are visible but disabled. Timestamp request flags are sent, but returned timing metadata does not yet drive word-aligned captions. HTTP and unidirectional TTS transports are listed but not implemented. This catalog does not claim that Volcano supports a multidimensional emotion vector. The shared renderer has a vector control type for providers whose typed adapter implements it.

OpenAI-compatible connections currently expose basic connection/model/voice settings, not a verified full vendor capability catalog. WorkBuddy support concerns the conversation gateway, not ASR/TTS capabilities.

Sources: [ASR](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh), [TTS](https://docs.volcengine.com/docs/doubao-voice/websocket-bidirectional-streaming-v3?lang=zh), [voices](https://www.volcengine.com/docs/6561/1257544).
