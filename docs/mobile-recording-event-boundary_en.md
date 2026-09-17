# Mobile recording and event ownership

English | [简体中文](mobile-recording-event-boundary.md)

Configure watches, bands, and smart glasses in RabiLink mobile. The PC Route endpoint list, add menu, and quick setup no longer expose independent device entries. No replacement mobile-endpoint switch is introduced.

## Responsibilities

- Mobile recording owns device connections, permissions, capture selection, start/pause, records, and upload consent, using `RabiConversationService` and the existing controllers.
- Recording submits events that need processing to the selected PC/persona under the user's consent. RabiLink transports them; each peripheral does not require another Route configuration.
- RabiRoute validates source, destination, and authorization, records receipt, and routes events to the Agent. Existing modules retain health-history queries, transcription, and alert processing.

Device type is record-source metadata. Users do not add each device as a PC endpoint. Capture pause and upload controls follow the [all-day recording contract](rabilink-all-day-recording_en.md).

## Implementation and legacy retirement

This change removes the PC device configuration entries and establishes this architecture. Unified recording-event delivery still requires implementation and end-to-end acceptance; earlier device-path results do not validate it.

Existing clients, saved Routes, health history, and messages use internal keys such as `rabilink`, `wearable`, and `wearable_health_alert`. Read/transport compatibility remains to preserve history and authorized clients. Inputs are not automatically enabled and saved Route permissions are not rewritten. The standalone health-Route creation script is retired.

The only migration destination is mobile recording events. Retirement milestone: all supported clients use that contract, saved Routes and pending transport complete receipt-backed migration, and offline retries, deduplication, destination isolation, pause, and upload consent pass acceptance. Then remove legacy adapter registration, dedicated listeners, and configuration keys. Do not extend the old path. Until migration, old configuration is maintenance compatibility, not new-device setup guidance.
