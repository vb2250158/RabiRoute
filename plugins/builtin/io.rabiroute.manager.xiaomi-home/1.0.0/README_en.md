<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Xiaomi Home Manager plugin

RabiRoute's single `xiaomiHome` message endpoint. It uses the Home Assistant REST API for resource discovery and state reads, subscribes to state changes over WebSocket, and exposes typed capability actions, motion events, and a local camera artifact ledger.

## Configuration and authorization

In WebGUI, add **Xiaomi Home** to the current Route under **Message Adapters**, then expand that message endpoint to configure Home Assistant. Before the first save, the complete configuration comes from the plugin Profile. After the first save, the complete local `settings.json` in the Xiaomi Home runtime directory becomes the single runtime source. Manager writes it atomically with optimistic revision checks and hot-loads the client, event monitor, and capture worker.

The settings file contains only the Home Assistant address, environment-variable names, entity IDs, and safety policy. It never stores OAuth credentials or token values. Configure these only in the trusted local runtime environment:

- `RABIROUTE_XIAOMI_HOME_HA_TOKEN`: a Home Assistant long-lived access token.
- `RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN`: a separate Bearer token for Agent access to local recording artifacts.

Every PUT/POST mutation requires the current Manager identity from `/meta` in these headers:

- `x-rabiroute-expected-application-generation-id`
- `x-rabiroute-expected-manager-instance-id`

WebGUI uses relative Manager APIs and refreshes `/meta` before each save. It never fixes or scans a Manager port.

An authorized LAN WebGUI may read health and save this message-endpoint configuration. Device inventory, control actions, and recording-content APIs remain loopback-only.

`writeEnabled` defaults to `false`. Verify the address, token, resource inventory, and event subscription in read-only mode before enabling control. Actions additionally require an `Idempotency-Key` and the latest `expectedStateVersion`.

By default, the address policy accepts only `localhost` (pinned to a loopback literal) or literal loopback, private, or link-local IPv4/IPv6 addresses. This prevents DNS rebinding from carrying the Home Assistant Bearer token to another target. Ordinary hostnames, including `.local`, require an explicit `allowPublicBaseUrl` opt-in, which means the operator trusts that hostname's resolution. The address cannot contain credentials, a path, query, or fragment, and REST requests never follow redirects.

Each device action binds its complete intent to a durable `Idempotency-Key` receipt. Concurrent requests and Manager restarts only read or recover that receipt; a different intent conflicts. If the external result is uncertain, recovery performs Home Assistant state reads only and stops without automatically resending the action when the result cannot be proven.

## Events and camera recordings

`eventDeliveryMode=significant` emits offline, event, and motion alerts only. Add camera motion entities to `cameraMotionEntityIds` only after enumerating real Home Assistant resources.

The official Xiaomi Home integration does not expose camera images or streams. The community path can consume Xiaomi Miot Auto `motion_video_*` attributes: the capture worker downloads HTTPS HLS only from `cameraClipAllowedHosts`, handles AES-128 segments, merges MP4 locally, and registers an artifact. Capture is disabled by default and the host allowlist must come from a real event URL.

Read artifact metadata from `/api/agent/xiaomi-home/artifacts` and content from `/api/agent/xiaomi-home/artifacts/:artifactId/content`. Content access requires the artifact token, supports HTTP Range, and writes an access audit. Temporary cloud URLs and local filesystem paths are never handed directly to the Agent.
