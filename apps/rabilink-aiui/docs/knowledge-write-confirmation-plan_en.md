# Glasses knowledge-write confirmation plan

English | [简体中文](knowledge-write-confirmation-plan.md)

**Status: pure confirmation policy implemented; page, host adapters and write-tool wiring remain unimplemented.** This is neither a claim that glasses writes are available nor a device acceptance report. PC knowledge MCP already exposes controlled write tools. The glasses single-step layer advertises read tools only; explicit confirmation and uncertain-outcome recovery must be added before enabling writes.

## Sources and scope

- [Current tool schema](../../../packages/rabi-knowledge-contract/schema.mjs): `recent_memory_create` accepts `{roleId,idempotencyKey,body}`. The body requires `title`, `focus`, `keywords`, and `content`, with optional `source`. The server additionally checks that focus is a single line.
- [Single-step contract](knowledge-single-step_en.md): present results separately, without invented model continuation.
- [Model contract review](agent-tool-contract_en.md): an official tool-result continuation API remains unverified.
- [Device profile lifecycle](agent-profile-runtime_en.md) and [device HTTP contract](../../../docs/aiui-agent-profile-http_en.md): saved configuration, model application, and tool authorization are distinct states.
- [PC knowledge bridge](../../../docs/rabilink-knowledge-bridge_en.md) and [MCP guide](../../rabi-mcp/README_en.md): Manager retains ownership of business data and receipts.

The first version considers only `recent_memory_create`. Plan creation/updates, memory updates, archival, and deletion remain excluded. This design does not authorize general Manager interface changes or a second memory datastore.

## Draft and confirmation

The model invokes a local draft capability, such as `prepare_recent_memory`, rather than a write tool. It cannot supply operation keys, target PCs, role authorization, or credentials. The user explicitly selects the role. Product limits may be narrower than server limits, for example 80 title characters, 120 focus characters, 1000 content characters, and 1–8 keywords. These are proposed limits, not current server limits.

Show the complete bounded draft, target PC, and role. **The first version requires explicit confirmation through a physical control or phone UI; a spoken code is not a sufficiently proven sole confirmation mechanism.** Voice may supplement it: display, but do not speak, the challenge; accept only exact confirmation from a fresh final ASR segment after TTS ends. Exclude old segments, model text, and tool output. Existing echo suppression does not establish that false confirmations are impossible; device testing remains necessary.

A 60-second draft confirmation window is proposed. Editing requires new confirmation. Backgrounding or changes to credential scope, role, PC, or profile revision invalidate unsent drafts. The catalog currently does not guarantee an authorization revision, so do not claim a grant revision fence. Recheck catalog and authorization before dispatch; PC execution must still perform authoritative authorization.

## Frozen intent and one dispatch

Proposed states: `draft` → `awaiting-confirmation` → `dispatching` → `confirmed` / `uncertain`, with `expired` / `cancelled` for unsent drafts.

Before sending, atomically persist the client operation record: device scope, profile revision, PC, role, frozen body, fingerprint, stable idempotency key, and `dispatching` state. Do not store tokens or duplicate saved memories. Storage failure prevents dispatch. Verify host secure randomness; if a suitable operation key cannot be generated, disable writes rather than treating timestamps as strong randomness.

Consume confirmation once. After restart, a `dispatching` record becomes pending investigation, not an automatic resend. Draft expiry must not delete sent unresolved records. Cancellation before dispatch can stop the action; cancellation afterwards only suppresses presentation and must not claim the PC write was reversed.

Authorization requires the intersection of device grants, PC policy, the MCP write switch, and actual advertised availability. An enabled profile MCP reference is not write authorization, and a challenge code grants no extra permissions.

## Success and uncertainty

Report success only when the MCP result has no `isError` and its `structuredContent` satisfies all of:

- `ok === true`, `uncertain !== true`;
- `commitState === 'committed'`;
- matching frozen `idempotencyKey`;
- valid strong ETag and nonempty `data.id`.

Timeout, network loss, 5xx, identity changes, or incomplete receipts require preserving the body and key. Never resend automatically or create again with another key. Model text is not execution evidence.

In old frozen `e6e3709e82f8`, Relay write intents retain only key/body hashes; reuse returns `409 uncertain`. Candidate `0.3.15-397c589c9e64` includes the [read-only operation receipt query](../../../docs/rabilink-knowledge-operation-receipts_en.md) implementation, but is not deployed. The historical persist timeout cause remains undetermined; do not assume an existing installation supports recovery. **If the query is unavailable or still returns unknown, retain `uncertain`, preserve the original key/body, do not resend automatically, and require manual PC investigation.** Matching titles or contents can assist investigation but cannot prove that the original operation key committed.

The smallest recovery extension is for Relay to durably retain the real Manager receipt already returned through its queue and offer a read-only query authorized by device ownership, target PC, role, and original key. This is forwarding evidence, not another plan or memory authority. If Relay stops before receiving the receipt, the answer remains unknown. Repeated POSTs or same-key 409 responses cannot substitute for authoritative recovery. This plan does not authorize generalized Manager refactoring.

## Proposed implementation and acceptance

The new pure helper `utils/knowledge-write-confirmation.js` is not wired into the page. It requires explicit `now/createKey/persist/send/validateReceipt` dependencies, with no default wx, crypto, HTTP or physical-input implementation. Three `capabilities` flags declare adapter obligations only, not evidence of verified host randomness, atomic durability or user confirmation. Real adapters require separate device acceptance. Tests use mock send only. The module is not included in the AIX, Check-Agent or runtime entry; the six read-only tools are unchanged.

Policy limits are 80 title, 120 single-line focus, 1000 content UTF-16 units, and 1–8 keywords of up to 80 units each, with a 60-second confirmation window. States are `awaiting-confirmation` → `dispatching` → `confirmed/uncertain`. Confirmation locks synchronously, persists the frozen original key/body before at most one injected send, and prevents unsent dispatch after cancellation, scope change, backgrounding or expiry during awaits. Persistence errors remain uncertain and block replay. Success is exposed only after final persistence and another scope check; cancellation never claims rollback. Restart conservatively restores even persisted `confirmed` records as `uncertain`; recovery-query wiring does not exist yet. `snapshot()` contains the original scoped intent for internal recovery and must not be displayed to another account or scope. Receipt validation and recovery queries need independent integration; do not relax the read-only runtime.

The implementation excludes the proposed cryptographic fingerprint, host atomicity, physical-input gate and actual Manager receipt validation; `validateReceipt` is currently injected in tests only. A send adapter must settle or reject within a bound. The pure module has no network timeout timer: a never-settling send remains pending without replay. Mock rejection proves only the rejection path, not real timeout recovery.

### Three device-probe prerequisites (not executed)

1. Record only sequence, relative time, tap/keydown/keyup callback, code/key/repeat/isTrusted fields, visibility and TTS state, never transcript text. Establish ordering and duplicates for single/double tap, hold, release after TTS interruption, and background changes. Preserve existing tap interruption and double-tap exit; do not invoke writes.
2. Probe crypto/getRandomValues/randomUUID availability and output length/shape without recording random values. Presence does not establish CSPRNG quality; obtain the official contract for the specific host version.
3. Read-only capability probes cannot establish storage atomicity. Inspect wx storage support first; only separately authorized tests may use a disposable isolated key with synthetic version/checksum data and controlled restart readback, never business configuration. One successful readback is not a durability guarantee.

Tests must cover wrong/expired codes, TTS echo, interim ASR, duplicate confirmation, changed credentials/role/PC/profile, storage failure with zero dispatches, double-click with one dispatch, timeout with no replay, wrong keys, fabricated receipts, restart recovery, expired queue leases, and lost receipts. Mocks cannot replace physical-confirmation and device false-trigger testing.
