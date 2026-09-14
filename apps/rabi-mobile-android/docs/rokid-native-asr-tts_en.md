<!-- docs-language-switch -->
<div align="center">
English | <a href="./rokid-native-asr-tts.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Native Rokid ASR/TTS evidence ledger

> Status: experimental evidence ledger, with its latest concentrated findings dated 2026-07-05. The Chinese source keeps the chronological commands; it is not a supported installation recipe.

## Question under test

The investigation asked whether the `com.rabi.link` phone app could obtain actual recognized speech text from Rokid glasses and trigger real TTS playback, rather than merely capture PCM or show text.

The tested design used one phone APK plus an embedded `com.rabi.link.glass` payload installed through CXR-L CustomApp. Phone-to-glasses commands and result messages used CXR CustomCmd and Rokid security SDK surfaces.

## Confirmed results

- CXR-L authorization, CustomApp installation, custom glasses UI, and bidirectional text commands worked.
- The tested glasses environment could not bind the expected Glass SDK security service. Glass SDK ASR, TTS, and offline commands were therefore not ready.
- Android `SpeechRecognizer` and `TextToSpeech` were unavailable inside the glasses payload.
- A 32-bit `armeabi-v7a` glasses APK could run alongside the CXR message bridge.
- Official RokidAiSdk 1.4.3 AARs and ASR assets could be packaged into that glasses APK.
- Asset, ABI, and microphone-permission gates passed, while the five required voice-product credentials remained absent.
- Safe readiness checks blocked startup without `key`, `secret`, `deviceTypeId`, `deviceId`, and `seed`.
- Phone SDK Classic Bluetooth, P2P, system-information, media, and message channels did not become ready on the tested pairing.
- Android phone-side ASR/TTS could work as an external bypass, but that did not prove use of the glasses microphone or native Rokid speech.

## Current interpretation

CXR-L is a useful device, UI, and command bridge. It is not itself a speech-recognition engine. RokidAiSdk resembles the full official ASR/TTS route, but it requires legitimate product credentials and environment-specific acceptance.

The practical RabiLink architecture should therefore keep CXR or AIUI as the glasses interaction layer and treat ASR/TTS as a separately owned service unless a licensed native route is proven.

## Safety and credential boundary

Do not derive credentials from installed applications, commit them to the repository, or confuse CXR tokens, `.lc` license files, account keys, and RokidAiSdk voice-product credentials. They belong to different products and authorization paths.

For the shorter feasibility summary, read [Rokid ASR/TTS communication findings](./rokid-asr-tts-communication-research_en.md). For the current probe surface, read the [device probe README](../README_en.md).
