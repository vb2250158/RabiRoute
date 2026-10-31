<!-- docs-language-switch -->
<div align="center">English | <a href="./xiaomi-home-api-contract.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Executable Xiaomi Home API contracts

> Status: source migration and isolated HTTP/native-service tests. Full builds, installed applications, physical devices and cross-machine acceptance are confirmed separately.

`io.rabiroute.manager.xiaomi-home` registers 53 exact endpoints through `createXiaomiHomeManagerOperations()`: 48 JSON operations, one HTML operation, one SSE operation and three native byte proxies. The same definitions execute requests and populate the active catalog. Original `home:METHOD:path` discovery IDs are derived as aliases, without adding routes. The old boolean HTTP handler, manual exact/prefix lists and dedicated HTTP tracker are removed.

## Endpoints and owners

Every path below starts with `/api/agent/xiaomi-home`. Counts are method/path pairs. There is no wildcard prefix dispatcher or new WebSocket endpoint.

| Native feature | Methods and paths | Count |
| --- | --- | --- |
| Health and settings | GET `/health`; GET/PUT `/settings` | 3 |
| HA deployment | GET/PUT `/deployment`; POST `/deployment/start`, `/deployment/install`; GET `/deployment/events` (SSE) | 5 |
| HA credentials | GET/POST/DELETE `/auth`; POST `/auth/refresh` | 4 |
| Resources and devices | GET `/resources`, `/resources/:resourceId`, `/devices`, `/devices/:deviceId`, `/entity-actions`, `/capabilities` | 6 |
| Actions and events | GET/POST `/action-requests`; POST `/events` | 3 |
| Recorded files | GET/POST `/artifacts`; GET `/artifacts/lifecycle`, `/artifacts/:artifactId`, `/artifacts/:artifactId/content` (bytes) | 5 |
| Remote driving | GET `/vacuum-remote/capabilities`, `/vacuum-remote/status`; POST `/vacuum-remote/start`, `/pulse`, `/stop`, `/exit` (the last three share the same prefix) | 6 |
| Cloud account and devices | GET `/vacuum-cloud/status`, `/vacuum-cloud/devices`; POST `/vacuum-cloud/login`, `/vacuum-cloud/login/poll` | 4 |
| Cloud files and maps | GET `/vacuum-cloud/plugin-package`, `/plugin-information`, `/map`, `/path`, `/trajectory`, `/feedback`, `/position`, `/telemetry` (all under `/vacuum-cloud`) | 8 |
| Cloud video | GET `/vacuum-cloud/video/network`, `/status`, `/password`, `/stream` (bytes), `/frame` (bytes); POST `/vacuum-cloud/video/start`, `/stop`, `/password/forget` (all under `/vacuum-cloud/video`) | 8 |
| Cloud map page | GET `/vacuum-cloud/connect` (HTML) | 1 |

`createXiaomiHomeOperationsOwner()` calls the original `XiaomiHomeRuntimeController`, HA deployment, device client, action receipts, protected credentials, artifacts, cloud sessions, remote driving and video services directly. The API layer creates no duplicate business store or account/device state. Native services validate JSON DTOs, revisions, resources and idempotent intent. Catalog schemas explicitly describe the native validation boundary; open schemas do not claim to enumerate every business field.

Authenticated enabled remote connections can use every public endpoint, including deployment operations. Actual installation and startup still occur on the Manager computer and retain native administrator interaction and installation ownership checks. Personas, plans, skills and device discovery add no feature grant. Original HA address policy, account ownership, resource roots, state versions, lifecycle fences and stable keys remain in force.

## Identity, writes and recovery

Before reading a body, the API captures the original ingress identity and checks the native lifecycle fence and any original required key. It checks the original identity again before disclosing asynchronous results. Disabling and re-enabling a Node does not revive an old request. Native services accepting authority continue checking it at external dispatch and local commit boundaries. Original cloud/session services without that parameter gain no new per-stage cancellation guarantee.

Settings and deployment retain native revisions. Credential changes retain authorization revisions, joint candidate-address/token verification, protected storage and durable authentication mutation receipts. Logs, responses and discovery never include plaintext credentials. Device actions retain state versions and original receipts. After uncertainty, inspect the original key/session/action instead of creating another key or automatically replaying device or installation work. Registration adds no universal idempotency guarantee where the native owner has none.

Reads declare ignored bodies. JSON operations retain empty-body `{}`, arbitrary Content-Type and no newly added application body cap. Malformed JSON now receives the common parser's 400 response; business fields remain native validations. Unsupported methods on registered paths receive 405 and `Allow`.

## HTML, SSE and native bytes

The map HTML retains a random nonce per request, native CSP, same-origin connections, no caching and no referrer leakage. Deployment SSE subscribes to native `HomeAssistantDeployment.subscribe()` snapshots. A bounded queue prevents unbounded slow-consumer growth. Client closure or plugin retirement unsubscribes and joins pending native inspection instead of introducing HTTP polling.

Artifact content retains the native descriptor, filesystem boundary, access audit and single HTTP Range, including 200/206/416, Content-Range, Content-Length and native MIME. Video stream/frame still read MP4 from the sidecar owned by the native supervisor. They are not MJPEG and add no camera startup channel. All three byte proxies call extracted native `open()` / `openStream()` methods directly, without invoking the retired HTTP dispatcher.

Client disconnect or retirement cancels and joins the native file or upstream reader. Video opening receives the same cancellation signal while waiting for response headers. Closing a viewer closes that reader, without stopping the camera session. Plugin disposal concurrently stops admission, retires both registrations and stops the native runtime, then waits for completion.

## Evidence scope

Focused tests use the real contract registry, temporary persistent files, an enrolled empty Node, controlled HA HTTP and an owned MP4 sidecar. They cover native credential connection, device/resource queries, dry-run actions and original-key receipt readback, Range bytes/headers, HTML nonce, SSE retirement, pending-read revocation, upstream cancellation before/after headers and native subscription joins. No real HA service, cloud account, device, installation process or Agent message is used.

These tests do not establish physical camera availability, real-time map positions, executed device actions or an updated installed application. See the [plugin guide](../plugins/builtin/io.rabiroute.manager.xiaomi-home/1.0.0/README_en.md) for maturity and usage, and the [target architecture](api-contract-discovery-target-architecture_en.md) for the overall migration.
