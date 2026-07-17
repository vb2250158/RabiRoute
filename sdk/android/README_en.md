<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Android SDK

> Status: experimental SDK. The RabiLink Android probe consumes the source directly, but no standalone Maven or Gradle artifact is published.

The first native SDK uses Kotlin, `HttpURLConnection`, and `org.json` without Retrofit.

## Current capabilities

- Scan the LAN for RabiRoute Managers and RabiLink callbacks.
- Read instance GUID, name, device metadata, and version.
- List Routes and Agent options, then update a Route's Agent binding.
- Deliver local RabiLink messages, send replies, read downstream messages, and run a bidirectional smoke test.
- Claim Relay tasks, append messages, and complete tasks.
- Read and select Relay-connected PCs and configure mobile Route bindings.
- Publish portable-device observations, read proactive or normal messages, and report device status.

The methods are synchronous. Android applications must call them off the main thread and handle permissions, lifecycle, timeouts, and user consent.

## LAN binding

The Manager listens on `127.0.0.1` by default. To make it discoverable from Android, bind it explicitly to the LAN and configure the host firewall:

```powershell
$env:GATEWAY_MANAGER_HOST="0.0.0.0"
npm run start:manager
```

Do not expose an unauthenticated local management surface to an untrusted network.

## Consumption

There is no published dependency coordinate. `examples/android-rabi-link-probe` imports this source tree through a Gradle `sourceSet`:

```text
sdk/android/rabiroute-sdk/src/main/java
```

[`RabiRouteSdk.kt`](./rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt) is the implementation source of truth.
