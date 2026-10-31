English | [简体中文](reliable-agent-delivery.md)

# Reliable Agent delivery and records

Status: source-connected; isolated fault tests and installed-runtime acceptance are separate evidence. This page does not claim deployment to connected computers.

Business Hooks or plugins choose when to send, content, target and reply policy. Rabi durably accepts explicit delivery intents, transmits in the background, recovers, and stores acceptance evidence. `responsePolicy=none` does not weaken the reliability of a submitted delivery.

## Viewing records

Open **Delivery records** (`/deliveries`) in the WebGUI sidebar. The default owner is the current host; select an original computer to inspect its client queue. Filter by status, search IDs, page through records, and open details for targets, attempt counts, errors and receipts.

Queued means saved; awaiting confirmation means acceptance evidence is incomplete; received means the target owner accepted the content. None means business execution completed. Missing historical times or counts remain unrecorded.

The host cannot inspect a disconnected computer's local queue. The page reports that it cannot read current records instead of implying an empty queue. Read it again after the original client reconnects. Opening details never resends a message.

## The original client owns sending

The stable launcher remains the only main program. A short-lived CLI submits through its existing authenticated local control channel to the original worker. The worker acknowledges local acceptance only after committing the configuration-adjacent `delivery-<config-hash>.sqlite` transaction with SQLite FULL synchronization. CLI exit preserves it.

Worker startup loads unfinished records; reconnect and backoff expiry resume them. Existing managed startup must start the original client after reboot. Sending cannot run while the computer or client is off. The queue lives outside release directories and must survive updates. Uncommitted candidates do not take queue ownership; handoff pauses the original sender.

Each attempt reloads current configuration and uses EndpointSession to discover and verify the original Manager. Acceptance pins the original Manager GUID; pairing with another Manager does not transfer old records. Callers manage no ports, URLs or generations. Do not scan ports, rebind targets or downgrade HTTPS.

## Calling

Existing `--api POST /api/agent/threads` calls with `action=send`, including formal `inReplyToRequestId` replies, automatically use durable submission. The original request body contract remains; provide the actual Agent type and full source session ID. The CLI generates and returns deliveryId when omitted. Callers needing deduplication across their own restarts should persist a business key.

`--operation`, JSON from standard input or a file, and the public SDK's request / invokeOperation calls use the same entry after resolving the same send contract. Verified send descriptors are durably cached under the original Manager GUID, so a new CLI process can resolve them while the host is offline. An operation ID that was never verified is explicitly rejected before acceptance when the catalog is unavailable; mappings are never guessed. Existing HTTP-style callers retain statusCode / body, with 202 and queued status for local acceptance.

Alternatively use `--delivery-submit --body-stdin --agent-type TYPE --id FULL_SESSION_ID` with `{ "intentId": "stable-operation-id", "request": { ...original send request... } }`. The optional intentId must match request.deliveryId when both are supplied. `acceptance=local-durable` proves local acceptance only.

Use the same installed launcher with `--delivery-query ID` or `--delivery-list [--cursor CURSOR] [--limit N] [--state STATE] [--query TEXT]`. Module callers use `createReliableDeliveryClient({configPath,agentType,sessionId}).submit/get/list` from `apps/rabi-agent/lib/delivery-control.mjs`.

An unknown local ACK returns the original intentId and `accepted=null`; query that ID instead of creating a replacement. Disk-full or failed transactions provide no durable acceptance guarantee. Mutable local imagePaths are currently rejected before acceptance rather than silently ignored; generic immutable attachment support remains an extension requirement.

Other HTTP operations, platform sends and streams retain their own contracts. This feature does not automatically retry arbitrary POST/PATCH requests.

## Configuration

Configure the original client's deliveryPolicy:

```json
{
  "deliveryPolicy": {
    "maxPending": 10000,
    "maxBytes": 67108864,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000,
    "pollMs": 1000,
    "maxConcurrency": 4,
    "maxPerTarget": 1,
    "ordering": "target",
    "requestTimeoutMs": 8000
  }
}
```

These control capacity, exponential backoff and queue scheduling. By default, up to four different targets progress concurrently, with acceptance order preserved within each target. A slow target does not occupy every target's slot. With ordering=none, maxPerTarget may allow concurrent work for one target; maxConcurrency is capped at 64. Capacity rejection precedes acceptance; accepted messages are not evicted, cancelled and delivered records do not consume pending capacity, and pending messages have no default expiry. Scheduling reads the queue, not host session scans or port scans. Explicit disablement, payload conflicts and identity changes retain visible reasons; re-pairing must not bypass them.

## Same IDs and acceptance evidence

The same intentId and content returns its original record; changed content or target conflicts. Manager derives a formal deliveryId from authenticated source identity and freezes content, target and execution options. Pre-send verification failures stay prepared and resume that snapshot.

Dispatching records reconcile original evidence. Only positive transport-owner proof that no prompt frame was sent permits returning to prepared. The proof must be persisted first and bound to the original target, prompt and execution-option hashes, Manager dispatch attempt and remote transport attempt. Old proof cannot reset a newer attempt. A lost proof response is recovered by querying the original durable proof after reconnection. Timeout, disconnection or a missing receipt is not such proof. Committed returns the original receipt; cancellation cannot retract already accepted content.

LAN taskResult is persisted by the client before sending with eventId. Manager durably records original node, task and full-result hash before resultAck. Lost ACKs, reconnection and Manager restart do not apply the same result twice. A local completed display does not remove unsent result responsibility. All unfinished tasks remain; completed details may be compacted while minimal result and idempotency evidence remains.

The real Desktop can provide positive receipt recovery through exact deliveryId and promptHash in owner records. Its durable native idempotent acceptance contract has not been established. The entire crash window after Desktop acceptance but before adapter receipt persistence is not proven closed. Preserve awaiting-confirmation status when evidence is missing instead of claiming delivery or blindly executing twice.

## Read-only APIs

| API | Result |
|---|---|
| `GET /api/agent/deliveries?limit&cursor&state&query` | Redacted projection of current Manager records |
| `GET /api/agent/deliveries/:deliveryId` | Original record and acceptance evidence |
| Add nodeId to either API | Read the original computer's durable queue; offline is explicitly unobservable |
| `GET /api/agent/deliveries/caller/:callerDeliveryId` | Reservation and receipt scoped to the current authenticated source |

Only exact DELIVERY_NOT_RESERVED with canSubmitSameIntent=true proves that this source key has no reservation and may submit the same intent. Reads use the same source-session guard as sends; stale saved connector context cannot replace an explicit source session. Damaged records retain their original fields and reserved IDs while other complete records remain usable. An unreadable ledger or incomplete reservation identity returns unavailable evidence, refuses to overwrite the original file, and never authorizes replay or appears as a successful empty list. Authenticated connections retain existing public API access without another feature grant.

## Upgrade, rollback and acceptance

Prefer [native source patches](source-hot-patches_en.md), checking the running owner, imports, state and lifecycle individually. A compatible shape does not prove that a new API was registered; new state or migration entry points require a verified migration contract. Never bypass review by clearing markers, changing private runtime fields or substituting a baseline. Preserve the original service when no supported migration entry exists, and let the single publication owner arrange a controlled generation switch.

An unsupported queue schema refuses ownership while preserving files. Old Manager versions do not retain resultReceipts extensions. Do not let an older version overwrite the new ledger without original-record reconciliation and a complete recoverable snapshot.

Source and isolated tests cover persistence failure, CLI exit, original-owner restart, offline targets, dynamic addresses, conflicts, lost ACKs, prepared resume, no blind dispatching replay, result deduplication across Manager restart, and GUI reads. Installation, original computers and actual Desktop require separate runtime evidence. Builds and page fixtures are not two-computer acceptance.

Codex, WorkBuddy and Antigravity Hooks expose failed or uncertain completionDeliveries and IDs actually returned by the service. Missing IDs and recovery states remain explicitly not returned. Displaying a diagnostic does not resend content; business conditions remain in the business Hook.
