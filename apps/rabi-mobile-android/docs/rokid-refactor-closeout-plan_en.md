<!-- docs-language-switch -->
<div align="center">
English | <a href="./rokid-refactor-closeout-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rokid module refactor closeout

> Status: completed refactor record. It validates module ownership and build structure, not a completed native Rokid ASR/TTS loop.

This closeout covers the Rokid phone-side probe inside the single `com.rabi.link` APK. Xiaomi work, production RabiRoute delivery, MCP integration, and a standalone glasses product were outside its scope.

The refactor separated CXR callback installation, link state, defaults, audio buffering, evidence storage, UI, and report formatting from the CXR controller. The controller remains the narrow façade for SDK operations.

Completed owners include:

- `RokidCxrCallbacks` for link, CustomView, audio, and image callbacks.
- `RokidCxrLinkState` for CXR and glasses Bluetooth state.
- `RokidProbeDefaults` for test parameters and display text.
- Dedicated audio, photo, environment, UI, report, and clipboard helpers.

The acceptance target was one phone APK with the `com.rabi.link` package, a successful debug assembly, and no return to obsolete module names. The embedded `com.rabi.link.glass` test payload was added later for explicit glasses-side experiments and does not change the one-phone-APK rule.

See the [probe README](../README_en.md) for current capabilities and the [native voice ledger](./rokid-native-asr-tts_en.md) for speech results.
