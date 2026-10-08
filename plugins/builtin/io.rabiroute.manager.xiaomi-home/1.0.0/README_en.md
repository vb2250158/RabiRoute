<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Xiaomi Home Manager plugin

Xiaomi Setup also offers an [experimental vacuum cloud map connection](../../../../docs/vacuum-cloud-map_en.md). The same provider protects the QR session and shares read-only device and raw file APIs with Agents. Version-2 decoding and map display are available, with unverified pose freshness. Coordinate navigation and robot audio are not provided yet; no background map polling is added; the page can explicitly enable5/10/30-second refresh.

RabiRoute's single `xiaomiHome` message endpoint. It uses the Home Assistant REST API for resource discovery and state reads, subscribes to state changes over WebSocket, and exposes typed capability actions, motion events, and a local camera artifact ledger.

## Configuration and authorization

Connection failures and authorization guidance appear in the connection card. Event monitoring status and its check action sit beside the monitoring switch; disabled recording shows “Off”; device control becomes available after connection. The Xiaomi card keeps only its overall status at the top, without a duplicate environment/dependency alert list. Unsaved switch changes are marked separately rather than presented as active settings.

### Home Assistant installation and startup

Installation shows the current phase and a progress bar. Downloads display a percentage and received / total bytes measured from the actual stream. Administrator approval, Hyper-V enablement, image verification, extraction, VM creation and network waiting use an indeterminate bar, without estimating overall completion. The page subscribes to installer status changes through the loopback-only `GET /api/agent/xiaomi-home/deployment/events`, restores the current status after refresh and releases its subscription when closed. A required reboot or failure stops the progress bar and displays the corresponding explanation. Completed installation still requires a separate service readiness check.

The connection card includes an installation and startup panel. Select a local Docker container and enter its name to inspect the official image, container location, and actual `/config` mount source. An unavailable engine produces an unknown installation status; only an absent named container is reported as not found. The Setup tab installs Home Assistant OS into the displayed preset local path: enable Hyper-V, download the official stable VHDX, verify SHA256, create a 2-core/2-GiB VM and expose it only at local 127.0.0.1:8123. Windows requests administrator approval. If a reboot is required, installation pauses; click Install again after reboot. The fixed directory is home-assistant-os/ beneath the local Xiaomi runtime directory. Existing Docker containers retain detection and startup only; Docker Desktop is not installed automatically. Select external service for a separately managed VM or remote installation.

Saving with autostart enabled runs a startup check immediately and repeats it when the Xiaomi Home plugin starts. On Windows, startup attempts the official `docker desktop start` command if the engine is unavailable. Only official Home Assistant images with a local published `8123/tcp` endpoint matching the saved URL can be started, using the inspected immutable container ID. Operations are serialized and reuse ready containers. Readiness waits up to 60 seconds; failures remain visible and can be retried. Closing Rabi cancels waiting but leaves Home Assistant and Docker running for other consumers.

Local `home-assistant-deployment.json` owns the deployment binding and autostart setting, separately from credentials and Route policy. `GET/PUT /api/agent/xiaomi-home/deployment` and `POST /api/agent/xiaomi-home/deployment/start` and `POST /api/agent/xiaomi-home/deployment/install` are loopback-only. Mutations require the current Manager lifecycle fence and deployment revision. Startup is an idempotent desired-state operation. Login and token links become available only when the saved endpoint is ready. Authorize the Xiaomi account in the [official Xiaomi integration](https://github.com/XiaoMi/ha_xiaomi_home).

In WebGUI, add **Xiaomi Home** to the current Route under **Message Adapters**. Its connection card submits the Home Assistant address and long-lived access token; its policy card controls events, device actions, and recordings. Before the first save, settings come from the plugin Profile. Afterward, local `settings.json` is the policy-settings source of truth. Manager uses revision fencing and atomic writes to hot-load the client, event monitor, and capture worker.

A protected local credential store is the sole login source: current-user DPAPI on Windows, or an access-restricted local key plus AES-256-GCM elsewhere. Route configuration, settings, logs, and API responses never persist or echo plaintext tokens. Authentication requests require the current Manager lifecycle fence and a stable `Idempotency-Key`; the address and candidate token are verified together before they are committed. Recording content reuses Manager connection authentication without another token.

Every PUT/POST mutation requires the current Manager identity from `/meta` in these headers:

- `x-rabiroute-expected-application-generation-id`
- `x-rabiroute-expected-manager-instance-id`

WebGUI uses relative Manager APIs and refreshes `/meta` before each save. It never fixes or scans a Manager port.

An authorized LAN WebGUI may read health and save this message-endpoint configuration. Device inventory, control actions and recording content reuse connection authentication. Installation operations remain local.

A working Home Assistant connection can use supported device actions without another control switch. Actions still use stable idempotency keys and current state versions.

By default, the address policy accepts `localhost` (pinned to a loopback literal) and literal loopback, private, or link-local IPv4/IPv6 addresses. This prevents DNS rebinding from carrying the Home Assistant Bearer token to another target. Every non-loopback target requires HTTPS by default. Private-network HTTP needs the explicit `allowInsecurePrivateHttp` compatibility switch and accepts that a token can be intercepted on the LAN; public targets always require HTTPS. Ordinary hostnames, including `.local`, require an explicit `allowPublicBaseUrl` opt-in, which means the operator trusts that hostname's resolution. The address cannot contain credentials, a path, query, or fragment, and REST requests never follow redirects.

Each device action binds its complete intent to a durable `Idempotency-Key` receipt. Concurrent requests and Manager restarts only read or recover that receipt; a different intent conflicts. If the external result is uncertain, recovery performs Home Assistant state reads only and stops without automatically resending the action when the result cannot be proven.

## Events and camera recordings

For speaker announcements, media arguments and durable receipt lookup, see the [home device Agent API](../../../../docs/home-device-agent-api_en.md). Settings owns `speechBindings`; media actions require HA features and acceptance does not prove audibility. Intent binds the current HA origin; legacy receipts remain readable and legacy digests conflict on resubmission.

`eventDeliveryMode=significant` emits offline, event, and motion alerts by default. The event listener internally supports selected entity changes, but the settings API does not expose `monitoredEntityIds`; do not add it to settings. `all` mode enables actual state changes for other entities; ordinary attribute refreshes do not emit state-change events. Add camera motion entities to `cameraMotionEntityIds` only after enumerating real Home Assistant resources.

Event history remains in the owning persona's `xiaomi-home-events.jsonl`, using event `occurredAt` for `time`/`isoTime`. Manager appends asynchronously through one writer queue (up to 64 pending events, at most 256 KiB per record), without recreating missing role directories. Failed writes emit privacy-bounded audits while event routing continues. History retains append semantics without cross-restart deduplication guarantees; this change adds no automatic rotation, archival, deletion or historical migration.

The official Xiaomi Home integration does not expose camera images or streams. The community path can consume Xiaomi Miot Auto `motion_video_*` attributes: the capture worker downloads HTTPS HLS only from `cameraClipAllowedHosts`, handles AES-128 segments, merges MP4 locally, and registers an artifact. Capture is disabled by default and the host allowlist must come from a real event URL.

Read artifact metadata from `/api/agent/xiaomi-home/artifacts` and content from `/api/agent/xiaomi-home/artifacts/:artifactId/content`. Content access requires the artifact token, supports HTTP Range, and writes an access audit. Temporary cloud URLs and local filesystem paths are never handed directly to the Agent.

### HA OS installation boundaries

Startup follows the Hyper-V checkpoint disk chain to verify ownership. Checkpoints in the installation directory that lead to the managed base disk are accepted; external disks and cyclic chains are rejected.

Local `127.0.0.1:8123` forwards to the current HA OS default HTTP port `80`, including its first-run landing page. Existing managed forwarding is migrated using the installation receipt; another application's forwarding is never replaced.

The preset directory must be on a fixed local disk without reparse points. Download requires at least 40 GiB of free space and accepts only an official GitHub stable release VHDX ZIP with SHA256. Existing disks and foreign VMs are never overwritten. An occupied local port stops installation. A dedicated mutex prevents concurrent creation. Windows is never rebooted automatically and no LAN firewall rule is added. Manager verifies HTTP readiness separately from installation. The user completes onboarding, the Home Assistant account and Xiaomi authorization.

The Windows VM autostart option is applied by Hyper-V during installation or startup. If the VM address changes after reboot, use Start and check to refresh the loopback forwarding. Canceled administrator approval, download failure and unsupported environments remain visible. Cross-reboot recovery and physical VM startup still require acceptance on the target Windows host.

## All-device queries and control

Query all imported HA entities and discover live buttons, settings and structured actions through the [device API](../../../../docs/home-device-agent-api_en.md). `home.entity.action@1` shares connection authentication, lifecycle/state/schema checks and durable receipts with existing actions. Upstream media-stream and map limitations remain explicit.

The Xiaomi section adds Device list with HA registry-grouped cards, entity states, Agent capabilities and parameter preview/action tests. Vacuum details offer refreshed map snapshots and coordinate selection; navigation payloads remain unverified. See the [device guide](../../../../docs/user-guide/home-devices_en.md).


Map manual controls and Agents share `/vacuum-remote` sessions with physical actions still owned by HA. Enter confirms paused cleaning, then initializes forward/turn/release controls. Video has no playback time limit and allows explicit reconnect after relay failures. See the [device API](../../../../docs/home-device-agent-api_en.md).
