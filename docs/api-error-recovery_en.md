<!-- docs-language-switch -->
<div align="center">English | <a href="./api-error-recovery.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Finding valid parameters after an API error

Preserve the HTTP status, `errorCode`, `field`, `repair`, original request and receipt. Use the indicated read-only discovery operation before deciding what to do with the original request. Failed discovery does not establish absence; 401/403 is an access failure. Errors do not expose credentials, full prompts or the remote session's actual directory.

This page describes the guidance provided by source version 0.10.2. Check the deployed version with GET /meta. Help comes from currently registered operation contracts; build, isolated acceptance and installation remain distinct evidence. Passthrough routes, unknown JSON extensions and permissive schemas retain their original owners; structural coverage does not prove every business error is covered.

## Operation-by-operation follow-up

### Upload field guidance

Version 0.10.2 refines upload error field guidance. Only explicit local-store input checks attach fields: filename maps to `headers.x-rabiroute-file-name`, declared-length format to `headers.content-length`, digest format to `headers.x-rabiroute-content-sha256`, and non-byte content to `body`. Use encodeURIComponent of the original basename, retaining native255-byte, Windows name/character and whitespace rules. Count original uncompressed bytes and compute the digest from those same bytes. Read the current contract with `GET /api/agent/help?operationId=agent.upload.write`.

Received bytes inconsistent with declared length or digest retain422/integrity and identify `body`; replay bytes exceeding an existing receipt retain409/conflict. This proves a mismatch, without deciding whether content, length or SHA should change. First GET `/api/agent/uploads/<originalUploadId>` and check original fileName/size/sha256/expiresAt. Preserve the ID, request and frozen content without automatic retransmission, a new ID or digest changes. A404 receipt does not authorize retransmission or prove other operations never occurred. Capacity, revocation, unknown outcomes and existing receipt semantics remain.

Internal disk, record/reservation/lease and read-time integrity failures retain native code/status without guessed parameter fields. Arbitrary remote/plain Error field, message or repair values do not enter this guidance: only the original local error class and fixed code/field pairs are used. No new error registry, source gate or rejection rule is added. Other interfaces and ordinary internal/I-O classification remain in the original pending matrix.

### Knowledge search parameters and index availability

Version 0.10.1 adds knowledge search guidance and index updates through their existing owners. Explicit search parameter failures use KNOWLEDGE_PARAMETER_INVALID and query.query/mode/kind/limit. Malformed cursors use KNOWLEDGE_CURSOR_INVALID/400; expired index versions use KNOWLEDGE_CURSOR_EXPIRED/409. Errors name the same role's GET knowledge/cache/status, summary search and current operation help. For 409, keep original role/query/mode/kind/archived/limit, omit only the old cursor for the first page and then copy nextCursor unchanged. Do not change conditions or automatically POST reload.

Reload requires kind/id together; all, when provided, must be boolean and all=true cannot be combined with a point target. Omitting kind/id keeps ordinary refresh, not a forced full rebuild. Existing Number(limit) followed by integer 1..100 validation, default 10 only when missing, first duplicate value, ignored empty cursor, permissive JSON and unknown fields remain. Unknown point IDs retain native refresh behavior without a new 404 or existence gate. Reload is a real derived refresh, not read-only parameter discovery.

GET search/status do not modify business plans or memories, but existing ensure may cold-create a derived index, register a watcher or queue refresh; they are not zero-I/O operations. Summary discovery does not invoke a memory-detail endpoint that may touch viewedAt. Index/published-catalog warming stays 503, distinct from 400. Ordinary transport, service-closed and internal errors are not assigned parameter codes by this change.

The same owner also fixes an existing local-data availability gap: fulfilled worker batches publish healthy changes despite a bad JSON row. Original raw bytes remain; last usable summaries/inventory are retained for failed rows. Both ordinary and full partial refresh preserve the intent for one clean membership prune, but explicit full invalidates successful fingerprints only once after joining the original flight. Existing rescheduling uses the advanced inventory and rereads only failed/changed rows. A clean completion prunes stale identities (including same-file A-to-B changes) against inventory plus same-flight committed refs, retaining cached text/terms/summaries and advancing the version to expire old cursors; retries do not reparse the healthy full set. Whole-read rejection retains cold warming or old hot data, with original budgets/scheduling. Search data.coverage states scope=indexed-inventory, state=partial and errors. Total describes searchable summaries, not complete role data or proof of object absence. Duplicate plan identities count as local errors per conflicting identity: none of the two or more files supplies a new summary for that identity, while healthy neighbors remain available. A cold index chooses none; a hot index keeps the last unambiguous summary. Original files and successful fingerprints remain unchanged, so unchanged retries do not reparse them. When the conflict clears, the sole survivor is reread; when all copies disappear, native clean reconciliation removes the identity. This applies only to the derived search index, without changing formal plan identities, point-read/write validation or raw files, or filtering confirmed committed changes. Local errors do not imply complete data.

Three pages of `GET /api/agent/help?limit=200`, under one Manager identity and catalogDigest, returned 563 active operations. All 563 are mapped to their owner, input contract and primary semantic-error boundary, with no duplicate or unmapped IDs. `coverage.complete=true` covers only `registered-routes`; `globalCoverage=not-proven` remains. This does not prove every deep failure branch is fixed or dynamically tested. The original task retains the catalog, per-operation review and owner gaps as evidence, not another runtime registry.

The 0.9.1 follow-up captured 567 operations under its new identity/catalog snapshot: none removed, four additions below. The existing instances.update contract now saves settings and reconciles asynchronously; saved state and actual lifecycle completion remain separate. The 0.10.0 guidance preserves that asynchronous behavior, installation/storage semantics and point-read performance. The old 563-operation evidence still belongs to its 0.8.2 input.

| Added operation in 0.9.1 | Current inputs and actual read-only discovery | Remaining semantics |
| --- | --- | --- |
| `manager.plugins.packages.list`, `GET /api/plugins/packages` | No business query parameters; data.packages[] contains pluginId/version/manifest/source/instanceIds | Distinguish catalog-read failures from parameter errors; no package execution |
| `manager.plugins.packages.import`, `POST /api/plugins/packages` | body.sourceDirectory is a local package directory on the Manager host; read this operation's help for shape, and GET packages for existing versions | No API can invent a not-yet-imported source directory. Do not fabricate paths or add an absolute-path restriction. Explicit immutable-version and identity conflicts have codes/fields; I/O and unclassified validation remain pending |
| `manager.plugins.instances.install`, `POST /api/plugins/instances` | expectedRevision/pluginId/version required, instanceId optional. GET packages supplies versions; GET instances supplies data.revision | Package import can precede settings CAS; a stale revision does not prove no effects. Preserve unknown; install now has explicit settings/identity conflict guidance; package-missing/internal failures remain distinct |
| `manager.plugins.instances.remove`, `DELETE /api/plugins/instances/:id` | path.id is the original instance; body.expectedRevision comes from GET instances | Preserve identity/data and observe asynchronous stop separately. Fully retired instances may be absent from the list; do not recreate or replay from an empty result |

These additions were reviewed through contracts/source and isolated fixtures, with no production import/install/remove. GET packages does not return the settings CAS revision; instanceIds is not a complete directory of uninstalled history. The original owner's identity-restoration behavior when instanceId is omitted remains.

Package management adds fixed diagnostics to existing explicit-status failures: PLUGIN_PACKAGE_VERSION_CONFLICT, PLUGIN_PACKAGE_IDENTITY_CHANGED, and install/remove settings-revision, missing-instance, saved-settings and instance-identity conflicts. Fields identify the original sourceDirectory/version, expectedRevision, instance ID or saved settings; help names the current operation. Original400/404/409 and unknown outcomes remain. Stale CAS does not establish that import never happened, and no version/directory/instance substitution is automatic. Generic missing-package, manifest/tree/syntax and I/O failures remain individually pending rather than being relabelled wholesale as parameter errors.

### Guidance added in 0.10.0

| Trigger | Fields and discovery | Preserved behavior |
| --- | --- | --- |
| Ambiguous Agent session name | `AGENT_SESSION_NAME_AMBIGUOUS`, field `title`; use `POST /api/agent/threads` with list/read and the original adapter/binding, follow nextOffset and compare complete IDs | Original 409/candidates or send failure; discovery does not select, create or deliver |
| Unsupported adapter/action | `AGENT_THREAD_ADAPTER_UNSUPPORTED` / `AGENT_THREAD_ACTION_UNSUPPORTED`; read managedTasks capabilities from `GET /api/agent-adapters/catalog` and current thread-action help | An unavailable/unpublished provider is distinct from unsupported; no alternate Runtime |
| Frozen creation intent conflict | `AGENT_CREATION_INTENT_CONFLICT`, field `deliveryId`; read existing `GET /api/agent/deliveries/caller/:callerDeliveryId` under the original source | Top-level creation and prompt-delivery data are separate evidence; no new key/cwd/target/session |
| Invalid terminal after/waitMs | `TERMINAL_OUTPUT_CURSOR_INVALID` / `TERMINAL_WAIT_INVALID`, query.after/query.waitMs; read the same terminal with `?after=0&waitMs=0` for data.nextOutputSequence; bounds come from error/current contract | Original 400 and truncated/gap behavior; no open or input replay |
| Missing plugin instance, stale revision or corrupt saved settings | `PLUGIN_INSTANCE_NOT_FOUND` / `PLUGIN_SETTINGS_REVISION_CONFLICT` / `PLUGIN_INSTANCE_SETTINGS_INVALID`; `GET /api/plugins/instances` returns revision, instanceId and instance errors | 404/409 remain distinct; a corrupt setting does not invalidate all instances or the caller's parameters |
| Plugin host/module revision/file mismatch | `PLUGIN_CATALOG_HOST_INVALID` / `PLUGIN_WEB_MODULE_NOT_FOUND`; `GET /api/plugins/modules` supplies matching id/rev/entryPath for encoded `GET /api/plugins/modules/:id/:rev/:relativePath` | Host error400, original module404; no guessed file or deletion |
| Role ID/title/revision/confirmation errors | Original ROLE_* codes plus field/repair; GET /api/roles lists active roles and ?scope=archived lists archived roles, each paginated by nextCursor; GET configuration returns revision/roleId | Original 400/404/412/409, operation key, configuration and lifecycle remain |
| Plan/memory enum, native validation or revision failures | Original invalid_request/revision_conflict plus field/current help; plan lists/status catalog/original plan or consolidation run supply values and ETag | Activation statuses differ from dynamic marker keys; immutable-key errors identify body.key, not a substituted path identity |
| Workflow not ready | `PLAN_WORKFLOW_NOT_READY`, 503; read the same role's plan-statuses endpoint | Service availability is not a parameter400; no replacement workflow |
| Explicit local speech parameter errors | `SPEECH_PARAMETER_INVALID` and actual field; read the model/persona/speaker/session/device catalogs indicated by the error | Only confirmed local validators add guidance; upstream503, access and cancellation remain |
| Missing registration requirementId/unsupported action | `MESSAGE_PROCESSING_PARAMETER_INVALID`, body.requirementId/action; GET message-processing board and original requirement | Original source/requirement/dispatch retained; no automatic resend |
| Video model download network/upstream size or SHA failure | `VIDEO_MODEL_DOWNLOAD_FAILED` / `VIDEO_MODEL_DOWNLOAD_INTEGRITY_FAILED`, internal upstream status502; GET /api/video/models reads original download-job status | Distinct from caller upload-digest errors; accepted async HTTP and job.failed semantics remain, status GET is not changed to502, and downloads are not retried automatically |

Creation lookup uses the original authenticated source scope. `creation.available=true,state=absent` only means no creation metadata for that source; available=false means unreadable or unsupported evidence. The projection contains state, intentHash and an existing threadId, never prompt/title/cwd/credentials. Existing DELIVERY_NOT_RESERVED/canSubmitSameIntent still describe prompt delivery only, and cannot establish absence of a frozen create intent. Failed lookup, 401/403, corrupt evidence and unknown outcomes remain distinct.

Recent-memory detail `GET .../memory/recent/:memoryId` updates viewedAt in normal mode. Use lists for side-effect-free discovery. Obtain its ETag through the existing detail contract only when needed for the original edit, with that touch behavior made explicit. Consolidation results use the ETag from `GET .../memory/consolidation-runs/:runId`.

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
| Agent / remote SDK | Existing cwd guidance plus this candidate's ambiguous-name/unsupported action-adapter hints and separate source-scoped creation lookup; existing SDK HTTP body retained | Remote executor codes may still be lost on the wire; adapter-specific parameters and service-vs-object failures remain; `agentThreads.ts` / `instanceThreadRouting.ts` |
| Instance / Agent management | Required `agentAdapter`, binding discovery and known transport failures separated from parameter/access failures | Provider semantic errors may still contain only message; `lanAgentManagementContract.ts` / core `lanAgentRoutes.ts` |
| Files / terminals | Shared structure, unopened-stream and output cursor/waitMs guidance; known transport failures separated, preserving sequence/IDs/gap/unknown | Remote shell/input sequence/file offset-version/upload integrity still need typed propagation and recovery. These are distinct from the completed output-cursor case; original core/connector owners retain them |
| Binary upload | Existing errorCode/help/repair plus precise fields for UUID path, single-valued headers, idempotency key, media type, encoding, SHA256 and filename; original quota/integrity/ID/receipt behavior retained | Store-originated length/integrity fields need refinement; `agentUploadRoutes.ts` / `agentUploadContract.ts` |
| Plans / memory / attachments | Native invalid_request/412, page enums, exact run ETag, immutable body.key and genuine workflow-not-ready503; original ETag/CAS/receipts retained | History navigation/bindings, attachments, companion, identity/knowledge/recording retain deeper message-only/classification gaps; all 170 persona operations are not claimed fixed |
| Role / global configuration | Known ROLE_* fields, separate active/archived discovery and configuration revision/confirmation | Global Route catalog/lifecycle headers and configuration path/enums remain owner gaps; no sensitive configuration read was used as a probe |
| Plugins / plugin configuration | Missing instance, revision conflict, corrupt saved settings, host and module-path recovery | Initialization/retirement/resource errors remain distinct from configuration errors; no capability/default-enablement restrictions |
| Messaging / history / resources | Declared structure and existing send capabilities/history repair/resource listing | Platform fields remain tied to their capability contracts; `agentSendOperations.ts`, `personaHistoryOperations.ts`, `lanAgentReadOperations.ts` |
| Speech / video / home devices and extensions | Local speech validators, video upstream network/integrity and two message-processing registration parameters clarified; existing typed codes/status/outcomes retained | QQ is audit-only under this task's boundary; Xiaomi/pet/Bili/performance/other model-service values remain owner gaps. Not every400 is a parameter error or every503 a missing value |

This batch validates isolated binary-upload HTTP, remote management/file HTTP and SDK, actual Codex plugin bundling, connector/Registry error messages and read-only receipts. It does not constitute installed-version acceptance, real-node QA or a real business send.
