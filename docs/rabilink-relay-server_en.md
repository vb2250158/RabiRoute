# RabiLink public Relay

English | [简体中文](rabilink-relay-server.md)

Relay owns connection, authentication and generic forwarding. RabiPC owns personas, Skills, chat history, device status, ASR settings and message processing. With remoteAgent enabled, an authenticated Agent can call every public API on the target PC. Future public APIs need no Relay update, and persona or workspace binding does not narrow the API surface.

This is experimental. Local fixtures, builds, installed runtime, public deployment and hardware acceptance are separate evidence. See the [AIUI acceptance checklist](aiui-agent-acceptance_en.md).

## Architecture and transport selection

Android and PC use the generic encrypted Peer Tunnel in LAN → P2P → Relay order to reach the same target. Relay provides same-application discovery, connection signaling and forwarding; PC services own endpoints and state. Persona source, device profile owner and default message target may differ. Callers freeze the target for each operation.

An AIUI host limited to `wx.request` uses the existing buffered HTTP Relay fallback. Its capability is HTTP Relay, not verified AIUI LAN/P2P. Both transports reach the same public Manager APIs.

Relay stores accounts, credentials, connection assignments, same-application directories, opaque request/response queues, leases, cursors, blobs and operation status. Server diagnostics remain supported. Persona templates, business authorization, history assembly, ASR priorities, health interpretation and record-first decisions belong to PCs or clients. Relay neither rewrites opaque business bodies nor dispatches them through per-API business allowlists.

The generic HTTP connection identity includes its original `authenticatedAt` timestamp. The original queue item and identical operation retries retain it; late arrival or another claim cannot extend connection authority. The PC verifies it through an internal MAC. Short leases for a phone to connect under a separate glasses identity belong to the PC; see [Device connection grants](device-peer-connection_en.md). Relay adds neither a business API dispatch table nor a public-key grant registry.

## Start and enroll

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_PORT = "8788"
node scripts/rabilink-relay-server.mjs
```

Read `/health`, then register an account and create an application at HTTPS `/manage`. Copy the PC enrollment prompt from the console; a private Agent on the target PC uses a short-lived single-use code to configure its connection. See [PC enrollment](rabilink-pc-pairing_en.md). Keep credentials out of public logs, examples and screenshots.

Each PC needs an independent deviceId and GUID. Disabling its server connection stops transport without deleting credentials or routes. Bounded `rabi-pc-version-<version>` advertisements provide display metadata, not integrity proof or permissions. Public API access follows the actual target PC's remoteAgent and connection-authentication contracts.

Windows deployment uses `scripts/deploy-rabilink-relay-windows.ps1`. `scripts/rabilink-relay-runtime-files.json` is the single Relay runtime manifest, covering static dependencies and the actual HTTP-served pairing script, without PC business modules. Preserve complete private snapshots before deployment; check runtime version, `/health`, connection directories and original queue IDs afterward. Discover the deployed data path rather than assuming an example directory.

Deployment defaults to RuntimeOnly. PrepareOnly builds a local ZIP without contacting the server. Full Caddy/WebGUI updates require explicit `-RuntimeOnly:$false`. After stopping Relay, deployment snapshots code, ws dependencies, the original scheduled task and complete data using the prior/current manifests and fixed retirement list, verifying SHA-256 per file. Runtime copying excludes data/logs. It does not import old business state or infer connection owners. A backup failure resumes the original task without replacing code.

The bundle includes `rollback-rabilink-relay.ps1 -Root <service-directory> -BackupRoot <that backups/code-... snapshot>`. It verifies snapshot hashes before restoring original code and scheduled tasks and removing files introduced by that deployment. Live data created after deployment is preserved. Private data snapshots support separate investigation and explicitly authorized data recovery, never automatic code rollback. Recheck local/public `/health`, original account/task IDs and connection directories afterward.

## Connection metadata

| Endpoint | Purpose |
| --- | --- |
| `GET /api/rabilink/mobile/state` | Connection directory, targets and service advertisements; no battery, persona or ASR priority |
| `PATCH /api/rabilink/mobile/target` | `{targetDeviceId}`, default message destination |
| `PATCH /api/rabilink/mobile/connection` | `{connectionOwnerDeviceId}`, first explicit immutable application settings owner |
| `GET /api/rabilink/devices/connections` | Immutable device assignments with application connectionOwnerDeviceId and device connectionTargetDeviceId |
| `POST /api/rabilink/devices/token` | Independent device credential; new bindings require explicit connectionTargetDeviceId |
| `GET /api/rabilink/peers` | Same-application connection and capability discovery |

The application owner must be a same-application PC advertising Manager service. Changing the default destination does not change this fixed owner. Resetting the same device binding's credential preserves its owner; a different owner requires a new binding. Missing explicit assignments fail closed instead of guessing from an old tasks-only destination. Assignments describe connection and data ownership, never persona-derived public API permissions.

## Generic HTTP

`POST /api/rabilink/device/api` accepts authenticated application or device credentials:

```json
{
  "targetDeviceId": "pc-example",
  "request": {
    "method": "PATCH",
    "path": "/api/example/future-capability",
    "headers": {"if-match": "\"revision-example\""},
    "operationId": "operation-example",
    "body": {"value": "example"}
  }
}
```

Paths must be safe relative public paths. Query parameters and generic contract headers are preserved; external URLs, path escapes, credentials and forged transport identity are rejected. targetDeviceId selects a same-application target and remains fixed through readback. Relay does not accept profileRevision routing or interpret persona references.

When `targetDeviceId` is omitted, only the device's registered `connectionTargetDeviceId` or the application's explicitly registered `connectionOwnerDeviceId` is used. A missing connection target returns `API_CONNECTION_TARGET_REQUIRED`. The old message or task `targetDeviceId` is not an API-routing default; original task target data remains preserved.

Results are wrapped in `{code:0,data:{structuredContent:{ok,statusCode,headers,data}}}`. Preserve the PC result's meaning; Relay HTTP 200 is not business success. See the [generic API contract](../apps/rabilink-aiui/docs/generic-api-transport_en.md) for exact fields. PC workers establish identity only from server-generated connection metadata, never model-supplied IDs.

Requests and responses preserve new business headers such as `x-token-count` and `x-secret-version`; sensitive substrings in a name do not deny it. Only explicit authentication, source identity and framing headers, plus the internal `x-rabilink-*` and `x-forwarded-*` namespaces, are denied. The transport generates local credentials and signatures, which callers cannot override.

Writes durably record operationId before dispatch through the existing WebGUI HTTP queue. `GET /api/rabilink/device/api/operations/{operationId}` returns transport state. Different intent under the same key is rejected. Uncertain writes are never automatically replayed; read the original PC resource or business receipt. Transport state is not a business receipt. The current 2048-write ledger fails closed at capacity without evicting keys. No second per-business Relay dispatch exists.

## Tasks, output and service forwarding

Actual Rokid/Lingzhu wire entries remain as transport codecs. `/rokid/rabilink/input` and `/api/rabilink/devices/input` preserve raw bodies and task IDs, leases, destinations and verified identities. Workers must declare taskFormat=opaque-v1; old decoder requests receive 426. PCs interpret text aliases, health metrics, processingPolicy, routeProfileId and record-first before using existing message and health owners. Relay does not invent those fields.

`/worker/messages`, device messages/cursors/receipts and blobs provide generic output transport. Device received/played/failed states are delivery evidence, not proof of correct Agent processing. PCs choose content, delivery channels and recipients. See [AIUI documentation](../apps/rabilink-aiui/README_en.md) for the complete Agent, Rokid model, TTS/ASR and steering behavior.

`/api/rabilink/speech/{path}` forwards safe relative public speech paths with generic HTTP methods, without per-API allowlists. Target selection, size limits, timeouts and fencing belong to transport. ASR/VAD, voiceprints, model configuration, speech storage and message processing belong to the target RabiSpeech/Manager. See [RabiSpeech](rabispeech-plugin_en.md). `/api/rabilink/video/offer` forwards connection exchange only.

## New PC APIs and retired entries

Profiles and templates use the [public profile API](aiui-agent-profile-http_en.md). PC settings use `/api/rabilink/mobile/asr-settings`, device-status, proof and proofs. Health capabilities use PC `/api/rabilink/devices/health-capabilities`. All use generic Manager transport; Relay has no business state copy.

Old `/manage/.../agent-profile`, `/api/rabilink/device/agent-profile*`, device/knowledge, mobile/aiui, mobile/webgui, mobile/routes, mobile/asr-settings, mobile/device-status and proof business entries are retired with 404 or 410. The old profile editor and knowledge-grant switch are removed. Update all clients, explicitly enroll assignments and configure through the new contract. There are no old-client proxies or old-business imports. Preserve original accounts, task IDs, unknown extensions and complete private raw snapshots.

## Limits and diagnostics

The default data directory is data/rabilink-relay; RABILINK_RELAY_DATA_DIR overrides it, and RABILINK_RELAY_APP_STORE_FILE selects the application file. Transport options include RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS, RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES, RABILINK_RELAY_SPEECH_REQUEST_WAIT_MS, RABILINK_RELAY_SPEECH_BODY_MAX_BYTES, RABILINK_RELAY_TASK_TTL_MS, RABILINK_RELAY_OUTBOX_TTL_MS and RABILINK_RELAY_LEASE_MS. Exact bounds are defined by source clamps. Old server battery-expiry and ASR business environment variables no longer apply.

Check `/health` and the same-application directory, then actual PC capabilities/version, Manager generation and original request IDs, operation IDs and receipts. Diagnostics exclude credentials. Restore snapshots on storage replacement failure; corrupt stores fail closed. Never replay an uncertain mutation by changing destination, key or persona.

Isolated tests cover staged Relay startup, application isolation, future API forwarding, frozen destinations, original headers/receipts, opaque bodies, PC owner restart and retired entries. Public deployment, account login, hardware wake, simultaneous voice input/output and platform upload require separate verification.
