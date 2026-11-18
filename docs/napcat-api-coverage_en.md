# NapCat API coverage and invocation

[简体中文](napcat-api-coverage.md)

## Version and coverage

The baseline is the NapCat 4.18.4 release, SHA-256 `66dfaa1b9e7530d493089c70d24810f4e23c31d129e1662949558ce30ce52a92`. Recheck the release artifact when the upstream version changes.

The [native contract matrix](../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json) lists 167 base actions, 501 names including aliases, 112 WebUI method/path pairs, 25 instantiated events and six event base classes. The [Rabi coverage matrix](../src/plugins/io.rabiroute.endpoint.napcat/contracts/rabi-coverage-4.18.4.json) records each execution contract, parameters, response scope and remaining reason.

| Area | Invocation and boundary |
| --- | --- |
| OneBot | Fixed reads, writes through the original ledger, existing-owner compatibility references and source-bound resources. The matrix records each status. |
| Outgoing messages | Twelve native send variants, plain-text group forwards and source-message quick replies use the unified `agent.send` policies, Outbox and receipts. |
| Files and streams | Managed attachments, original-message files and selected-native file references retain their respective source owners. Download frames become SSE with incremental digests and backpressure. |
| WebUI | 104 fixed invocation shapes and eight host-boundary mappings, covering configuration, authentication, files, Reactive lifecycle and maintenance. Each contract states its execution conditions. |
| Events | The original WebSocket ingress emits typed metadata. A local protector seals original request flags, and callers use opaque references. |

Arbitrary `send_packet` forwarding and actions explicitly marked test-only upstream retain precise unavailable reasons. Restricted views, including Ark getters, expose their declared projection. Full native shapes require separate acceptance. The upstream `send_group_ark_share` and `send_ark_share` handlers obtain cards, and their contracts retain that behavior.

## Discovery and calls

Find an operation with `GET /api/search`, then read its help contract. Fixed native actions use `POST /api/agent/qq/onebot/<action>`. A read example follows.

```json
{"routeId":"example-route","instanceId":"example-napcat","params":{"group_id":"100000001"}}
```

Side effects require a stable `deliveryId`. Identical IDs and parameters read the original durable record, while conflicts return 409. Keep 202 results uncertain and query `GET /api/agent/qq/onebot-receipts/<deliveryId>?routeId=example-route&instanceId=example-napcat`. `_async` and `_rate_limited` are discovery aliases for the same synchronous Rabi contract. Read the actual contract because compatibility parameters can differ from raw upstream JSON.

Each call binds an enabled Route, an explicit instance and the configured QQ account, with native identity verification. Existing connection authority, cancellation, deadlines and read quotas apply. Outgoing calls provide the real Agent identity for unified language, length, media and receipt handling. Native acknowledgement-only operations return `acknowledged`; platform visibility is verified separately.

Managed files use original upload or plan-attachment references. Message media uses the exact conversation, message ID and attachment index. Native files and directories use opaque references issued by their original owner. Caller paths, URLs, base64 or fabricated resource manifests cannot replace source evidence. Public resources contain reviewed content. A local protector seals internal paths, request flags and sensitive provenance manifests.

Quick operations use an exact original message or captured request-event reference. Replies enter `agent.send`; delete, kick, ban and request handling use their existing native owners. Child effects retain stable IDs and original receipts. Partial or uncertain execution is never automatically repeated. Ban duration is supplied explicitly.

## WebUI and lifecycle

Fixed reads use `POST /api/agent/qq/webui/<id>`, and management uses `POST /api/agent/qq/webui-management/<id>`. Both carry `routeId`, `instanceId` and contract parameters. Writes also require a stable `deliveryId`. Query the original management receipt at `GET /api/agent/qq/webui-management-receipts/<deliveryId>`.

The original WebUI session owner handles authentication and verifies the selected account. Sensitive values enter their specific native configuration or authentication owner, and responses follow the public projection. File operations bind the selected native source. Reactive open, close and retirement remain owned by the same plugin version and await cleanup. Token rotation uses the original persisted Route CAS and its original-operation recovery contract.

The `mirror-custom.set` preference accepts a full HTTP/S prefix or an empty value to clear it. Request memory and the native configuration owner retain the original value, while public receipts contain digests. The preference affects native process memory. Persistence and subsequent choices by other callers are verified separately.

## Joining groups and acceptance

The 4.18.4 registry has no action to apply proactively to join a specified group. `set_group_add_request` handles an existing application or invitation using its original ingress flag. `set_group_add_option` changes an existing group's admission settings.

Implementation checks use private ports, test configuration and mocks. Matrix coverage, builds, isolated runtime, installed adoption and real platform operations have separate evidence. Real QQ accounts, player groups and active NapCat services are excluded from action tests. Installed verification checks the Manager and the same Gateway PID, generation, plugin hash and activation ID. Real messaging, media and management changes require their specific authorized acceptance.
