<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-relay-server.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Public Relay

> Maturity: experimental. Relay, PC worker, remote WebGUI, input/downlink mailboxes, device logs, and the unified ledger have implementations. Real public-network, account-isolation, device, and recovery acceptance is still required.

The Relay is a built-in system transport owned by Manager, not a message adapter. In the primary native-app route, glasses exchange audio/media only with the phone backend; the phone calls Relay, while the PC worker owns the Route-facing `rabilink` path. Ordinary observations may still enter the record-first ledger. Phone/glasses speech instead uses restricted `audio-streams/rabilink/start|chunk|stop` endpoints to forward continuous PCM to target-PC RabiSpeech. VAD, segmentation, ASR, and voiceprint processing run on the PC; Manager then stores one host-wide speech record and delivers it to the frozen RabiLink Route. Replies use the independent downlink and default to the originating device.

The same Relay exposes a restricted RabiSpeech API. `health`, models, `audio/speech`, and `audio/transcriptions` are synchronous model calls that do not enter an Agent. `audio-streams/rabilink/*` is the formal Android speech path: after target-PC recognition, RabiSpeech automatically enters the host-wide store and Route delivery. `POST /api/rabilink/speech/messages` remains only a completed-ASR compatibility/debug endpoint. See [RabiSpeech local TTS / ASR service](rabispeech-plugin_en.md).

```text
Speech uplink
  glasses / phone microphone -> phone backend
  -> restricted ordered PCM stream -> PC worker
  -> RabiSpeech VAD / segmentation / ASR / voiceprint
  -> host-wide speech store -> rabilink Route -> persona context

Ordinary uplink
  text / control / media / compatibility input -> Relay mailbox
  -> PC worker -> unified conversation ledger -> later review

Downlink
  Codex/scheduler/planner -> RabiRoute Outbox policy
  -> Relay persistent messages -> phone cursor consumption
  -> Rabi PC TTS -> phone -> glasses PCM playback
```

The phone owns glasses transport state, not the Agent, ledger, Route/Agent configuration, or long-term memory.

## Start the Relay

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_PORT="8788"
node scripts/rabilink-relay-server.mjs
```

Open the management console:

```text
https://<relay-host>/manage
```

Create an account and RabiLink application there. Copy the application token to the PC's global Relay configuration or client tool. Do not use the retired `RABILINK_RELAY_TOKEN` shared-token model.

## Device enrollment and status

An AIUI installation without a token can show its full device serial number and the `/manage` address. The user enters that SN in the application card and opens a bounded claim window. AIUI polls:

```http
POST /api/rabilink/devices/token
```

The claim returns a device-scoped token only during the authorized window.

Mobile/device status can be posted to:

```http
POST /api/rabilink/mobile/device-status
```

The management/device state reports battery, charging, receipt time, and staleness. It does not store CXR authorization or expose Relay tokens.

## Remote RibiWebGUI

After signing in, open a PC by stable `rabiGuid`:

```text
https://<relay-host>/manage/<account>/<RabiGUID>/#/routes
```

The server queues WebGUI HTTP requests for that PC worker. The worker calls its local Manager, normally `http://127.0.0.1:8790`, and returns status, body, and headers. The Relay never opens an inbound connection to the user's PC.

## Same-application PC discovery and persona-sync transit

The global worker now registers `persona-sync` capability and a dedicated LAN persona-sync listener URL. That listener exposes only the manifest/file/merge data plane, so the complete Manager/WebGUI does not need to bind to the LAN. PCs using the same application token can call:

```text
GET /api/rabilink/peers?deviceId=<self>&deviceGuid=<self-guid>
```

The response contains only other workers in that application, with stable ID, GUID, online state, capabilities, and `peerUrls`. An active `/api/rabilink/events` SSE connection is direct PC-presence evidence and requires no polling to remain online. During reconnect overlap, the PC becomes offline only when its last active connection closes. A new connection, capability/LAN-address change, or final disconnect publishes `persona_sync_peer_changed` to other subscribers in the same application; it only wakes one peer/manifest catch-up query. Only legacy clients without SSE use bounded recent-request activity as a compatibility fallback. Persona synchronization first tries those LAN URLs. If direct access fails, it calls:

```text
POST /api/rabilink/persona-sync/proxy
```

The proxy accepts only a target PC, `GET/POST`, and `/api/persona-sync/manifest|files|merge` paths. Relay pushes `webgui_available` through `/api/rabilink/events`; the target PC then immediately claims `/worker/webgui-requests` and reaches its loopback Manager. It cannot proxy arbitrary local URLs and Relay does not store a master persona. See [Multi-PC persona data synchronization](persona-data-sync_en.md) for merge behavior.

Worker endpoints:

```http
GET  /worker/webgui-requests?limit=1&deviceId=<pc>&deviceGuid=<guid>
POST /worker/webgui-requests/<requestId>/response
```

Response bodies are base64-safe for HTML, JavaScript, CSS, images, and JSON. The proxy rewrites common absolute `/api`, `/manager-config`, and `/assets` paths so the remote page continues addressing the same PC. Bundled reports are served under the same authenticated PC prefix. Frontend report links must use relative `reports/...` URLs rather than root-relative `/reports/...`; Relay exposes only the build's `assets/` and `reports/` directories, not arbitrary server files.

## Direct RabiSpeech API

The speech API uses the target application's token rather than the WebGUI login cookie:

```http
GET  /api/rabilink/speech/health
GET  /api/rabilink/speech/v1/models
POST /api/rabilink/speech/v1/audio/speech
POST /api/rabilink/speech/v1/audio/transcriptions
POST /api/rabilink/speech/v1/audio-streams/rabilink/start
POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1
POST /api/rabilink/speech/v1/audio-streams/rabilink/stop
POST /api/rabilink/speech/messages  # compatibility/debug, not the Android main path
```

Prefix these paths with the Relay HTTPS origin. The application must select an online PC whose **Allow speech relay** switch is enabled. See [Call TTS and ASR remotely](user-guide/speech-api_en.md) for copyable calls, acceptance, and error recovery. The machine-readable contract is available at `/api/rabilink/speech/openapi.json`.

## Publish Relay and verify documentation parity

The HTML, JavaScript, and `reports/` below `/manage/<account>/<RabiGUID>/` come from the **Relay server's own** `ribiwebgui/dist`, not from the selected PC's local WebGUI. Updating only RabiPC does not update the public guide. Uploading only the frontend does not add a new static-resource prefix to an old Relay script.

Maintainers should build and run the read-only check first:

```powershell
npm run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  skills\audit-rabiroute-public-docs\scripts\Test-RabiLinkDocumentationRuntime.ps1
```

The check reads the server address, public host, and SSH key path from the ignored `data/rabilink-relay/config.json`. It does not print those values, upload files, overwrite state, or restart a process. Interpret the result as follows:

- `LocalReady=true`: the local Relay, WebGUI, report, bilingual guide, and OpenAPI are ready;
- `DeploymentNeeded=true`: the public server still has an older script or guide and needs a release;
- `ReadyToDeploy=true`: public health, supervisors, processes, and local artifacts satisfy the release preconditions.

Only after explicit release authorization, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts\deploy-rabilink-relay-windows.ps1
```

The deployer first copies the remote scripts, Caddy configuration, and complete WebGUI to `C:\opt\rabilink-relay\backups\code-<timestamp>`. It preserves account, application, token-hash, and queue state under `data/`, then updates files, recreates the scheduled tasks, and checks health. Run the read-only check again; expect `DeploymentNeeded=false`, `RemoteReportsRoute=true`, and `RemoteSpeechGuide=true`.

The selected PC's Manager, worker, and local speech process belong to a separate runtime package. See [Windows desktop launch and packaging](windows-launcher-and-packaging_en.md). Do not combine Relay publishing and RabiPC installation into one non-recoverable copy.

## AIUI input and downlink

### Synchronous compatibility request

```http
POST /rokid/rabilink
```

This compatibility path may wait for a worker result up to `RABILINK_RELAY_REPLY_TIMEOUT_MS`. It is not the preferred connected-conversation state machine.

### Record-first input

```http
POST /rokid/rabilink/input
```

Final ASR text becomes an observation. The PC worker writes it to the unified ledger and completes the input without waiting for Codex. Review happens later.

### Event-driven global downlink

```http
GET /api/rabilink/events?deviceId=<stable-device-id>&deviceKind=glasses&after=<cursor>
Accept: text/event-stream
```

Android, PC workers, and other SSE-capable clients may connect with an empty cursor. On `ready` or `outbox_available`, read one immediate delta:

```http
GET /api/rabilink/devices/messages?deviceId=<stable-device-id>&deviceKind=glasses&after=<cursor>&waitMs=0&stream=1
```

Rokid AIUI QuickJS has no SSE, WebSocket, or chunk callback. The production AIUI page therefore uses `GET /rokid/rabilink/messages?stream=1&waitMs=25000`. Relay registers one internal `outbox_available` waiter and immediately rechecks the cursor; it returns only when an event arrives or the deadline expires, without scanning the business queue. Hiding the page or leaving conversation mode stops continuation.

Persist `nextCursor` verbatim as an opaque value and reuse it only for reconnect recovery and idempotency; never parse or construct it. The cursor carries a shared Relay generation that survives normal restarts and is shared by processes using the same data directory. After a runtime-state rollback or invalid cursor, the response sets `cursorReset=true` with `cursorResetReason` and replays messages that are still retained. Clients must deduplicate by stable `deliveryId` (falling back to message ID only when absent) before saving the replacement cursor. This prevents an old client cursor from remaining permanently ahead of a restored Relay state. Neither transport requires a `taskId`, so proactive messages created before the glasses page opens are delivered normally. Broadcast and kind-only messages use the configured Outbox TTL. A message with explicit `targetDeviceIds` is retained beyond that TTL until every explicit target returns `delivered`.

PC-side producers publish through RabiRoute when possible:

```http
POST /api/agent/replies
```

with `targetType=rabilink`, an appropriate route, and `proactive=true` for task-free messages. After route policy passes, RabiRoute publishes to:

```http
POST /worker/messages
```

Use a stable `deliveryId` for retry idempotency.

## Generic portable-device API

```http
POST /api/rabilink/devices/input
GET  /api/rabilink/devices/messages?deviceId=<id>&deviceKind=<kind>&after=<cursor>&stream=1
POST /api/rabilink/devices/message-receipts
POST /api/rabilink/devices/logs
POST /api/rabilink/devices/media?fileName=<safe-name>
GET  /api/rabilink/devices/media/<media-id>?fileName=<safe-name>
```

Generic clients must identify their device ID or kind. The glasses compatibility stream implicitly selects `deviceKind=glasses`. The management console can filter device logs by account/application, device, source, severity, session, time range, and query text.

Receipt requests carry `messageId` or stable `deliveryId`, the reporting device identity, and `state=delivered|played|playback_failed`. `delivered` means received/presented and is never equivalent to `played`; only the actual output device may produce `played` after its own completion event. Relay idempotently persists first-success timestamps per device in `runtime-state.json` and emits `outbox_receipt`. It never infers playback from PCM writes, estimated duration, or channel connectivity.

Media upload uses a raw image/video/audio request body and returns attachment metadata. Publish that metadata in an observation only after upload succeeds. The PC worker accepts only the controlled media path and downloads it with the same application token into private Route data before ledger append. The default object limit is 64 MiB (`RABILINK_RELAY_DEVICE_MEDIA_MAX_BYTES`) and temporary objects expire after seven days (`RABILINK_RELAY_DEVICE_MEDIA_TTL_MS`). Relay cleans once at startup and calculates the earliest remaining expiry; later uploads rearm one cleanup deadline only when they expire sooner, with no fixed directory scan. This is serialized file-message transfer, not live video or resumable upload.

## Legacy task API

The following endpoints remain for older Rizon/plugin compatibility and diagnostics:

```http
POST /rokid/rabilink/tasks
GET  /rokid/rabilink/tasks/<taskId>
GET  /rokid/rabilink/tasks/<taskId>/messages?after=<cursor>
POST /worker/tasks/<taskId>/result
POST /worker/tasks/<taskId>/messages
POST /worker/tasks/<taskId>/finish
```

New AIUI connected conversation should not model each observation as a request that waits for one final answer.

## PC worker

Claim inputs with:

```http
GET /worker/tasks?limit=1&deviceId=<pc-device-id>
```

The PC first subscribes to `/api/rabilink/events` with its stable device ID/GUID and capabilities. `task_available`, `webgui_available`, and `speech_available` each trigger one immediate queue drain with `waitMs=0`; `persona_sync_peer_changed` triggers one persona peer/manifest reconciliation. A legacy nonzero `waitMs` blocks on the same internal event and performs one recovery claim after subscription; it does not restore queue scanning.

For `rabilink.observation`, the worker writes the role ledger, then calls the finish endpoint to confirm local persistence. It does not directly call Codex inside the claim request. Older non-record-only tasks still use the compatibility forwarding path.

Local/LAN debugging can POST directly to the configured local `/rabilink` gateway endpoint, but the production public path uses Relay and the global PC worker.

## Important environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RABILINK_RELAY_APP_TOKEN` | empty | PC worker application token; Relay server itself does not read it |
| `RABILINK_RELAY_PORT` / `PORT` | `8788` | Listen port |
| `RABILINK_RELAY_HOST` / `HOST` | `0.0.0.0` | Listen address |
| `RABILINK_RELAY_REPLY_TIMEOUT_MS` | `60000` | Compatibility synchronous reply wait |
| `RABILINK_RELAY_MESSAGE_WAIT_MS` | `60000` | Single-task debugging compatibility; the persistent product path does not depend on task queries |
| `RABILINK_RELAY_OUTBOX_WAIT_MS` | `60000` | Event-backed request deadline for clients without SSE; SSE clients use `waitMs=0` |
| `RABILINK_RELAY_OUTBOX_TTL_MS` | `172800000` | Retention for broadcasts, kind-only targets, and messages whose explicit targets all returned `delivered`; pending explicit targets do not expire by this TTL |
| `RABILINK_RELAY_WORKER_TASK_WAIT_MS` | `60000` | Legacy worker event-wait deadline and recent-activity fallback; an active SSE connection directly owns online presence |
| `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS` | `30000` | Remote WebGUI response wait |
| `RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES` | `10485760` | Remote WebGUI request-body limit |
| `RABILINK_RELAY_TASK_TTL_MS` | `600000` | Legacy task retention |
| `RABILINK_RELAY_LEASE_MS` | `180000` | Worker lease |
| `RABILINK_RELAY_DATA_DIR` | `data/rabilink-relay` | Runtime state, logs, accounts, and applications |

`RABILINK_RELAY_TOKEN` is retired. Do not use it for the server or worker.

The Relay stores shared task/outbox state, stable `deliveryId` values, and per-device receipts in `<dataDir>/runtime-state.json`, allowing multiple Relay processes or reverse-proxy distribution without losing task completion or downlink visibility. `<dataDir>/outbox-cursor-state.json` stores only a random shared generation and the issued-sequence high-water mark so a rollback of `runtime-state.json` can be detected; it contains no message body, token, or device profile. TTL cleanup applies only to broadcasts, kind-only targets, or old messages whose explicit targets all returned `delivered`. Both files are runtime data and must not be committed.

## Unified PC ledger concurrency

Manager and gateway processes may both append to the same role ledger. Cross-process writes, deduplication, rotation, and index replacement are serialized with a lock in the data directory. Stale locks are recovered after a bounded age. Do not manually remove a lock that is actively being written.

## OpenAPI and Rizon

OpenAPI documents are available under `/rokid/rabilink/openapi*.json`. Validate them with:

```powershell
npm run relay:rabilink:openapi:check
```

Use the normal, manual-auth, or agent-token variant according to Rizon's authentication support. Never publish a real application token inside a reusable OpenAPI/plugin artifact.

## Verification

Local and public checks include:

```powershell
npm run relay:rabilink:test:shared-state
npm run relay:rabilink:test:public
npm run active-intelligence:e2e
npm run config-rollback:e2e
```

For a custom public host:

```powershell
npm run relay:rabilink:test:public:custom -- `
  -BaseUrl https://rabi.example.com `
  -ExpectedOpenApiServerUrl https://rabi.example.com `
  -SkipQueueSmoke
```

Public acceptance must prove account/application isolation, record-first input, task-free proactive downlink, cursor recovery, idempotent retry, multi-process shared state, remote WebGUI routing to the selected PC, device-log isolation, and rollback after configuration tests.

## Security boundary

- Use per-account/per-application tokens and device enrollment; no shared public token.
- Keep tokens out of query strings where header/body alternatives exist, logs, screenshots, examples, and Git.
- Do not expose the local Manager directly to the Internet.
- Enforce body limits, wait limits, leases, TTLs, and target-device filtering.
- Treat the Relay as transport/mailbox infrastructure, not as an Agent or role-context owner.
