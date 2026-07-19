<!-- docs-language-switch -->
<div align="center">
English | <a href="./mobile-message-endpoint.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Mobile Device Message Endpoint

The Rabi mobile device message endpoint is a new endpoint, separate from the Rokid AIUI / Lingzhu Agent MCP integration. The phone is the complete client and reliable backend. Glasses are optional microphone, speaker, HUD, camera, and touchpad peripherals. Without glasses, the phone still supports login, chat, continuous capture, ASR/TTS, attachments, notifications, configuration, and proactive messages.

## Initialized experience

- Before initialization, the app shows global RabiLink login, default Rabi PC, speech-model, and glasses authorization settings.
- After initialization, a ChatGPT-like chat screen is the default instead of a probe or settings dashboard.
- The header selects one of the route personas published by the default Rabi PC. Each persona has a separate visible conversation while RabiLink login and the phone service remain global.
- Text, microphone ASR messages, Agent TTS, images, video, standalone audio files, and arbitrary files share one private phone chat ledger. Attachments work in both directions and can be opened on the phone.
- Configuration Assistant is a mode of the same chat. Marked configuration requests go to the selected Rabi PC; writes, deletion, stopping, replacement, and external actions remain behind the RabiRoute action gate. Completion may be claimed only after a successful PC response and read-back verification.

## Foreground service and notifications

After connection, `RabiConversationService` owns the downlink cursor, durable queues, and phone/glasses I/O. It exposes two ongoing notifications: one opens chat, and one sends an immediate `rabilink.review_request`, matching a single AIUI touchpad tap. Ordinary and proactive Agent deliveries use separate normal notifications.

Agent notifications carry `routeProfileId`, so tapping one opens the matching persona conversation rather than whichever persona was previously selected. An app setting controls immediate Agent TTS playback. When disabled, the WAV remains in private chat storage and can be played by tapping its bubble.

## Phone and glasses modes

- Phone mode continuously captures 16 kHz mono PCM in an Android microphone foreground service, segments it with VAD, and uses configurable Rabi PC ASR/TTS.
- Glasses mode keeps CXR and the native message bridge in the foreground service and starts the glasses app. The glasses app records continuously after setup; the default action is immediate push, and one touchpad tap prompts the Agent. Capture pauses during TTS to suppress feedback. A lost phone message service reconnects automatically with a 1.5–30 second exponential backoff while retaining the manual reconnect action.
- Both modes share route personas, queues, cursor, chat history, ASR/TTS settings, and action gates. Enabling glasses does not create another account or conversation stack.

## Reliability and security

- Speech/control uplink: 48 hours, 2,000 items, stable IDs, automatic offline replay.
- Media uplink: 500 items, seven days, 64 MiB each; Relay app isolation and authenticated downloads.
- Downlink: durable cursor, delivery deduplication, PCM cache; a TTS item yields the head after three failures and remains retryable.
- Attachment-only downlink needs no fabricated body text: images, video, audio, and arbitrary files are downloaded, recorded in chat, and announced with a normal notification even when text is empty.
- ASR pauses after five consecutive failures and supports explicit retry.
- Device diagnostics retain at most 500 redacted, coarse events for seven days, write identical events at most once per minute, and never include chat text, transcripts, tokens, or request bodies.
- Reboot recovery first restores the cursor, durable queues, and both notifications as a `dataSync` foreground service. Where Android forbids microphone startup from a boot broadcast, opening the app resumes continuous capture without dropping queued messages.
- Tokens, chat, TTS, and attachments stay in app-private storage. PC-to-mobile files remain constrained by `allowedFileRoots`.

## Acceptance boundary

Android and TypeScript automation prove protocol, queue, and build behavior only. Release acceptance still requires a real Android phone and Rokid glasses for long-running background capture, lock/unlock recovery, CXR reconnection, physical touchpad input, live battery refresh, speaker acknowledgement, notification permission, and vendor battery-management behavior.

On 2026-07-18, phone-side smoke validation passed on a physical Xiaomi Android device: in-place APK install, initialized default chat, expired-login recovery, foreground service, both ongoing notifications, and a real tap on “Prompt Rabi” producing a durable control-queue item. No app crash or foreground-service permission failure was observed. Physical Rokid-glasses validation is still outstanding, so this does not establish full release validation.

`npm run check:rabilink:mobile` provides a stable repository audit for standalone chat, the phone backend, optional glasses, notifications, media, personas, speech, reboot recovery, retention of all 85 AIUI allowlisted configuration actions, and the Relay attachment regression.
