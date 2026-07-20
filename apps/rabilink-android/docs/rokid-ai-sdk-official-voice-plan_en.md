<!-- docs-language-switch -->
<div align="center">
English | <a href="./rokid-ai-sdk-official-voice-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Official RokidAiSdk voice route

> Status: experimental implementation and evidence record. Glasses-side SDK assets, 32-bit ABI, and safety gates were verified; legitimate credentials and a real ASR/TTS service loop remain incomplete.

## Why this route exists

CXR-L can install a CustomApp, render UI, and exchange commands, but it does not supply recognized speech text by itself. RokidAiSdk is the investigated official route that exposes ASR events, NLP/action results, and TTS controls inside an Android application.

## Verified preparation

- The embedded `com.rabi.link.glass` APK is forced to `armeabi-v7a` and runs on the tested glasses.
- Official 1.4.3 AARs and `workdir_asr_cn` assets can be packaged.
- CXR CustomCmd remains available for phone-to-glasses commands and status returns.
- Readiness reports expose assets, ABI, microphone permission, credentials, service connection, binding, and recording state.
- Startup is rejected safely when credentials are incomplete.

## Remaining blocker

The SDK requires legitimate `key`, `secret`, `deviceTypeId`, `deviceId`, and `seed` values from the appropriate Rokid voice product. CXR authorization tokens, general account keys, and unrelated license files are not substitutes.

Without those credentials, the repository cannot verify service binding, non-empty ASR text, or audible TTS. Credentials must remain in local, ignored configuration or a secure runtime channel.

## Rejected or currently unavailable alternatives

- Glass SDK ASR/TTS and offline commands were unavailable in the tested CustomApp environment.
- Android glasses-side ASR/TTS services were unavailable.
- Phone SDK Classic Bluetooth, P2P, media, and device-message readiness did not form a usable session.
- The official 32-bit RokidAiSdk was unsuitable for the tested arm64-only phone process, which is why the experiment moved into the glasses APK.
- Android phone ASR/TTS is an external bypass, not native glasses speech.

## Completion evidence

The route is complete only when a non-secret acceptance record proves service binding, live ASR text, a TTS call, audible playback, clean stop/restart behavior, and no credential leakage.

The long Chinese document preserves the full experiment chronology. The [communication findings](./rokid-asr-tts-communication-research_en.md) provide the recommended architecture if the official route remains unavailable.
