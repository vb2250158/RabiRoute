English | [简体中文](persona-history-api-contracts.md)

# Executable contracts for persona chat and voice history

This group registers native chat history, AIUI exchanges, voice transcripts, message excerpts and conversation snapshots through executable definitions. Original JSONL records, byte cursors, speaker classification, indexed read processes and snapshot storage remain authoritative. No real Agent prompt is generated.

| Operation ID suffix | Method | Persona path | Prefixes |
| --- | --- | --- | --- |
| `chat.read` | GET | `/:roleId/chat-history` | `/api/roles` and `/roles` |
| `chat.aiui.append` | POST | `/:roleId/chat-history/aiui` | `/api/roles` and `/roles` |
| `voice.read` | GET | `/:roleId/voice-transcripts` | `/api/roles` and `/roles` |
| `situations.list` | GET | `/:roleId/conversation-situations` | `/api/roles` and `/roles` |
| `situations.detail` | GET | `/:roleId/conversation-situations/:situationId` | `/api/roles` and `/roles` |
| `messages.search` | GET | `/:roleId/message-endpoint-history` | `/api/roles` |

There are 11 concrete routes. Full IDs start with `manager.personas.history.`; `/roles` IDs add `.alias`. Original derived `knowledge`, `knowledge-alias` and `persona` discovery IDs remain aliases. Authenticated remote connections can invoke public operations without another feature grant.

## Original record semantics

Chat reads retain byte-offset paging, 1–100 entries per page, original cursors and Unicode text. `summary=true` requests summaries; `direction=newer` with a cursor retrieves newer records, and `id` fetches one record on demand. `invalidRecords` reports damaged rows and continuation cursors identify remaining scan work; an empty page does not establish the end of history. Desktop metadata resolves current titles and links using full original session IDs. Missing metadata cannot hide saved records. AIUI rows neither query Desktop nor deliver messages; native session/turn identities deduplicate replay and reject conflicting text.

AIUI POST retains the 128 KiB body limit, four original fields, 128-character session/turn rules and 16000-character text limits. Native append accepts an optional pre-append fence, rechecking the original connection, directory and Manager identity after queue waits and file opening, before the actual append. Native hashes, receipts, conflict checks and other chat writes remain unchanged.

Voice queries retain the bounded native reader, user/other/unknown/conflict classifications, time filters, archives and summary mode. A situation detail remains a lookup within the requested recent window; `limit` cannot be bypassed through an unrestricted direct lookup.

Message queries retain 200-entry and 200000-character bounds, Unix-second times, nonnegative sequence bounds and all native filters. Results explicitly describe a latest-matches excerpt with unknown completeness and no cursor/offset pagination. Index versions do not establish complete source coverage. The default HTTP budget is 2500 ms and can be configured through WebGUI `history.request`. An explicit integer `budgetMs` from 1 to 2147483647 overrides the default. Forwarding preserves the original deadline; separate queue and execution budgets still apply. See [message history search](message-history-search_en.md) for partial derived-index coverage and its 8 MiB per-record working budget, which does not limit original message writes. Successful reads and query failures retain the original requestId and response telemetry.

Timeout/disconnect aborts the original query without waiting for a reader that never settles before responding. The native worker pool still owns cancellation, child-exit confirmation and quarantined slots. An expired HTTP budget does not establish child termination. Owners recheck the original connection, current directory and Manager identity after awaited work and before disclosure, preventing revoked or replaced owners from exposing old results.

## Validation and boundary

Isolated verification covers all 11 routes and successful authenticated empty-node access, native chat paging and metadata fallback, AIUI replay/conflicts, write-queue directory fencing, four voice-authority revocation modes, actual indexed reader filters/archives/budgets/queueing/cancellation/exit, and independent health responsiveness. Tests do not read real persona history or run a real Agent, and do not establish installed-runtime or physical-device acceptance.

Other persona APIs retain legacy prefix dispatch until their owners have migrated and passed verification.
