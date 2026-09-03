<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Xiaomi Home Manager plugin

RabiRoute's single `xiaomiHome` message endpoint. It uses the Home Assistant REST API for resource discovery and state reads, subscribes to state changes over WebSocket, and exposes typed capability actions, motion events, and a local camera artifact ledger.

## Configuration and authorization

In WebGUI, add **Xiaomi Home** to the current Route under **Message Adapters**. Its connection card submits the Home Assistant address and long-lived access token; its policy card controls events, device actions, and recordings. Before the first save, settings come from the plugin Profile. Afterward, local `settings.json` is the policy-settings source of truth. Manager uses revision fencing and atomic writes to hot-load the client, event monitor, and capture worker.

A protected local credential store is the sole login source: current-user DPAPI on Windows, or an access-restricted local key plus AES-256-GCM elsewhere. Route configuration, settings, logs, and API responses never persist or echo plaintext tokens. Authentication requests require the current Manager lifecycle fence and a stable `Idempotency-Key`; the address and candidate token are verified together before they are committed. Recording artifacts retain a separate read credential:

- `RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN`: a separate Bearer token for Agent access to local recording artifacts.

Every PUT/POST mutation requires the current Manager identity from `/meta` in these headers:

- `x-rabiroute-expected-application-generation-id`
- `x-rabiroute-expected-manager-instance-id`

WebGUI uses relative Manager APIs and refreshes `/meta` before each save. It never fixes or scans a Manager port.

An authorized LAN WebGUI may read health and save this message-endpoint configuration. Device inventory, control actions, and recording-content APIs remain loopback-only.

`writeEnabled` defaults to `false`. Verify the address, token, resource inventory, and event subscription in read-only mode before enabling control. Actions additionally require an `Idempotency-Key` and the latest `expectedStateVersion`.

By default, the address policy accepts `localhost` (pinned to a loopback literal) and literal loopback, private, or link-local IPv4/IPv6 addresses. This prevents DNS rebinding from carrying the Home Assistant Bearer token to another target. Every non-loopback target requires HTTPS by default. Private-network HTTP needs the explicit `allowInsecurePrivateHttp` compatibility switch and accepts that a token can be intercepted on the LAN; public targets always require HTTPS. Ordinary hostnames, including `.local`, require an explicit `allowPublicBaseUrl` opt-in, which means the operator trusts that hostname's resolution. The address cannot contain credentials, a path, query, or fragment, and REST requests never follow redirects.

Each device action binds its complete intent to a durable `Idempotency-Key` receipt. Concurrent requests and Manager restarts only read or recover that receipt; a different intent conflicts. If the external result is uncertain, recovery performs Home Assistant state reads only and stops without automatically resending the action when the result cannot be proven.

## Events and camera recordings

`eventDeliveryMode=significant` emits offline, event, and motion alerts only. Add camera motion entities to `cameraMotionEntityIds` only after enumerating real Home Assistant resources.

The official Xiaomi Home integration does not expose camera images or streams. The community path can consume Xiaomi Miot Auto `motion_video_*` attributes: the capture worker downloads HTTPS HLS only from `cameraClipAllowedHosts`, handles AES-128 segments, merges MP4 locally, and registers an artifact. Capture is disabled by default and the host allowlist must come from a real event URL.

Read artifact metadata from `/api/agent/xiaomi-home/artifacts` and content from `/api/agent/xiaomi-home/artifacts/:artifactId/content`. Content access requires the artifact token, supports HTTP Range, and writes an access audit. Temporary cloud URLs and local filesystem paths are never handed directly to the Agent.
