# Plan-page reads: caching, reconciliation, and performance limits

[English](plan-page-read-performance_en.md) | [简体中文](plan-page-read-performance.md)

For maintainers. Status: an incremental engineering improvement requiring a normal build and actual Manager API verification before release. This is not a claim that a production persistent index for 100,000 plans is complete.

## Read path and ownership

Plan JSON remains authoritative. Successful publications in the Manager process advance a per-role invalidation revision. Page tasks carry that revision, and in-flight request coalescing includes it. Each resident reader consumes revisions independently; a post-write request cannot join a pre-write result.

A reader installs directory watches before creating its immutable catalog. Unchanged catalogs reuse presentation projections, also keyed by workflow content so that renamed statuses do not keep old labels. Existing filtering, sorting, totals, facets, archived views, and cursor algorithms remain unchanged. The experimental keyset interface does not replace the public cursor.

## External changes and failures

- Exact file events and plans named by managed invalidations are reread before replying. Dirtiness arriving during a read is consumed again. Repeated changes beyond the bounded retry budget fail explicitly instead of returning a known-stale snapshot.
- With a working watch, hot requests consume file events and managed invalidation revisions without a five-second full scan. Cold starts, watch failures, unknown directory changes, and explicit refresh still reconcile sources, enumerating only active/archive buckets with at most 16 concurrent metadata operations.
- Metadata fingerprints compare size, mtime, ctime, and inode. Ordinary events without a filename trigger complete metadata verification, not unconditional body invalidation. Changed fingerprints rehydrate the affected bodies; missing or zero-valued identity fields are not trusted. Watch errors, explicit overflow errors, directory replacements, revision gaps, and explicit `authoritative` reads still force content reconstruction. Cold reads use at most 16 asynchronous hydration loops in the isolated process, retaining before/after metadata verification.
- Unchanged bodies are not reread. An unchanged signature retains the catalog and presentation. These fingerprint fields are not an absolute guarantee on every filesystem.
- Unavailable watches use conservative scans. Read errors fail closed, and a later request may rebuild; failures are not represented as successful empty results.
- Arbitrary external writes are not linearizable. External changes not reported by the watch require explicit authoritative refresh or restart reconciliation; this does not extend managed-write visibility windows. Local reconciliation tests detect same-size replacements with restored mtime through ctime/inode; this is not a guarantee for every filesystem.
- There is no background polling. With a working watch, elapsed time alone does not trigger a full scan.

The implementation does not silently return old results after checking only 256 files per request. It introduces neither permanent background polling nor a second business source of truth.

## First-screen counts use the interactive queue

The role-knowledge `counts` GET request now uses the existing interactive read pool instead of waiting behind low-priority catalog batch work. Identical in-flight counts are coalesced only for the same role and invalidation revision; post-write requests do not reuse an old revision. Worker and queue limits are unchanged. Counts read metadata only and do not initialize another full-body catalog.

All five existing fields remain: `activePlans`, `archivedPlans`, `recentMemory`, `consolidatedMemory`, and `consolidationRuns`. Memory and consolidation-run counts reuse their existing owner. Non-missing-file errors in the new asynchronous plan metadata scan fail explicitly instead of becoming zero.

## Bounded reader lifecycle

Idle children and IPC may be unreferenced, but active-request and termination-confirmation deadlines must stay referenced until success, failure, cancellation, or expiration. Completion paths clear those timers. Otherwise, a standalone program explicitly awaiting `run()` or `stop()` may exit early. Tests must not hide this with a permanent keepalive.

## Reproducible isolated checks

Run from the repository root using the same Node executable as deployment. `node` below must resolve to that version. Tests create temporary directories only and do not inspect configured real personas.

```powershell
node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/planReadInvalidation.test.ts src/manager/managerReadWorkerPool.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

$env:RABI_PLAN_BENCHMARK='1'
$env:RABI_PLAN_FAST='1'
node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/rolePlanPageBenchmark.test.ts
Remove-Item Env:RABI_PLAN_BENCHMARK, Env:RABI_PLAN_FAST
```

The benchmark creates 10,001 canonical plan directories and measures a cold read, 20 consecutive pages, three default-facet requests spaced 5.1 seconds apart, a point update, and deletion. Output retains every sample, synchronous/asynchronous I/O counts, and full-reconciliation reasons. It measures the read path, not the actual HTTP API. Do not report hot p95 alone while omitting cold or spaced samples. Resource contention matters: do not run this benchmark alongside other I/O-heavy regressions.

## Failed 100,000-record HTTP baseline (2026-09-22)

`tests/performance/planApiHundredThousand.test.ts` requires an explicit built `RABI_PLAN_API_PACKAGE_ROOT`, `RABI_PLAN_API_BENCHMARK=1`, and `RABI_PLAN_API_COUNT=100000`. Run the 1,000-record smoke test first. Fixtures include canonical status and history fields to prevent startup migration from changing sort keys. Only the real core/persona/diagnostics plugins run, with temporary state, dynamic READY discovery and identity checks; no business personas are accessed.

One run using the 0.3.13 candidate and Node 24.15.0 took approximately 842 seconds, including 163 seconds of fixture generation, and failed:

- Plan first-eight, subsequent pages, filters and concurrency groups failed, typically with HTTP 500 `Manager read exceeded 30000 ms.` after 30 seconds; some queued concurrent requests hit the client's 45-second timeout. There were no successful warm plan samples.
- Knowledge keyword search became available after approximately 149 seconds; four subsequent warm requests took 10–16 ms. Fulltext requests against that already-warm index took approximately 23–29 ms. First-eight IDs and totals matched an independent array oracle. Fulltext was not a separate cold-index run.
- Startup migration ended with `migrated: 0`; the test Manager shut down normally with exit code 0. This is not installed-runtime or deployment acceptance, and process cold does not mean OS-cache cold.
- A separate diagnostic reused the same 100,000 directories without the HTTP deadline: cold reading took approximately 119.5 seconds, comprising 111.5 seconds of `scanMs` (including 7.4 seconds of normalization) and 8.0 seconds for post-scan signatures, deduplication, freezing and publication. RSS was approximately 517 MB for this diagnostic process only, not peak process-tree memory. `scanMs` is not pure disk time.

Code inspection confirms that page-pool timeouts terminate the Worker and discard its in-memory cache, allowing subsequent requests to repeat cold loading. The bounded asynchronous loops still perform synchronous body reads on the cold path. These findings guide remediation; increasing a timeout is not acceptance. Cold first-page latency, complete process-tree resources, mixed record kinds, read-after-write visibility and cursor consistency remain unaccepted.

### Subsequent bounded asynchronous cold-read improvement (not accepted)

Cold stat/read/stat operations now run asynchronously within the existing maximum of 16 loops, retaining before/after metadata verification and replacement/deletion retries. A separately rebuilt diagnostic against the same directories reduced cold reading from approximately 119.5 seconds to 43.15 seconds; an immediate same-process catalog cache hit took approximately 1.54 ms, with RSS approximately 612 MB. This excludes HTTP and page presentation. Cold reading still exceeds the original 30-second deadline and does not satisfy first-page acceptance. All 13 invalidation/race regressions, type checking and an isolated full build passed; nothing was deployed. The synchronous-read description in the baseline refers to the pre-change version.

### Rebuildable checkpoints and per-role preparation (acceptance pending)

The page entry now uses a per-role lifecycle to own shared preparation. Caller cancellation does not stop preparation; shutdown waits for resource termination. The checkpoint resides at `.cache/plan-page-catalog.json` under the role directory, outside the plans watch tree. It stores normalized records and source fingerprints, validating format, role root, checksum and relative paths. Recovery installs watches first, reconciles all source metadata and consumes known invalidations. A persisted projection is neither immediate readiness nor a second business source of truth. Corrupt checkpoints fall back to source JSON; additions, changes and deletions during downtime remain governed by source files.

All 16 isolated regressions passed, including zero body rereads for unchanged sources, changes/deletions during downtime, corruption and path escape rejection. In a non-HTTP 100,000-record diagnostic on Node 24.15.0, initial construction took approximately 38.46 seconds and new-process recovery 20.09 seconds, with no body normalization during the recovery scan. Interval reads still took approximately 4.61/5.48 seconds, so periodic scan stalls remain unresolved. Diagnostic-process RSS was approximately 889–956 MB, not peak process-tree memory. These measurements used recursive freezing; subsequent iterative-freezing changes require separate measurements and cannot claim these figures as evidence of their effect.

Initialization HTTP responses, end-to-end restart, sustained ready-state availability and deployed-runtime acceptance remain incomplete. Checkpoints are written only during cold preparation, not rewritten in full by hot requests; restart must reconcile source metadata again.

### Event-driven hot-read retest (not end-to-end acceptance)

After removing the five-second full scan with a working watch, 16 regressions and an isolated full build passed. The regression advances the clock by one minute and checks that hot reads perform no synchronous or asynchronous enumeration or stat. A non-HTTP 100k diagnostic took approximately 31.27 seconds cold; the read after 5.1 seconds took 1.14 milliseconds, reused the same array, and reported no refresh reason. RSS was approximately 891–893 MB for the diagnostic process only. Reconciliation diagnostics retain the last cold measurement and are not the duration of this hot read.

The preceding real HTTP run with periodic scanning still failed: three initialization timeouts of approximately 45 seconds, followed by first-page reads of 272–286 milliseconds, search at 1.58 seconds, and one view request at 6.37 seconds. The HTTP retest without periodic scans and the initialization-response flow remain unaccepted; non-HTTP improvement is not completion.

### Explicit initialization responses (end-to-end acceptance pending)

Paged GET and query POST return HTTP 503, `reason: "PLAN_CATALOG_INITIALIZING"` and `Retry-After: 2` while shared preparation is incomplete, without fabricated empty data. Preparation continues independently of any individual request. Real page results, including genuinely empty lists, are returned only after readiness. Invalid parameters retain the existing 400 contract.

The Web client retries only this exact error from page reads, serially and within five minutes or 150 attempts, honoring `Retry-After`. Other errors are not retried automatically. A preparation notice is displayed; switching personas or hiding the page cancels the current wait without stopping server-side preparation. Failed refreshes of the same query preserve previously loaded data and cursor; persona changes clear the old list. Twelve retry/lifecycle unit tests and an isolated full build passed; 100k HTTP acceptance at concurrency 20 and installed-runtime verification remain incomplete.

## The 100,000-row SQLite experiment is not production functionality

Experimental files reside in `tests/performance/`, outside the root `tsconfig.json` inclusion of `src/**/*.ts`. Production modules do not reference them:

```powershell
node --import tsx --test tests/performance/knowledgeSqlitePrototype.test.ts
```

Only an explicit `KNOWLEDGE_SQLITE_BENCHMARK=100000` enables the large workload. One isolated run on Node 22.17.1 / SQLite 3.50.0 completed 480 queries across 20 real reader Workers without errors, but overall query p95 was approximately 16.98 seconds and index/WAL storage was 55.81 times the source text size. This prototype was not approved for production integration. It is neither production acceptance for 100,000 plans nor evidence against every persistent-index design.

Remaining work includes selective candidates, query plans and phase timings for exact counts/facets, and real-API concurrency, cold-start, and read-after-write acceptance. This caching stage still has full metadata reconciliation, full projection after point changes, and cold content reconstruction costs.
