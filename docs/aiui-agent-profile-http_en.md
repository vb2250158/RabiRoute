# AIUI device Agent profile HTTP (experimental)

English | [简体中文](aiui-agent-profile-http.md)

An explicitly registered RabiPC owns device profiles. Relay stores authentication and immutable connection assignments. The new contract uses public Manager APIs; old Relay profile, knowledge-grant and profile-editor endpoints are retired. All clients must update. Old business data is not automatically imported.

## Identity and ownership

The phone entry is All-day recording → Devices → Glasses → Glasses settings → Current persona. Binding adopts that persona's identity, instructions, Skills and chat history; Rokid still configures the model. Unbound Agents can call public APIs. Binding does not restrict API access, workspaces or other personas. With remoteAgent enabled, an authenticated Agent can call every public API on the target PC; future public APIs use the same generic transport.

Device enrollment must explicitly provide `connectionTargetDeviceId`, the immutable profile owner for that binding. Selecting a persona on PC B keeps configuration on owner PC A; tools and history default to persona source B. Other PCs in the same application may be selected explicitly. Data ownership identifies where state is stored and does not grant or restrict caller permissions.

Relay `GET /api/rabilink/devices/connections` returns connection metadata without persona or Skill data. Application settings use an explicitly registered immutable owner, established through `PATCH /api/rabilink/mobile/connection` with `{connectionOwnerDeviceId}`. No owner is inferred from the default message target. Changing the default target or resetting the same binding's credential cannot change its fixed assignment.

A PC persists confirmed connection assignments for offline LAN use. Unknown devices require initial discovery; owner conflicts fail closed. Changing application connection scope isolates state and cached assignments.

Verified local tunnels or Relay workers establish identity. Manager trusts injected device identity only on a genuine loopback hop with its current `x-rabilink-tunnel-local` generation and managed transport. Bodies and caller-supplied headers cannot assert identity. Application credentials may manage a specified device's configuration but cannot impersonate a glasses application receipt; acknowledgements require the originating binding.

## Executable contracts and discovery

One definition set installs HTTP routes and discovery entries for six operations: `manager.rabilink.agent-devices.list`, `manager.rabilink.agent-devices.profile.read`, `manager.rabilink.agent-devices.profile.save`, `manager.rabilink.agent-devices.profile.receipt.record`, `manager.rabilink.agent-devices.profile.operation.read`, and `manager.rabilink.persona-template.read`. The template endpoint no longer depends on another route's prefix declaration.

Request and response DTOs share `PROFILE_SCHEMAS` from `packages/rabilink-agent-contract/profile.mjs`. The native validator retains UTF-16 limits, unique IDs, total Skill content, revision and idempotency rules. Admission captures the original connection and PC owner before body decoding; device assignment is checked again after persona reads, and the original context is revalidated before writes and disclosure. Missing connection business context returns `503 PROFILE_CONTEXT_UNAVAILABLE`; it is not a second feature grant. Forged sources and revoked connections remain rejected.

Saving configuration and acknowledging device application are separate facts. Management connections cannot sign a device's application acknowledgement. If a save happened before a later acknowledgement failure, the response includes `uncertain=true`. Inspect `/profile/operations/{key}` using the original `deviceId` and body `idempotencyKey` before retrying. Missing receipts return HTTP 200 with `receipt:null`, which does not prove a request never executed. These operations do not start an Agent, send a prompt, download models or execute MCP tools.

## Public PC APIs

| Method and path | Result |
| --- | --- |
| `GET /api/rabilink/agent-devices` | Saved profiles within the application connection scope |
| `GET /api/rabilink/agent-devices/{deviceId}/profile` | `{code:0,data:{profile,applied,savedRevision}}` |
| `PUT` on the same path | Save `{expectedRevision,idempotencyKey,profile}` |
| `GET /api/rabilink/agent-devices/{deviceId}/profile/operations/{key}` | `{code:0,data:{receipt}}`, the original receipt |
| `POST /api/rabilink/agent-devices/self/profile/receipt` | Originating device confirms `{idempotencyKey,appliedRevision,status,errorCode?}` |
| `POST /api/rabilink/persona-template` | `{roleId,skillIds}`, a template from the requested PC |

Android uses the generic encrypted Manager Tunnel in LAN → P2P → Relay order. An AIUI host limited to `wx.request` uses the buffered HTTP Relay fallback at `/api/rabilink/device/api`; this fallback does not claim LAN/P2P support. The caller freezes `targetDeviceId`; Relay never interprets `personaRef` or `profileRevision` to route requests. See the [generic API transport](../apps/rabilink-aiui/docs/generic-api-transport_en.md) and [Relay contract](rabilink-relay-server_en.md).

Profile fields are `{revision,id,name,systemPrompt,skills,mcp,personaRef?}`. `personaRef` is null or `{roleId,sourceDeviceId}`; saving checks that the persona exists on the actual source PC. Skills use `{id,title,content,enabled}` and MCP references use `{id,label,enabled}`. Tokens, URLs and executable commands are rejected. References are not grants, and saving them is not proof of connectivity or execution.

The single limits authority is `packages/rabilink-agent-contract/profile.mjs`: IDs and names 128 characters; system instructions 8000; up to 16 Skills, 8000 content characters per Skill and 24000 total; up to 16 MCP references. Template reads accept raw Manager JSON envelopes or callbacks unwrapped once and verify the source application generation before and after reads.

## Writes and receipts

Revisions increase from 1; initial `expectedRevision` is 0. CAS conflicts return 412, different intent under the same key returns 409, and identical intent returns its original receipt. Each device retains at most 128 operation receipts; capacity fails closed without evicting keys. Preserve both generic request `operationId` and profile `idempotencyKey`; never change keys to replay an uncertain write.

Read back the original receipt and resource after an uncertain outcome. `receipt:null` is not proof of failure. Original receipts remain queryable after a newer revision replaces current state. Application receipt status is `applied` or `failed`, with a restricted errorCode required for failure; unknown revisions and regressions are rejected. Saved configuration, device application, Skill/tool execution and hardware wake are separate evidence.

The PC owns scoped configuration and receipts. Asynchronous source reads are followed by scope and identity checks before writing. Atomic storage uses same-directory temporary files, fsync, snapshots and complete readback; failures restore snapshots. This is a write recovery mechanism, not a long-term backup. Multi-process shared-file writes and cross-platform power-loss transactions are not claimed.

## Damaged profile isolation

Profiles are isolated by device. Lists return healthy devices and identify unreadable devices in `coverage.invalidDeviceIds`; requests for those devices' profiles or operation receipts return `503 PROFILE_RECORD_INVALID`. Other devices remain readable and writable, including original receipt lookup. Saving updates only the target device and preserves every other raw record, including damaged records, without replacing them with empty defaults or deleting them.

If the whole file or connection-scope structure is damaged and device ownership cannot be established, operations on that storage scope are rejected. The restriction does not extend to independent modules.

## Validation status

Isolated tests start real Relay and PC owners using temporary accounts, credentials and files. They cover generic HTTP, fixed targets, management saves, device receipts, impersonation rejection, CAS, original receipt queries, restart recovery and retired endpoints. Public deployment, physical wake, simultaneous ASR/TTS and steering, Rokid login and unpublished-version upload require separate acceptance. Fixtures cannot establish those results. See the [acceptance checklist](aiui-agent-acceptance_en.md).
