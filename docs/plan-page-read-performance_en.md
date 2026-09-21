# Plan-page reads: caching, reconciliation, and performance limits

[English](plan-page-read-performance_en.md) | [简体中文](plan-page-read-performance.md)

For maintainers. Status: an incremental engineering improvement requiring a normal build and actual Manager API verification before release. This is not a claim that a production persistent index for 100,000 plans is complete.

## Read path and ownership

Plan JSON remains authoritative. Successful publications in the Manager process advance a per-role invalidation revision. Page tasks carry that revision, and in-flight request coalescing includes it. Each resident reader consumes revisions independently; a post-write request cannot join a pre-write result.

A reader installs directory watches before creating its immutable catalog. Unchanged catalogs reuse presentation projections, also keyed by workflow content so that renamed statuses do not keep old labels. Existing filtering, sorting, totals, facets, archived views, and cursor algorithms remain unchanged. The experimental keyset interface does not replace the public cursor.

## External changes and failures

- Exact file events and plans named by managed invalidations are reread before replying. Dirtiness arriving during a read is consumed again. Repeated changes beyond the bounded retry budget fail explicitly instead of returning a known-stale snapshot.
- With a working watch, the next request after at least five seconds triggers a complete metadata reconciliation. It enumerates only the active/archive buckets and uses at most 16 concurrent metadata operations, avoiding per-directory `existsSync` followed by `statSync`.
- Metadata fingerprints compare size, mtime, ctime, and inode. Ordinary events without a filename trigger complete metadata verification, not unconditional body invalidation. Changed fingerprints rehydrate the affected bodies; missing or zero-valued identity fields are not trusted. Watch errors, explicit overflow errors, directory replacements, revision gaps, and explicit `authoritative` reads still force content reconstruction. Cold reads run contiguously in the isolated process with before/after metadata verification and bounded event-loop yields.
- Unchanged bodies are not reread. An unchanged signature retains the catalog and presentation. These fingerprint fields are not an absolute guarantee on every filesystem.
- Unavailable watches use conservative scans. Read errors fail closed, and a later request may rebuild; failures are not represented as successful empty results.
- Arbitrary external writes are not linearizable. A change that preserves every available fingerprint field and loses all watch events requires explicit authoritative rereading. Local isolated tests detect same-size replacements with restored mtime through ctime/inode; this is not a guarantee for every filesystem.
- Five seconds is a request-trigger interval, not an absolute external-write SLA. No requests means no polling. Reconciliation duration also depends on catalog size and filesystem behavior.

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

## The 100,000-row SQLite experiment is not production functionality

Experimental files reside in `tests/performance/`, outside the root `tsconfig.json` inclusion of `src/**/*.ts`. Production modules do not reference them:

```powershell
node --import tsx --test tests/performance/knowledgeSqlitePrototype.test.ts
```

Only an explicit `KNOWLEDGE_SQLITE_BENCHMARK=100000` enables the large workload. One isolated run on Node 22.17.1 / SQLite 3.50.0 completed 480 queries across 20 real reader Workers without errors, but overall query p95 was approximately 16.98 seconds and index/WAL storage was 55.81 times the source text size. This prototype was not approved for production integration. It is neither production acceptance for 100,000 plans nor evidence against every persistent-index design.

Remaining work includes selective candidates, query plans and phase timings for exact counts/facets, and real-API concurrency, cold-start, and read-after-write acceptance. This caching stage still has full metadata reconciliation, full projection after point changes, and cold content reconstruction costs.
