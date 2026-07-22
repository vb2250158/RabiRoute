<!-- docs-language-switch -->
<div align="center">
English | <a href="./mobile-message-endpoint.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Mobile Device Message Endpoint

The Rabi mobile device message endpoint is a new endpoint, separate from the Rokid AIUI / Lingzhu Agent MCP integration. The phone is the complete client and reliable backend. Glasses are optional microphone, speaker, HUD, camera, and touchpad peripherals. Without glasses, the phone still supports login, chat, continuous capture, ASR/TTS, attachments, notifications, configuration, and proactive messages.

## Initialized experience

- Before initialization, the app shows global RabiLink login, default Rabi PC, speech-model, and glasses authorization settings.
- After initialization, a QQ-style conversation list is the default. Each row shows an avatar, contact name, latest message, time, and per-conversation unread count. Tapping a contact opens chat; Back returns to the same list so another persona can be selected.
- Contacts come only from Routes that expose the `rabilink` message adapter. Wearable-health and other non-chat Routes are never treated as personas. A disabled RabiLink Route explains why it cannot chat and links to configuration.
- The detail header contains only Back, the current identity, and a trustworthy connection state. Messages are grouped by date, keep sender/time outside bubbles, use explicit speech/configuration/file labels, and open local attachments.
- Attachment, composer, and Send controls use one 52dp component height. Multiline input, keyboard Send, and per-conversation draft restoration are supported.
- Each conversation owns its read position, so opening A never clears B. Legacy messages without a Route are migrated once to one deterministic conversation instead of appearing under every persona.
- Text, microphone ASR messages, Agent TTS, images, video, standalone audio files, and arbitrary files share one private phone chat ledger. Attachments work in both directions and can be opened on the phone.
- Configuration no longer shares the normal chat composer. Known fields are edited in Settings or remote WebGUI; unknown fields use a separate Configuration Assistant launched from Settings. Marked requests still use the selected Rabi PC, action gate, and success/read-back requirement.

## Foreground service and notifications

After connection, `RabiConversationService` owns the downlink cursor, durable queues, and phone/glasses I/O. It exposes two ongoing notifications: one opens chat, and one sends an immediate `rabilink.review_request`, matching a single AIUI touchpad tap. Ordinary and proactive Agent deliveries use separate normal notifications.

Agent notifications are stable per conversation and carry `routeProfileId`. Tapping one uses `singleTop` to open the exact persona; Back returns to the conversation list. A newer message updates the same conversation notification, and opening the detail marks it read and clears it. An app setting controls immediate Agent TTS playback. When disabled, the WAV remains in private chat storage and can be played by tapping its bubble.

## Phone and glasses modes

- Phone mode continuously captures 16 kHz mono PCM in an Android microphone foreground service, segments it with VAD, and uses configurable Rabi PC ASR/TTS. “Continuous” means resident capture plus durable segmented upload; the app does not broadcast one raw 24-hour stream. Completed ASR segments and Agent TTS are cached per file for a rolling 24-hour window.
- Glasses mode keeps CXR and the native message bridge in the foreground service and starts the glasses app. The glasses app records continuously after setup; the default action is immediate push, and one touchpad tap prompts the Agent. Capture pauses during TTS to suppress feedback. A lost phone message service reconnects automatically with a 1.5–30 second exponential backoff while retaining the manual reconnect action.
- Both modes share route personas, queues, cursor, chat history, ASR/TTS settings, and action gates. Enabling glasses does not create another account or conversation stack.
- The phone remains the reliable conversation owner, while the durable queue freezes the real source of every input. Glasses microphone audio, photos, and touchpad review requests use `sourceDeviceKind=glasses` and `sourceDeviceId=rabi-glass`; phone input remains `phone`. Both keep `sessionId=rabi-phone`, so agents and audits can distinguish the device without treating a device switch as a new conversation.
- `RabiConversationService` is the single owner of input mode, with only `PAUSED`, `PHONE`, and `GLASSES`. Applying settings always stops the non-target capture path first: glasses mode pauses phone `AudioRecord`, phone mode closes the CXR/Phone SDK glasses bridge, and disabling continuous listening stops both paths. Two microphones therefore cannot continue uploading in parallel after a mode switch.

## Reliability and security

- Speech/control uplink: 48 hours, 2,000 items, stable IDs, automatic offline replay.
- Text and media freeze both `routeProfileId` and `clientMessageId` before entering a background queue. The UI reports queued, sending, handed to Rabi PC, or a concrete failure; later navigation cannot retarget queued work.
- Media uplink: 500 items, seven days, 64 MiB each; Relay app isolation and authenticated downloads.
- Downlink: durable cursor, delivery deduplication, PCM cache; a TTS item yields the head after three failures and remains retryable.
- Glasses voice delivery is acknowledged only when the phone SDK is initialized, the device is authenticated, and both the Classic BT message and audio channels are online. If the channel is not ready, delivery fails into the existing deferred retry path instead of advancing the cursor merely because an SDK object exists.
- The phone and glasses APKs share `RabiGlassAudioProtocol` as the single source for commands, message prefixes, client ID, and the audio stream tag; neither packaged side keeps a duplicate protocol literal set.
- Attachment-only downlink needs no fabricated body text: images, video, audio, and arbitrary files are downloaded, recorded in chat, and announced with a normal notification even when text is empty.
- ASR pauses after five consecutive failures and supports explicit retry.
- Device diagnostics retain at most 500 redacted, coarse events for seven days, write identical events at most once per minute, and never include chat text, transcripts, tokens, or request bodies.
- Phone capture supervision: `RabiPhoneAudioCapture` exclusively owns `AudioRecord`, a partial wake lock, durable capture metrics, a 45-second stall detector, and bounded 1–30 second restart backoff. `RabiConversationService` only coordinates transport, notifications, and phone/glasses mode. Chat shows session duration, latest audio age, cumulative PCM bytes, and automatic recovery count.
- Audio cache and records: mobile and PC RabiSpeech now share the contract of per-file 24-hour retention, safe relative paths, `audio_expires_at`, and append-only ASR/TTS metadata. Android app-private storage separates `audio-cache/asr-audio/`, `audio-cache/tts-audio/`, and daily JSONL under `speech-records/`. The 48-hour durable upload queue remains a separate responsibility and is neither a playback cache nor a history archive.
- Reboot recovery first restores the cursor, durable queues, and both notifications as a `dataSync` foreground service. Where Android forbids microphone startup from a boot broadcast, opening the app resumes continuous capture without dropping queued messages.
- Tokens, chat, TTS, and attachments stay in app-private storage. PC-to-mobile files remain constrained by `allowedFileRoots`.

## Acceptance boundary

Android and TypeScript automation prove protocol, queue, and build behavior only. Release acceptance still requires a real Android phone and Rokid glasses for long-running background capture, lock/unlock recovery, CXR reconnection, physical touchpad input, live battery refresh, speaker acknowledgement, notification permission, and vendor battery-management behavior.

Use `apps/rabilink-android/scripts/Test-RabiMobileAudioSoak.ps1` for the phone-side 24-hour acceptance run. It periodically reads the foreground-service state and app-private capture metrics, preserves JSONL evidence, and checks service residency, latest-audio age, and continued PCM-byte growth. Run it on every target release device class; an emulator or a successful build is not equivalent evidence.

On 2026-07-18, phone-side smoke validation passed on a physical Xiaomi Android device: in-place APK install, initialized default chat, expired-login recovery, foreground service, both ongoing notifications, and a real tap on “Prompt Rabi” producing a durable control-queue item. No app crash or foreground-service permission failure was observed. Physical Rokid-glasses validation is still outstanding, so this does not establish full release validation.

The 2026-07-22 code-side closeout added durable phone/glasses source attribution and the glasses audio-channel delivery gate. The mobile audit, Relay media regression, and both phone and glasses APK builds pass. This still does not replace physical Rokid verification for the touchpad, continuous capture, reconnection, and speaker playback.

`npm run check:rabilink:mobile` provides a stable repository audit for standalone chat, the phone backend, optional glasses, notifications, media, personas, speech, reboot recovery, retention of all 85 AIUI allowlisted configuration actions, and the Relay attachment regression.
