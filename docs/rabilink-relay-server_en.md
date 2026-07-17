<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-relay-server.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink Public Relay

> Maturity: experimental. Relay, PC worker, remote WebGUI, input/downlink mailboxes, device logs, and the unified ledger have implementations. Real public-network, account-isolation, device, and recovery acceptance is still required.

The Relay is a built-in system transport owned by Manager, not a message adapter. It connects Rokid/AIUI clients, portable devices, ordinary API clients, and the PC RabiRoute worker. Glasses and phones are endpoints using the transport; the Route-facing glasses entry keeps the legacy internal key `rabilink`. Input and output are independent persistent flows.

The same Relay also exposes a separate synchronous RabiSpeech API. It authenticates an application token, selects an online PC with speech enabled, and waits while Manager forwards the byte-preserving request to the loopback service. This path does not enter an Agent, persona, message Route, or conversation ledger. See [RabiSpeech local TTS / ASR service](rabispeech-plugin_en.md).

```text
Uplink
  AIUI/device -> Relay input mailbox -> PC worker
  -> unified conversation ledger -> input completed
  -> later idle/periodic/touchpad review

Downlink
  Codex/scheduler/planner -> RabiRoute Outbox policy
  -> Relay persistent messages -> device cursor consumption
  -> native TTS or device UI
```

AIUI may use the phone-provided network path underneath, but the phone does not own the Agent, ledger, or configuration.

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

Worker endpoints:

```http
GET  /worker/webgui-requests?limit=1&deviceId=<pc>&deviceGuid=<guid>
POST /worker/webgui-requests/<requestId>/response
```

Response bodies are base64-safe for HTML, JavaScript, CSS, images, and JSON. The proxy rewrites common absolute `/api`, `/manager-config`, and `/assets` paths so the remote page continues addressing the same PC.

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

### Continuous global downlink

```http
GET /rokid/rabilink/messages?stream=1&after=<cursor>&waitMs=25000
```

The first request may use an empty cursor to recover retained backlog. Persist `nextCursor` and reuse it. The stream does not require a `taskId`, so proactive messages created before the glasses page opens are delivered normally.

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
POST /api/rabilink/devices/logs
```

Generic clients must identify their device ID or kind. The glasses compatibility stream implicitly selects `deviceKind=glasses`. The management console can filter device logs by account/application, device, source, severity, session, time range, and query text.

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

For `rabilink.observation`, the worker writes the role ledger, then calls the finish endpoint to confirm local persistence. It does not directly call Codex inside the claim request. Older non-record-only tasks still use the compatibility forwarding path.

Local/LAN debugging can POST directly to the configured local `/rabilink` gateway endpoint, but the production public path uses Relay and the global PC worker.

## Important environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RABILINK_RELAY_APP_TOKEN` | empty | PC worker application token; Relay server itself does not read it |
| `RABILINK_RELAY_PORT` / `PORT` | `8788` | Listen port |
| `RABILINK_RELAY_HOST` / `HOST` | `0.0.0.0` | Listen address |
| `RABILINK_RELAY_REPLY_TIMEOUT_MS` | `60000` | Compatibility synchronous reply wait |
| `RABILINK_RELAY_MESSAGE_WAIT_MS` | `60000` | Task-message long poll |
| `RABILINK_RELAY_OUTBOX_WAIT_MS` | `60000` | Global downlink long poll |
| `RABILINK_RELAY_OUTBOX_TTL_MS` | `172800000` | Global downlink retention; default 48 hours |
| `RABILINK_RELAY_WORKER_TASK_WAIT_MS` | `60000` | PC worker input long poll |
| `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS` | `30000` | Remote WebGUI response wait |
| `RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES` | `10485760` | Remote WebGUI request-body limit |
| `RABILINK_RELAY_TASK_TTL_MS` | `600000` | Legacy task retention |
| `RABILINK_RELAY_LEASE_MS` | `180000` | Worker lease |
| `RABILINK_RELAY_DATA_DIR` | `data/rabilink-relay` | Runtime state, logs, accounts, and applications |

`RABILINK_RELAY_TOKEN` is retired. Do not use it for the server or worker.

The Relay stores shared task/outbox state in `<dataDir>/runtime-state.json`, allowing multiple Relay processes or reverse-proxy distribution without losing task completion or downlink visibility. This is runtime data and must not be committed.

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
