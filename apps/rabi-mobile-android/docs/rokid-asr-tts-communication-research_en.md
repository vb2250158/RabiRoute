<!-- docs-language-switch -->
<div align="center">
English | <a href="./rokid-asr-tts-communication-research.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rokid ASR/TTS communication and feasibility

> Status: current research conclusion based on evidence through 2026-07-05. External platforms and SDK permissions can change, so recheck official access and versions before implementation.

## Plain-language conclusion

A normal third-party Rokid glasses APK should not assume direct access to system ASR text or system TTS. The safer architecture separates glasses I/O from speech services.

1. CXR-M, CXR-L, CustomView, CustomApp, or AIUI handles buttons, audio, images, GUI, and display.
2. A phone, PC, cloud service, or managed platform performs ASR.
3. RabiRoute routes the resulting text to the selected handler.
4. Text, GUI state, or separately synthesized audio returns to the glasses.

## Viable interaction models

In a platform-managed model, Rokid AIUI or a hosted Agent handles listening and speaking while RabiLink exchanges text and tool results. This is the closest path to a native user experience and avoids owning ASR/TTS infrastructure.

In a self-managed bridge, CXR provides device input and output while the application owns ASR, TTS, and playback elsewhere. This offers more control but requires separate consent, latency, reliability, and credential work.

## Route comparison

- AIUI or hosted Rokid Agent: best fit when the platform can deliver text requests and speak text replies.
- RokidAiSdk/OpenVoice: technically shaped as full speech, but requires a voice-access product and legitimate credentials.
- Glass SDK: not ready in the tested CustomApp environment because its security service was unavailable.
- CXR audio plus external ASR: controllable and testable, but the application owns the speech stack.
- Android phone ASR/TTS: useful fallback evidence, not proof of glasses-native speech.

`sendAsrContent` or `sendTtsContent` proves a text/display integration point, not necessarily speech recognition or audible synthesis. Each direction requires its own real-device acceptance.

See the [native evidence ledger](./rokid-native-asr-tts_en.md) for the detailed failures and the [device probe README](../README_en.md) for current code ownership.
