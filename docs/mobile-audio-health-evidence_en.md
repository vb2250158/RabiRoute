# Mobile audio health evidence

English | [简体中文](mobile-audio-health-evidence.md)

With valid-event segmentation, continuous listening does not imply continuous file writes. `Test-RabiMobileDurableAudioSoak.ps1` and `Test-RabiMobileDurableAudioFaults.ps1` no longer use `lastWrittenAt` or `nextSequence` progress as microphone-health evidence.

## Existing metrics and scope

The scripts read only `active`, `lastSampleAt`, `totalBytes`, and `startedAt` from `rabi_phone_audio_capture.xml`. `RabiPhoneAudioCapture.persistRuntime` writes these fields: the sample timestamp derives from actual AudioRecord reads using monotonic time, and bytes count raw PCM reads, not persisted valid events. Health requires active capture and fresh reads; progress checks both sample time and raw byte count.

These metrics cover the phone microphone only. Glasses input, missing/stale metrics, or counter rollback cannot establish capture health. Fault injection stops before device operations if fresh evidence is unavailable. Restart recovery requires a post-restart sample timestamp and positive bytes, rather than counter monotonicity across processes.

## Separate result dimensions

- Silence can demonstrate continued reads without new files/uploads. `audioQualityVerified=false`; this is not sound-quality or transcription acceptance.
- Upload progress and transport validation are required only when new valid events or existing pending segments are observed. No new events reports `not_exercised_no_new_valid_events`.
- Without an observed partial file, the fault test does not require an increased recovery counter and explicitly reports that branch unexercised, not crash-recovery success.
- Existing hash, sequence and persisted-byte conservation checks remain. Persisted-byte conservation excludes raw silence discarded by acoustic admission.
- Upload validation still targets the legacy stream ACK contract. Event-ASR receipts are not stream ACKs; missing stream-contract evidence cannot establish end-to-end event upload success.

The helper tests use in-memory fixtures and never connect to a device. Real soak/fault scripts affect live environments and must not be run merely to validate these edits.
