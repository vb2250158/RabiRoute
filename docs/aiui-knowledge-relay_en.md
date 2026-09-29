# AIUI knowledge HTTP Relay (experimental)

English | [简体中文](aiui-knowledge-relay.md)

Profile MCP references do not grant authority. The owner manages `{allowedRoles,allowedTools,allowWrites}` separately through `GET/PUT /manage/api/apps/:appId/devices/:bindingId/knowledge-grant`. Defaults are empty lists and writes disabled. PUT takes `{expectedRevision,idempotencyKey,grant}` and uses the profile management JSON/custom-header/same-origin checks. Initial revision is 0; stale revisions return 412, conflicting keys 409. The grant receipt ledger is capped at 128 entries and fails closed when full.

An independent device credential calls `POST /api/rabilink/device/knowledge` with only `{operation:'list'}` or `{operation:'call',name,args}`. App tokens are rejected. The target PC must be explicitly selected and belong to the same application. Client target, URL, token and identity overrides are rejected. Without the PC's `knowledgeBridge` capability, Relay returns 503 `KNOWLEDGE_BRIDGE_NOT_READY` without queueing. Existing capability normalization lowercases advertisements.

Relay constructs trusted queue `knowledge:{appId,deviceBindingId,ownerAccountId,targetDeviceId,grant}` and `nonReplayable`; the fixed path is `/__rabilink/knowledge` and the body contains only the tool request. Generic WebGUI creation rejects the reserved path. PC must dispatch before Manager proxying, validate the permission intersection and use the official SDK against local MCP HTTP, never forward this path to Manager.

Writes and recent-detail reads that touch state require write permission and the original business idempotency key. Before dispatch, Relay persists the key and intent digest. Repeated keys never create a new queue item, including after restart. Same-key/same-intent returns an uncertain outcome requiring authoritative reconciliation, not fabricated success; conflicting intent returns conflict. The intent ledger is also capped at 128 without automatic eviction. Write leases do not requeue after expiration. Timeouts explicitly report uncertainty. Never automatically retry with a new key.

Before each claim or re-claim, Relay revalidates current device credentials, owner, target and grants. Revoked reads cannot reuse stale grants. Credential digests stay inside the Relay queue, never in PC responses. Revocation cannot roll back a request already claimed and executing.

Isolated tests cover real Relay → PC Runtime → official MCP HTTP → synthetic business results, uncertain writes, repeated keys and replay protection after Relay restart. Lease tests execute the production claim function with an injected clock, proving writes are not re-claimed and reads are rejected after role revocation, target changes or credential rebinding. Cross-network access, real Manager write reconciliation and device acceptance remain pending. No public deployment or real knowledge operation was performed.
