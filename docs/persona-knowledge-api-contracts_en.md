English | [简体中文](persona-knowledge-api-contracts.md)

# Executable contracts for role knowledge search and validation

This group registers the original Manager knowledge index, cache refresh and published-catalog validation for HTTP dispatch and remote discovery. Native owners retain the index, storage-delta workers and published catalog; no second plan or memory source is introduced.

| Operation ID suffix | Method | Path |
| --- | --- | --- |
| `search` | GET | `/api/roles/:roleId/knowledge/search` |
| `cache.status` | GET | `/api/roles/:roleId/knowledge/cache/status` |
| `cache.reload` | POST | `/api/roles/:roleId/knowledge/cache/reload` |
| `validation` | GET | `/api/roles/:roleId/knowledge-validation` |
| `validation.alias` | GET | `/roles/:roleId/knowledge-validation` |

There are five concrete routes. Full IDs start with `manager.personas.knowledge.`. Original derived `persona`, `knowledge` and `knowledge-alias` discovery IDs remain aliases. Authenticated empty remote nodes can invoke public operations without another role, workspace or feature grant.

## Original index and catalog

Search preserves keyword/fulltext modes, kind/archive filters, 1–100-item pages, queries up to 512 characters and versioned cursors. Responses retain native summaries, matches and detail URLs without adding plan or memory bodies to the contract. Warming indexes return 503 and expired cursor versions return 409.

Cache refresh preserves kind+id point refreshes or an all refresh, with IDs up to 512 characters. Unknown fields retain their original ignored semantics. Empty bodies decode to `{}`. The production route’s unlimited application body setting, `maxBytes=0`, remains intact. A 200 or still-refreshing 202 describes only the native index state.

Validation calls the original `validatePublishedRoleKnowledge` against the published catalog and reuses its write-limit DTO. A missing catalog requests the original Manager refresh and returns 503 `cache_unavailable`. The HTTP request does not scan source files or synthesize a replacement snapshot. Validation changes no plan, memory or role configuration.

## Connection, directory and worker lifetime

Each request captures the current role directory, original authenticated connection, Manager identity and exact original search-service instance. Changed directories, generations or service objects prevent older requests from disclosing their index results. New requests use current state.

Refresh still awaits native `KnowledgeSearchService.reload`; delta-worker deadlines, termination and shared-service lifetime remain unchanged. Cancelling one caller does not abort or replace the service used by other requests. That caller’s operation waits for native work to settle. Original Manager/pool owners retain service shutdown and reader-process termination.

## Verification and scope

Focused verification covers all five routes with actual empty-node authentication, native summaries/paging, kind/id/all and ignored fields, the original unlimited body behavior beyond 1 MiB, cold catalogs and both validation prefixes, changed directories/services, caller cancellation versus shared-service lifetime, and actual native delta-child shutdown after reading. Existing index regressions retain watcher, reconciliation, concurrent-commit and late-snapshot coverage.

Tests use isolated temporary data and controlled readers. They do not establish installed-runtime or physical-device acceptance. Plan/memory CRUD, role configuration and other owners retain separate migration boundaries and corresponding legacy prefix dispatch until complete.
