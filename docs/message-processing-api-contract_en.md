<!-- docs-language-switch -->
<div align="center">English | <a href="./message-processing-api-contract.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Executable contracts for message-processing control

> Status: source migration and focused isolated tests. Full builds, installed releases and physical cross-computer acceptance require separate overall verification.

`io.rabiroute.manager.message-processing-control` registers seven public operations through `createMessageProcessingOperations()`. The same definitions install routes, validate requests and responses, and populate the active catalog. The plugin no longer calls the old `handleMessageProcessingApi` HTTP dispatcher or maintains an exact/prefix list. Previous discovery IDs, `processing:METHOD:/api/message-processing/...`, remain aliases of the new contracts without installing additional routes.

## Operations and owners

Operation IDs use the `manager.message-processing.` prefix.

| Suffix | Method and path | Original owner |
| --- | --- | --- |
| `board.read` | GET `/api/message-processing/board` | Original Board aggregation, retaining routeId / limit queries |
| `requirement.record` | POST `/api/message-processing/requirements` | Native Board register_group / dispatch / dispatch_failed actions |
| `requirement.read` | GET `/api/message-processing/requirements/:requirementId` | Original requirement and stable identity; missing is 404 |
| `send-context.read` | GET `/api/message-processing/requirements/:requirementId/send-context` | Original context recovery and review snapshot, retaining sourceMessageId |
| `send-context.approve` | POST to the same send-context path | Original content-, version- and expiry-bound review credential |
| `outcome.record` | POST `/api/message-processing/requirements/:requirementId/outcome` | Original fact verification, source/revision fences and Board outcome |
| `knowledge-callback.record` | POST `/api/message-processing/requirements/:requirementId/knowledge-callback` | Original record verification, Board callback and reminders |

Authenticated remote connections use the same public APIs. Explicit source-session attribution, requirement ownership, native fact verification and content review remain request correctness and business contracts. Personas, plans and Skills do not add API feature grants. Context approval creates only the original business review credential: it sends no message and adds no connection permission.

## State, concurrency and recovery

`createMessageProcessingOwner()` directly invokes the original Board, context review, fact-record verifier, plan baseline, reminder and event services. The Board owns state; API code does not copy persistence, deduplication or pruning policies.

Group registration retains the original requirementId and source message identity. The native Board returns `created`, `existing` or `replay_suppressed`; suppressed historical replay produces no new reminder or Board event. Migration does not invent a new requirement, message or idempotency key.

Outcome and knowledge callbacks first await original asynchronous record verification, then revalidate the original request source and requirement `updatedAt` before mutating the native Board. Source invalidation, Node revocation or a requirement change cannot apply old evidence to new state. Outcomes still flow through the original plan baseline, reminders and Board events.

Only group registration has its original identity-based deduplication. Other writes gain no new generic idempotency guarantee. After timeouts, disconnects or uncertain responses, inspect the original requirement and review snapshot instead of generating another requirementId or resending a message. Review approval returns the original `sendContextReviewToken` and `expiresAt`, still bound by the review service to actual content, current context and expiry. Catalog discovery does not make old credentials permanent.

## Transport and retirement

JSON bodies retain the original 1 MiB limit, empty-body `{}` default, arbitrary Content-Type, unknown fields and native coercion. Malformed JSON remains 400. Exceeding the same limit now returns the registry's standard 413 with `API_REQUEST_TOO_LARGE` instead of the former 400. Contracts discard natively ignored read bodies. Unsupported methods on registered paths return 405 with `Allow`; unrelated paths still fall through.

Registry operation leases replace the original HTTP tracker. Retirement stops new admission and waits for accepted native verification to finish. HTTP disconnection does not release the lease early. When the server has observed a disconnect before commit, source revalidation also checks that request lifetime, preventing an uncommitted outcome from entering the Board. A missing client response never automatically rolls back already committed state.

## Verification scope

Focused API tests run the real contract registry, isolated HTTP servers and real Node enrollment. They use the original `MessageProcessingBoardStore` and temporary durable files to verify creation, deduplication, explicitly attributed outcome commits and independent reopen/readback. Tests also cover source changes, Node revocation, requirement revisions during verification, and lease joining after the server observes a disconnect. Platform, Agent delivery, plan verification and reminder boundaries remain controlled fixtures without real messages or plans.

Native Board and context-review regressions run alongside API tests, covering state, historical deduplication, fact evidence, original send ownership, content review and expiry. These results do not establish installed-release or physical two-computer message acceptance.

See the [target architecture](api-contract-discovery-target-architecture_en.md) and [implementation record](api-contract-discovery-implementation-progress_en.md) for overall acceptance.
