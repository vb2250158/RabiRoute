<!-- docs-language-switch -->
<div align="center">English | <a href="./device-agent-api-contracts.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Device Agent mailbox API contracts

This page is for Manager and device-host developers. `src/agentAdapters/deviceAgentOperations.ts` installs 13 HTTP operations and publishes discovery from the same executable definitions. `deviceAgentOwner.ts` owns native business rules and the PC journal. Exact contracts replace the previous directory/prefix declarations.

## Ownership and observable contract

This migration changes HTTP registration, validation and discovery. The original device host remains the only executor; the PC manages delivery, wake requests and receipts. An absent device never creates a PC model or fallback Runtime. Desktop startup, port 4510, user environment, session binding and the permission model are unchanged.

| Requirement | Authoritative owner | Evidence | Prohibited substitute |
| --- | --- | --- | --- |
| Correct session receives input | Full session ID and owner epoch loaded by the device | Original device claims the delivery and returns matching identity | Same-name session or another Runtime |
| Execution result | Original PC delivery receipt and device-sourced response | Read `ownerAccepted` separately from terminal response | 202, wake submission or build success presented as an answer |
| Model, tools and permissions | Original device host | Physical host execution evidence; isolated drivers only prove protocol behavior | PC execution or inferred tools |
| Session renewal/replacement | Full identity reported by the device | Same-owner renewal retains epoch; replacement cannot execute old claims | Automatic replacement session |
| Absent device | Durable PC mailbox | Queued, failed wake or `result-unknown`, without fabricated acceptance | Another device |
| Absent Rabi | Independent device-host lifecycle | Physical independent-startup acceptance remains separate | Router becomes a model startup dependency |

The device host starts, stops and owns its Host/UI, model Runtime, session, turn, tools and approvals. PC Manager owns the durable mailbox and HTTP/event wait resources; Relay/P2P provides authenticated transport. Recreating Manager invalidates old loaded leases. Publishing a replacement session marks claimed deliveries and queued prepared deliveries tied to the old owner as `result-unknown`, without replay.

## Operations

Operation IDs use prefix `manager.device-agents.`; paths below use prefix `/api/device-agents`.

| Operation | Method and path |
| --- | --- |
| `list` | `GET` root |
| `session.read` / `session.publish` | `GET` / `PUT /:agentId/session` |
| `pending.read` | `GET /:agentId/pending` |
| `deliveries.enqueue` | `POST /:agentId/deliveries` |
| `wake-requests.list` | `GET /:agentId/wake-requests` |
| `wake-requests.claim` | `POST /:agentId/wake-requests/:nonce/claim` |
| `wake-requests.receipt.record` | `POST /:agentId/wake-requests/:nonce/receipt` |
| `deliveries.claim` | `POST /:agentId/deliveries/claim` |
| `deliveries.receipt.read` | `GET /:agentId/deliveries/:deliveryId` |
| `deliveries.response.record` | `POST /:agentId/deliveries/:deliveryId/response` |
| `prepared-deliveries.enqueue` | `POST /:agentId/prepared-deliveries` |
| `prepared-deliveries.reconcile` | `POST /:agentId/prepared-deliveries/reconcile` |

Authenticated enabled connections can discover, read and deliver to the correct target without persona, plan or feature allowlists. Only the original signed device can publish its loaded session, claim work and return responses. Those checks establish execution provenance and object ownership rather than another feature grant. Prepared delivery retains signed original-ledger reservation readback and never trusts body-declared source/target authority.

## Data and recovery

The original PC's `RabiLinkOwnerStore` saves `device-agent-owner` by connection scope. Each device holds at most 1024 deliveries, rejecting new ones at capacity without evicting receipts. A delivery ID replays only the matching original fingerprint. Message source, full session ID, visible name, owner epoch, prepared generation, source/target endpoints and hashes retain native semantics.

Loaded session leases last 45000 milliseconds; capabilities are deduplicated and retain the first 16. Individual capabilities and names are limited to 80 and 160 UTF-16 units. Message content, rendered prompt and device response limits are 131072, 262144 and 32768 units, with at most 64 context/control blocks each. Executable schemas consume the original owner's shared limit definitions. JSON retains the absence of an application byte cap; writes accepting an empty body retain `{}` as their default.

`waitMs` uses `Number` conversion and the 0–12000 millisecond boundary. Invalid numeric input becomes zero to prevent an infinite receipt-wait loop. Original-scope events drive waits. Cancellation releases the original timer/listener; registration retirement joins actual cleanup. Preparation captures the original connection, delivery authority and owner before body parsing, then rechecks after assignment, peer-ledger and receipt waits. Identity changes after a write begins return an uncertain result and retain the original journal instead of writing to a replacement owner.

A 202 delivery result means queued; wake submission does not establish a claim. Reconcile uncertain results using the original delivery ID; prepared deliveries retain their generation and endpoint proof. Only an actual device claim creates owner acceptance. Answers and external delivery remain separate acceptance facts.

A damaged mailbox is isolated by its original agent ID and its raw value is retained. Other devices in the same connection retain directory, receipt and delivery access. The directory's `recordIssues` lists affected agent IDs and error codes; accessing or redelivering to that ID returns `409 DEVICE_AGENT_RECORD_INVALID` instead of treating a missing receipt as evidence that execution never occurred. Healthy writes retain those original records. An unknown root structure or storage version prevents reads and writes only for that connection scope, without resetting data or affecting other scopes.

## Verification boundary

Source verification uses controlled device drivers, independent temporary PC journals, isolated HTTP Managers and temporary Relay/P2P processes. It covers same-session delivery/formal replies, absent devices, restarts, forged sources, cross-Manager ledger proofs, old owners/revocation, admission before parsing, cancellation and retirement. No physical glasses/phone or real task is contacted; these tests do not raise host maturity. Installed-runtime and physical two-computer evidence remain separate gates in the [overall target architecture](./api-contract-discovery-target-architecture_en.md).
