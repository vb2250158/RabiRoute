<!-- docs-language-switch -->
<div align="center">English | <a href="./api-error-recovery.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Finding valid parameters after an API error

Preserve the HTTP status, `errorCode`, `field`, `repair`, original request and receipt. Use the indicated read-only discovery operation before deciding what to do with the original request. Failed discovery does not establish absence; 401/403 is an access failure. Errors do not expose credentials, full prompts or the remote session's actual directory.

This is a source candidate. Build, isolated acceptance and installation are separate evidence. Help comes from the currently registered operation contracts. Passthrough routes, unknown JSON extensions and permissive schemas retain their original owners; structural coverage does not prove every business parameter is covered.

## Session workspace mismatch

`AGENT_WORKSPACE_MISMATCH` means the frozen execution `cwd` differs from the target session's registered workspace. The session may still exist and be readable. Discover it through the original authenticated connection:

```http
GET /api/lan-agent/instances
GET /api/agent/help?operationId=manager.agent.threads.action
POST /api/agent/threads
Content-Type: application/json

{"action":"read","agentAdapter":"codex","threadId":"complete-session-id","instanceBinding":{"instanceId":"target-instance","agentId":"target-agent"}}
```

The instance list exposes `instances[].instanceId` and `agents[].agentId/provider/workspace/sessionId/managedSessionIds` as supported by its current contract and target. Omit `cwd` from this read. The generic thread response returns top-level `thread.cwd`, without modifying the frozen request.

List sessions on the same target:

```json
{"action":"list","agentAdapter":"codex","query":"","limit":20,"offset":0,"instanceBinding":{"instanceId":"target-instance","agentId":"target-agent"}}
```

Follow top-level `nextOffset`. Alternatively use `POST /api/lan-agent/instances/:instanceId/agents/:agentId/threads`, with explicit `agentAdapter` and `action:read` plus `threadId`, or `action:list` plus query fields. This direct instance route wraps the native result in `result.data`; the workspace is `result.data.thread.cwd`. Its operation ID is `manager.lan-agent.agents.threads`.

When the original target uses a Peer Manager, preserve its original `instanceBinding.ownerDeviceId`. Generic thread discovery follows that same peer rather than selecting a local instance.

Example original response, with IDs and full discovery instructions omitted:

```json
{"code":-1,"status":"delivery_unconfirmed","errorCode":"AGENT_WORKSPACE_MISMATCH","field":"cwd","delivery":{"status":"unconfirmed","retryable":false},"error":{"stage":"target_delivery","code":"AGENT_WORKSPACE_MISMATCH","field":"cwd","retryable":false},"repair":"Read the same complete session using POST /api/agent/threads, omitting cwd; inspect GET /api/lan-agent/instances. Preserve the original request, deliveryId, receipt and frozen cwd."}
```

HTTP 202 and the original `dispatching` state remain. A parameter diagnosis alone does not prove an attempt never executed. Discovery does not authorize changing frozen cwd, creating another session or resending the prompt. Read `GET /api/agent/deliveries/:deliveryId` for the original state and `errorCode/field/repair`. `GET /api/agent/deliveries/caller/:callerDeliveryId` retains the original source query parameters and returns `data.detailPath`. Do not resubmit unknown prompt content just to obtain diagnostics.

## Structural parameter errors

Shared validation returns `API_REQUEST_SCHEMA_INVALID`. `field` identifies a schema-owned field such as `body.agentAdapter`; `repair` identifies the violated rule and `GET /api/agent/help?operationId=<URL-encoded-original-operationId>`. Read legal types, enums, required fields and constraints from `data.operations[].contract.request`. Submitted values, unknown property names, authentication headers and prompts are not echoed. Nested or composite schema errors stay at a safely declared parent when a deeper field cannot be identified safely.

```json
{"code":-1,"errorCode":"API_REQUEST_SCHEMA_INVALID","field":"body.agentAdapter","operationId":"manager.lan-agent.agents.threads","retryable":false,"repair":"Parameter violates schema rule required. Read GET /api/agent/help?operationId=manager.lan-agent.agents.threads; use data.operations[].contract.request ..."}
```

`LAN_AGENT_MANAGEMENT_NOT_SENT` and `LAN_AGENT_MANAGEMENT_TIMEOUT` describe remote transport failures and return 503; reads include `reason=remote_query_failed`. They do not prove invalid parameters or a missing file/session. Write timeouts retain `uncertain=true`; inspect the original receipt. Existing 401/403 authorization guards run first.

## Coverage and remaining batches

### An unopened terminal output stream

`GET /api/lan-agent/instances/:instanceId/terminals/:terminalId?after=0&waitMs=0` retains HTTP 400 when this Manager connection has no output stream. It adds `errorCode=TERMINAL_STREAM_NOT_FOUND`, `field=path.terminalId` and `reason=terminal_stream_not_open`. This does not prove malformed parameters or an absent remote process.

`help` identifies `GET /api/lan-agent/instances/:instanceId/terminals`, returning `data.shells` and `data.sessions`. `repair` gives a same-ID `POST` open example: `{"action":"open","terminalId":"<original-terminalId>","shell":"<choose from data.shells>"}`. Read its current contract using `GET /api/agent/help?operationId=manager.lan-agent.terminals.execute`. Discovery does not open a terminal or replay input. Use the example only when opening is authorized by the original task. Handle lookup and access failures separately.

Structural coverage applies only to schemas declared through the shared operation validator. Owner semantics are listed separately. Raw proxies, undeclared fields and passthrough responses keep their existing behavior. This work adds no blanket fallback, default disablement, allowlist, retry loop or execution state.

| API family | Covered | Remaining owner semantics and actual entry points |
| --- | --- | --- |
| Management / operation directory | Declared path/query/header/JSON fields, schema reasons and current help URL; existing JSON/media/size codes point to the real contract | Raw HTTP proxy, passthrough and permissive schemas remain owner-defined; `managerPluginRouteRegistry.ts` / `apiOperationContract.ts` |
| Agent / remote SDK | Frozen Codex cwd mismatch through native owner, connector, Manager and original response; read-only receipts retain help; SDK retains the HTTP body | Other adapters' ambiguous names, unsupported actions and creation conflicts need individual discovery guidance; `agentThreads.ts` / `instanceThreadRouting.ts` |
| Instance / Agent management | Required `agentAdapter`, binding discovery and known transport failures separated from parameter/access failures | Provider semantic errors may still contain only message; `lanAgentManagementContract.ts` / core `lanAgentRoutes.ts` |
| Files / terminals | Shared structural validation and actual help; precise unopened-stream reason with same-instance list/open guidance; known lookup/transport errors separated while retaining input sequence, file/upload IDs and unknown outcomes | Shell/path/offset/version semantic errors need individual fields and read-only discovery; core `lanAgentInteractiveContract.ts`, connector `terminal-service.mjs` / `computer-service.mjs` |
| Binary upload | Existing errorCode/help/repair plus precise fields for UUID path, single-valued headers, idempotency key, media type, encoding, SHA256 and filename; original quota/integrity/ID/receipt behavior retained | Store-originated length/integrity fields need refinement; `agentUploadRoutes.ts` / `agentUploadContract.ts` |
| Plans / memory / attachments | Declared structure and existing ETag/CAS/missing-plan discovery | Individual planId/status/binding/attachment errors; `GET /api/roles/:roleId/plans`, `GET /api/roles/:roleId/plan-statuses`; persona `personaStorageOperations.ts` / `personaPlanOperations.ts` |
| Role / global configuration | Declared structure, existing access and lifecycle validation | RoleId/revision/config enums need guidance from actual read contracts; `roleConfigurationOperations.ts` / `gatewayControlOperations.ts` |
| Plugins / plugin configuration | Declared schemas and CAS | Missing instance/revision/catalog errors; `GET /api/plugins/instances`, `pluginManagementOperations.ts` / `pluginCatalogOwner.ts` |
| Messaging / history / resources | Declared structure and existing send capabilities/history repair/resource listing | Platform fields remain tied to their capability contracts; `agentSendOperations.ts`, `personaHistoryOperations.ts`, `lanAgentReadOperations.ts` |
| Speech / video / home devices and extensions | Declared operation structure; original idempotency and authority retained | Service/model/device values, quotas and semantic failures need individual guidance. Discover current plugin operations; a document does not prove a plugin is active |

This batch validates isolated binary-upload HTTP, remote management/file HTTP and SDK, actual Codex plugin bundling, connector/Registry error messages and read-only receipts. It does not constitute installed-version acceptance, real-node QA or a real business send.
