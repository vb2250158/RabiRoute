# Device knowledge requests and application authentication

English | [简体中文](aiui-knowledge-relay.md)

Devices call `POST /api/rabilink/device/knowledge` using independent RabiLink device credentials, with only `{operation:'list'}` or `{operation:'call',name,args}`. After authentication, ownership validation and selection of a PC in the same application, all knowledge tools and writes provided by that PC are allowed by default. Separate knowledge grants are no longer stored or intersected.

App tokens cannot impersonate device credentials. Clients cannot override target, URL, token, owner or membership. Without the PC's `knowledgebridge` advertisement, Relay returns 503 `KNOWLEDGE_BRIDGE_NOT_READY` without queueing. Relay constructs four-field device metadata and nonReplayable, fixes the path to `/__rabilink/knowledge`, and rejects this reserved path in generic WebGUI queues.

Enqueue, claim and re-claim revalidate current credentials, owner, application and selected target. Revocation or target rebinding prevents re-claim under stale scope. Credential digests stay internal to Relay. Revocation cannot undo execution that already began. PC reads/writes actual personas through existing Manager APIs without separate MCP configuration.

Writes and recent-detail touch retain stable business idempotency keys. Intent digests are persisted before dispatch; the same key cannot create a second queue, and different intent conflicts. Each device ledger is capped at 128 entries, fails closed when full and does not auto-evict. Expired write leases are not replayed. Timeouts are uncertain; never retry with a new key. See [knowledge receipts](rabilink-knowledge-operation-receipts_en.md).

Owned legacy knowledge-grant GET/PUT/operations endpoints return 410 `KNOWLEDGE_GRANTS_RETIRED`; cross-account access remains 404. The management editor is removed. Historical grants remain unchanged as old data and never authorize requests. Public Relay behavior changes only after the updated Relay source is deployed.
