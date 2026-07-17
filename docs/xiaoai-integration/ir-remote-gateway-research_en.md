<!-- docs-language-switch -->
<div align="center">
English | <a href="./ir-remote-gateway-research.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Research: Script-Controlled IR Gateways

> Status: research reference dated 2026-06-06. Product availability, firmware, Home Assistant support, and local APIs change; revalidate the exact model before purchasing or implementing.

The research goal was to choose an infrared gateway that is easy to buy in China and can be controlled reliably from a PC or local service for air conditioners, televisions, set-top boxes, and similar appliances.

## Recommendation summary

1. **BroadLink RM4 mini** — best default for a ready-made IR-only gateway. Widely available, supported by Home Assistant and `python-broadlink`, and well documented for local learning/sending.
2. **BroadLink RM4 Pro** — choose only when 315/433 MHz RF is also required. It costs more and RF compatibility/learning is less predictable.
3. **ESPHome/ESP32 plus IR transmitter/receiver** — best for developers who want a fully local, maintainable system and accept hardware assembly, power, enclosure, emitter-strength, and placement work.
4. **Xiaomi/Mijia universal remote** — conditional choice for an existing Xiaomi ecosystem after verifying the exact model and current `xiaomi_miio`/`python-miio` compatibility.
5. **Tuya IR devices** — not recommended as the first RabiRoute integration because local control and Home Assistant `remote` support are inconsistent and commonly depend on cloud scenes.
6. **USB IR/LIRC** — suitable for a fixed Linux host and low-level experimentation, but not the lowest-friction general deployment.

## Why BroadLink is the default

Home Assistant's BroadLink integration supports RM4-family remotes and provides `remote.learn_command` and `remote.send_command`. `python-broadlink` also exposes local learning and sending APIs for many RM devices.

Before buying:

- Verify the exact model and region.
- Confirm that local LAN access/device lock can be configured.
- Plan IR line-of-sight and emitter placement.
- Treat air-conditioner state as a local model unless the device provides trustworthy feedback.
- Export learned codes into a versioned, public-safe format without account credentials.

References:

- [Home Assistant Broadlink integration](https://www.home-assistant.io/integrations/broadlink/)
- [python-broadlink](https://github.com/mjg59/python-broadlink)

## ESPHome/ESP32 route

Use this when full local ownership matters more than convenience. A typical deployment exposes learned commands through Home Assistant, MQTT, or a small HTTP service.

Engineering tasks include:

- choosing an IR LED/driver with enough power;
- adding an IR receiver for learning;
- selecting GPIOs, power, enclosure, and placement;
- representing stateful appliances such as air conditioners;
- securing any HTTP/MQTT endpoint;
- building retry and observability around “command sent” versus “device state changed.”

## RabiRoute integration boundary

RabiRoute should not embed vendor libraries directly in the router. Prefer a device-control adapter/service:

```text
Handler decision
  -> RabiRoute external-action gate
  -> Home Assistant / local IR service / MQTT
  -> BroadLink or ESPHome device
```

The action request should identify a known device and command, not arbitrary shell or raw network code. High-impact operations require explicit authorization and audit. A transport success is not proof that the appliance changed state.

## Revalidation checklist

- Exact device SKU and firmware.
- Current local API/library support.
- Region/account requirements.
- LAN isolation and credential storage.
- Learning/send reliability from the intended physical location.
- Home Assistant entity/service behavior.
- State model and manual fallback.
- No real token, MAC, IP, account, or learned private code in public examples.
