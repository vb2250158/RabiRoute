<!-- docs-language-switch -->
<div align="center">
English | <a href="./bilibili-history-bridge.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Bilibili history bridge APIs

Audience: integration developers and maintainers. This page describes executable source contracts. Passing source tests does not prove an installed update or acceptance with a real browser/account.

Manager stores jobs and accepts pages from the fixed browser extension; it does not access Bilibili login state directly. The extension only reads `https://api.bilibili.com/x/web-interface/history/cursor` and never deletes or changes viewing history. Real queries must remain within the user's requested dates, count, and persona.

## Routes and discovery

Each contract installs its route and generates discovery. The former prefix-based business handler is removed. All operation IDs below share `manager.bilibili-history.`. The base `/api/bilibili-history/` remains case-sensitive. The three dynamic read operations retain their native compatibility: literal `roles`, `days`, and the job-read `jobs` segment accept mixed case while parameter values remain unchanged. Other fixed operations and POST paths remain case-sensitive.

| Method/path, prefixed by `/api/bilibili-history/` | Operation ID | Result and effects |
| --- | --- | --- |
| `POST bridge/pair` | `bridge.pair` | Pair the fixed extension; the same extension recovers its existing producer token without replacing the pairing |
| `GET status` | `status.read` | Read pairing status and the latest 20 sanitized jobs |
| `GET roles/:roleId/days` | `roles.days.read` | Rebuild the selected persona's date index in memory from private shards without writing an index file |
| `GET roles/:roleId/days/:date` | `roles.day.read` | Read one day; offset defaults to 0, limit to 100 (bounded 1–500) |
| `POST jobs` | `jobs.create` | Queue a time-window job for an existing persona; return 202 and its unique ID |
| `GET jobs/:jobId` | `jobs.read` | Read the original job and aggregate progress |
| `GET bridge/next` | `bridge.next` | Update extension last-seen time, move the original queued job to running, return its fixed read-only endpoint and cursor |
| `POST bridge/page` | `bridge.page` | Persist the original job's page, deduplicate records, advance its cursor or stop it |
| `OPTIONS :remainder` | `options` | Preserve preflight for every original prefix suffix, including empty/unknown paths; return bodyless 204 |

Public operations retain Manager connection authentication. Enabled authenticated remote connections need no feature-specific grant. The existing next/page token identifies the browser page producer and prevents forged submissions; it is not another Manager management key. A supplied pairing Origin must match the fixed extension ID. Responses do not grant arbitrary `Access-Control-Allow-Origin`.

JSON bodies are limited to 1 MiB, retaining existing Content-Type behavior and the empty-body `{}` default. Preparation captures the original bridge and persona root before consuming the body. Retirement or a root change prevents the original request from executing against another directory. Invalid producer credentials reject page submissions with 401 before JSON decoding.

## Persistence and recovery

Global state contains pairing credentials, jobs, cursors, and aggregates. Public status excludes the token, last-page deduplication key, and internal per-record bookkeeping. Raw titles/URLs belong only to the selected persona's `runtime/bilibili-history/daily/` shards. Author/theme aggregates also describe private behavior and should not be sent to unrelated tasks or public material.

Job creation has no request-level idempotency key; 202 acknowledges queuing. After an uncertain failure, inspect status and the original time window before creating another job. Despite its GET method, next writes state and is not a side-effect-free probe.

Each page processes at most 30 records. The last pageKey prevents duplicate last-page accounting, while stable record IDs deduplicate overlapping pages. Shards, index, and global state are not one atomic cross-file transaction; reconcile the original job and date records before recovery. Codes -101/-412 pause immediately; other nonzero codes fail. Empty pages, crossed time boundaries, unchanged cursors, or 20000 pages stop the job.

Constructing a candidate only reads state: it neither pauses jobs nor writes files. A failed candidate closes only its own instance and routes while the original instance keeps serving its queue. Following formal publication, the `afterPublish` callback registered through `context.publication.add` waits for `previousRetirement`, then reloads the original instance's latest pairing, job IDs, cursors, and queue before pausing legacy active jobs without a persona. Read-only startup changes only the new instance's memory. Rolling back a code revision also resumes the existing queue without creating replacement jobs.

Retirement closes the original owner and stops new admission, then joins its accepted operations before enabling the replacement. Late cleanup affects only the original instance. A migration write failure after publication is a runtime failure; it does not prove automatic persistence rollback. This module owns no background workers or streams. The browser remains the sole page producer and is not started or stopped by Manager. This module does not open browsers, start alternate Agent runtimes, or send history data.

## Validation scope

Focused tests use temporary directories and synthetic pages for construction/preparation failures without state writes, formal publication, original-queue recovery, code-revision rollback, retirement joins, read-only migration, and failed migration writes. Existing pairing, producer validation, enrolled empty remote nodes, private shard readback, overlap deduplication, risk pauses, all-prefix OPTIONS, and body-limit regressions remain covered. They do not access real accounts or prove browser-extension or two-computer acceptance.
