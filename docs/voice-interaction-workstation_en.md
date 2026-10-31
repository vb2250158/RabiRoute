<!-- docs-language-switch -->
<div align="center">
English | <a href="./voice-interaction-workstation.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Voice interaction workstation

RabiSpeech owns audio capture, transcription, persona voices and playback. FenneNote and OumuQ are retired; their transcription webhooks, separate playback services and wiring instructions are no longer configuration entry points.

1. Select a server and available ASR/TTS models in Speech service. That service owns microphone, segmentation and threshold settings.
2. Enable the speech message endpoint on a message route and choose hot delivery or persona keyword activation. Manual ASR API calls return results without notifying an Agent.
3. Maintain `voice_transcript` rules under Speech service in Persona configuration → Automation → Message rules.
4. Persona voices belong to `voice/voice-profile.json`. Replies and task-completion announcements use the shared TTS service and host playback queue.

Use these current guides for configuration and acceptance:

- [Speech service and models](rabispeech-plugin_en.md): models, voices, recording, playback and actual audio checks.
- [Speech message endpoint](speech-message-endpoint-design_en.md): route subscriptions, hot delivery, keywords and message recording.
- [Speech API](user-guide/speech-api_en.md): speech calls from authenticated clients.

Historical transcripts retain their original source identifiers for search and traceability. These names do not indicate that an old service is running. Preserve existing voice rules; deleting `voice_transcript` rules is not a way to remove an obsolete UI label.
