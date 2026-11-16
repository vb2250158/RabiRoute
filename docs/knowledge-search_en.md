# Plan and memory summary search

English | [简体中文](knowledge-search.md)

Begin Agent task retrieval with at least one `GET /api/search` through `rabi-knowledge-search`. Read contents, coverage and real entries before choosing detail queries, keyword changes or local search. Known files, previous standards, examples and direct collaboration follow this sequence. Users can state their task directly. Reuse a valid search result for the same objective within the current turn. Record discovery, connection, target-query or calling-tool failures once, skip the same failure for the current turn and continue the original task through available tools and local retrieval. Retain successful sources when another source fails.

Unified items use `label`, `excerpt`, `source`, `kind`, `origin`, coverage and `handle`. Verify details through `handle.detailUrl` or the returned operation contract. Empty results and partial coverage guide further retrieval. When generating a file under an earlier standard, search for that standard first, then verify matching examples and the current format.

The following sections describe the original knowledge-source query. Manager owns one derived in-memory index per persona. Files remain authoritative. Search neither writes records nor updates viewedAt.

## API

Existing Manager discovery, authentication and read-only restrictions apply.

| Request | Purpose |
| --- | --- |
| `GET /api/roles/:roleId/knowledge/search?query=topic&limit=10` | Keyword summaries |
| Same endpoint with `mode=fulltext` | Explicit substring search over prepared in-memory text |
| `GET /api/roles/:roleId/knowledge/cache/status` | Readiness, version, counts and refresh errors |
| `POST /api/roles/:roleId/knowledge/cache/reload` with `{}` | Diagnostic metadata reconciliation |
| Same POST with `{"kind":"plan","id":"example"}` | Force a point read |
| Same POST with `{"all":true}` | Rebuild the persona index |

Reload is automatic during normal operation. `kind=plan|recent|consolidated` filters records; `archived=1` includes archived records. Limit defaults to 10, maximum 100. Keywords use NFKC and case normalization and match IDs, complete titles and keywords. Whitespace-separated terms are combined as a union. Extract topic terms from natural-language questions; fulltext never silently falls back to filesystem scanning.

`data.items` contains identity, type, title, focus, keywords, status, archival state, update/view times, revision, a maximum 160-character excerpt, matchedBy and detailUrl. Continue with `data.nextCursor` and unchanged query parameters. A changed index version returns 409; restart pagination. A warming index returns 503. Memory detail reads retain their existing viewedAt behavior.

## Refresh and cost

Read children send `ready` after installing their IPC listener. The parent dispatches the first request only after that signal, preventing message loss during initialization. Startup waiting stays within the original request timeout; cancellation or shutdown prevents later dispatch. Publish parent and child together; the protocol does not support an older child.

Interactive readers use normal process priority to avoid starvation on busy Windows hosts. Background catalog scans retain low priority. Concurrency, queue and timeout limits remain unchanged.

For skill catalog or body timeouts, verify `GET /api/roles/:roleId/skills` and `GET /api/roles/:roleId/skills/:skillId` separately, then verify listing and loading in the actual Agent. Check reader startup, process priority and queues; increasing the client timeout alone does not fix process starvation. Verify plan-storage recovery separately: successful skill reads do not prove that plan APIs have recovered.

Plan pagination watches canonical `plan.json` files and plan directory replacements under `active` and `archive`. Quarantine leases, transaction manifests and attachments do not rebuild the catalog, preventing background recovery from repeatedly interrupting the first page. Unknown events and watcher failures still trigger full validation.

The index maps keywords to references, references to summaries and search text, and references to old keywords. Hot searches perform no filesystem access. Fulltext scans prepared memory text. Metadata updates replace summaries; only changed IDs, titles or keywords rebuild postings. viewedAt does not rebuild postings.

Recent-memory create, update and touch commands publish a point projection instead of recapturing the entire role knowledge catalog. Existing write leases, revisions and idempotency remain in place. Storage compatibility and identity checks are separate from search I/O; this does not claim that every write avoids directory scans.

Watchers are attached before initial loading. API commits publish point changes, while file events are debounced for approximately 150 ms. Bounded workers reconcile fingerprints and parse changed files only. Duplicate events do not rebuild unchanged postings. Approximately every 60 seconds a metadata check repairs missed events; remote shares use this background path. Directory enumeration remains linear but is outside hot search requests.

Full rebuilds retain the previous valid index and reject results superseded by newer changes. Parse and I/O failures preserve valid records and retry automatically. Incomplete cold indexes are not served as complete results. Deletes remove old postings; conflicting identities report errors. filesRead counts accepted worker batches, not total process I/O.

## Validation

The index, service and HTTP route tests cover keyword removal, view metadata, isolation, cursors, automatic file watching, zero document reads for unchanged reconciliation, storage-free hot search, concurrent rebuilds and summary contracts. Measure actual latency using the same dataset; structural tests alone do not establish production speedups.
