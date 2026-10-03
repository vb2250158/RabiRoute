# Device knowledge write-operation receipts

English | [简体中文](rabilink-knowledge-operation-receipts.md)

In 0.3.22, real device credentials authenticate knowledge requests within one RabiLink application. Devices can use all knowledge tools actually provided by the target PC, including mutations. Manager remains the sole owner of knowledge business logic and durable data; Relay stores only bounded transport receipts returned by the PC. No additional role, tool or write grant is configured. See the [knowledge runtime contract](rabilink-knowledge-runtime_en.md). Source and test evidence does not establish installed-version or physical-device acceptance.

## Write intent and result

Before dispatch, Relay persists the stable operation key and body hash, with internal owner, target PC, role, tool and opaque device-credential fingerprint scope. Role and tool identify the business intent, rather than an additional permission allowlist. Tools accept only personas actually owned by Manager's global `rolesRoot`; a same-name persona in a custom Route directory cannot stand in for that knowledge-storage owner. Manager validation, strong ETags, idempotency keys and business boundaries remain effective. Each device retains at most 128 entries without evicting old keys or deleting history to regain write capacity. Results are atomically persisted before responding.

Confirmation requires outer and structured 2xx status, no `isError`, `ok=true`, `uncertain=false`, `committed`, a matching key, a strong ETag and a nonempty resource ID. Only known receipt fields and business `data` are retained. Responses above 32 KiB, forged success and 5xx cannot confirm a write. Persistence failure returns `503 uncertain`. The `knowledge_receipt_persistence_failed` log contains only the server-generated requestId, stage (validate/read/normalize/lookup/write), and an allowlisted error code (EACCES/EPERM/ENOENT/EIO/ENOSPC, otherwise UNKNOWN). Keys, bodies, credentials and scope are excluded. Diagnostic failure cannot replace the uncertain outcome or trigger replay.

## Query the original key

`GET /api/rabilink/device/knowledge/operations/:key` requires the actual device credential and returns `{code:0,data:{idempotencyKey,state,receipt?}}`. State is `confirmed`, `failed` or `unknown`; `failed` requires authoritative `not_started`. Each read checks the current application, device credential and membership, owner and selected target PC. Retired role, tool and write grants are no longer checked. Queries need no online PC, do not call Manager and never touch recent-memory detail.

Internal scope and credential fingerprints are never returned, and responses disable caching. Disabling a device or application, changing credentials, owner or target PC denies access to old content. A second device cannot read a receipt by reusing its key. Paths are decoded once; queries retain compatibility with historical 256-character keys, while new mutations must meet the current stable-key contract.

Legacy key/hash-only entries and absent keys return `unknown`, not a claim that execution never started. Restarting before a receipt arrives or worker completion after a wait expires may leave `unknown`; late-result harvesting is not implemented. Clients must not repeat POST or change keys to query outcomes, nor treat matching titles as proof of the original operation. Corrupted stored receipts fail validation instead of silently deleting history.

## Evidence boundaries

Automated checks use temporary data and simulated business logic to cover original-key GET recovery, confirmed and unknown states across restart, credential/owner/target changes, second-device isolation, forged receipts and actual atomic-write failure. The current PC path calls Manager directly; historical Relay/PC/MCP tests do not establish deployment of this new path.

A historical receipt-recovery run encountered a five-second persistence timeout. Standalone and later fixed-source passes do not establish that its root cause was eliminated. Completion checks subsequently moved to client GET queries with the original key, retaining bounded deadlines and reads without POST replay. This improves recovery acceptance without erasing the failure. Old packages, counts and device-capability evidence remain in the [historical AIUI acceptance record](aiui-agent-acceptance_en.md) and cannot establish 0.3.22 connection or knowledge-path acceptance.
