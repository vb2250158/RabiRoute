<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-glasses-app-design.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Historical RabiLink Native-App Design

> Status: historical/evolution design. Its first-release assumption—using the phone as the resident recording bridge—has been partly superseded by AIUI-to-Relay application calls, foreground native ASR/TTS, and the separate phone edge-hub boundary.

This document remains useful as a product and UI exploration, but it is not the current implementation contract.

## Original product direction

```text
Phone app
  = primary application, resident recording/transcription bridge,
    configuration console, Relay/local-Agent connector

Glasses app
  = low-interruption AR HUD, status, and lightweight controls

RabiLink Lab
  = advanced diagnostics and experimental probes
```

The goal was a continuous, auditable context layer rather than a wake-word command bot: the user speaks naturally, the system preserves context, and the PC Agent can reply to phone and glasses.

## What changed

Later device evidence established a more direct current path:

- AIUI can call Relay HTTPS at the application layer while using the phone-provided network path underneath.
- Foreground AIUI can use native ASR/TTS and a cursor-based downlink queue.
- The phone is an edge communication hub, not the mandatory owner of every AIUI message.
- CXR-L does not provide an AIUI message/audio/configuration bridge.
- True background capture still requires a phone/Android foreground service, FenneNote, or another resident collector.

## Durable design ideas

- Keep the PC as the owner of role context, configuration, unified ledger, and action policy.
- Treat phone and glasses as endpoints with independent IDs, cursors, and local state.
- Use a persistent Relay mailbox rather than assuming a continuous socket.
- Separate observation capture from Agent review and from user-facing downlink.
- Keep the HUD glanceable: connection, listening, pending work, latest useful response, and explicit privacy state.
- Make recording, transcript retention, external action, and deletion separate permissions.
- Preserve a diagnostics/lab surface without making it the normal user path.

## Current references

Use these documents for implementation decisions:

- [RabiLink Active-Intelligence Requirements](rabilink-active-intelligence-requirements_en.md)
- [AIUI Residency Boundary](rabilink-aiui-residency-plan_en.md)
- [Phone Edge Hub](rabilink-phone-edge-hub_en.md)
- [RabiLink Relay](rabilink-relay-server_en.md)

The detailed Chinese design is retained for historical UI/state-machine ideas. Revalidate any phone-first architecture, API path, or platform assumption before implementing it.
