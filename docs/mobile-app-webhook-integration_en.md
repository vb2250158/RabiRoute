<!-- docs-language-switch -->
<div align="center">
English | <a href="./mobile-app-webhook-integration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Historical Mobile-App Webhook Integration

> Status: historical. The early phone-bridge/mobile-API design is no longer the primary RabiLink path. Use [RabiLink Relay](rabilink-relay-server_en.md) and [Phone Edge Hub](rabilink-phone-edge-hub_en.md) for the current direction.

This document originally explored a mobile app connecting to a local RabiRoute through public HTTPS and WebSocket endpoints when the phone was outside the LAN.

The proposed topology was:

```text
Mobile app
  -> public reverse proxy
  -> local RabiRoute mobile/webhook adapter
  -> handler
  -> mobile outbox queue
  -> app WebSocket
```

The repository still has generic webhook and RabiLink-compatible POST input, so a phone can submit a text-like event to a configured endpoint. However, the historical `/api/mobile/*` session model, phone-owned outbox, and phone bridge are not current product APIs.

## Current replacement

The current RabiLink direction is:

```text
Device or AIUI
  -> public RabiLink Relay application
  -> PC RabiLink worker
  -> unified role conversation ledger
  -> Codex review when appropriate

Codex / scheduler / planner
  -> RabiRoute Outbox policy
  -> persistent Relay downlink queue
  -> device cursor consumption
```

The Relay management page creates an application token. The PC worker uses that token and a stable PC identity to register, claim work, proxy remote RibiWebGUI, and publish downlink messages. The phone may provide networking, notifications, credentials, and peripheral fan-out, but it does not own the Agent, ledger, or configuration truth.

## What remains useful from the historical design

- Public ingress must terminate TLS and authenticate every application/device.
- Mobile delivery needs per-device cursors and durable state, not an in-memory socket-only queue.
- A phone is a message endpoint, not an Agent runtime.
- External replies must still pass RabiRoute policy and Outbox.
- Public examples must use placeholders and never expose tokens, private messages, or local paths.

## Do not implement from this document without revalidation

- `rabi.example.com` example hostnames.
- `/api/mobile/messages`, `/api/mobile/sessions`, or a phone-owned outbox.
- A phone bridge as the mandatory route between AIUI and the Relay.
- Any design that exposes the local Manager directly to the public Internet.

The detailed Chinese page is retained as an architectural record, not as an implementation contract.
