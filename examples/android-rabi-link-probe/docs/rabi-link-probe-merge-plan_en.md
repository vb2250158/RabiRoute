<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-link-probe-merge-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Rabi Link device-probe merge record

> Status: implemented architecture and naming record. It defines the single-phone-APK module model without promoting vendor probes to production features.

The project evolved from a Xiaomi wearable probe into a multi-device Rabi Link probe. The phone package remains:

```text
com.rabi.link
```

Xiaomi, Rokid, RabiRoute SDK, and future device integrations are modules inside one app shell. Source packages such as `modules/xiaomi` and `modules/rokid` are ownership boundaries, not separate phone applications.

## Shared model

- `DeviceModule` identifies a vendor or device integration.
- `Capability` describes an explicit test or action and its prerequisites.
- `ProbeResult` records status, summary, errors, time, and evidence paths.
- `BridgeEvent` gives UI, logs, and export code a vendor-neutral event shape.
- `DeviceModuleRegistry` lets the app shell discover modules without vendor-specific conditionals.

The home screen is an interface test center. Each module owns its permissions, actions, logs, and evidence export. Modules do not call each other directly.

## Current modules

The Xiaomi module covers public BLE/GATT, Health Connect, local Provider boundaries, cloud OAuth/SDK probes, and evidence packaging. Historical health data remains a research boundary rather than a promised API.

The Rokid module covers CXR-L authorization, connections, CustomView, audio, photos, controls, device information, status synchronization, and several native-voice hypotheses.

The RabiRoute SDK module exercises Manager discovery, Route bindings, Relay state, portable observations, and cursor-based downstream messages.

## Non-goals

The probe is not the production RabiRoute message endpoint, Codex Runtime, or MCP server. It does not make background sensing implicit, and it does not create a new phone APK for each device vendor.

See the [current probe README](../README_en.md) for practical boundaries and the [phone edge-hub design](../../../docs/rabilink-phone-edge-hub_en.md) for the broader architecture.
