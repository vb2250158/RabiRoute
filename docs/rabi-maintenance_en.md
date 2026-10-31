<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-maintenance.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Long-term Rabi maintenance and self-repair

Route catalog child termination timeouts block configuration saves. A later save or receipt lookup rechecks closure with the original process owner. Replacement writes remain blocked until closure is confirmed, after which the current request may proceed. An aggregate task failure is not proof that its children exited; failed or uncertain saves are not automatically replayed.

Saving one Route validates only the delivery rules being written, so unrelated unmigrated Routes do not block the save. Preview and migrate the current persona's legacy delivery rules with `scripts/migrate-agent-delivery-targets.ts`; it preserves snapshots, checks original files, and derives explicit targets from the existing delivery settings.

> Status: an Agent maintenance workflow. Configure and read back the plan, task binding, and scheduled triggers in the current installation. This document is not evidence that all bugs are fixed or a daemon independent of Desktop.

Plugin cleanup timeouts retain the actual owner's fence. Ordinary generation switching does not wait for application shutdown grace. During application shutdown, joins continue within the Manager resource owner's existing remaining budget. Only confirmed closure of every resource permits marking a previous timeout `lateConfirmed: true` and reporting successful exit. The original diagnostic remains; actual failure or unconfirmed resources still fail shutdown. A timeout proves neither that a process stopped nor that a subsequently confirmed closure remains unknown.

## P0: available APIs, matching documentation, and safe hot patches

This is the highest long-term maintenance priority, ahead of new business features: support frequent changes while keeping existing APIs available.

- **API documentation is a deliverable**: every new or changed endpoint ships matching paths, methods, authentication, request/response schemas, errors, timeouts, idempotency and receipt-query contracts, plus a minimal example. Documentation access must not depend on memory consolidation, an online Agent, or other background work. Do not advertise undeployed endpoints as current capabilities.
- **Validate before activation**: source changes produce an immutable candidate with code/documentation version identities and pass focused tests and compatibility checks. Never overwrite running files with work-in-progress source. Prefer hot replacement for compatible modules, without restarting unrelated APIs, message connections, or tasks.
- **Own in-flight requests explicitly**: new requests enter the replacement while the old module completes its existing requests. Drain requests, subscriptions, and resources before disposal. Freeze uncertain writes with their original key and payload rather than replaying them. Shared storage retains a single writer; zero downtime does not authorize two unisolated business writers.
- **Keep the old service on failure**: candidate preparation, documentation checks, or startup failure must not withdraw the working version. Activation failures must support rollback. Reject hot patches that require incompatible storage changes, cannot drain safely, or change core lifecycle; use a coordinated controlled transition instead of calling a forced restart a hot update.
- **Verify under continuous requests**: exercise independent reads and controlled fixture writes before, during, and after updates, checking disconnects, timeouts, lost requests, duplicate commits, documentation/code versions, and old-resource disposal. A build, one health check, or a page refresh alone does not establish hot-patch readiness.

Current limits: backend source follows the [source hot-patch matrix](source-hot-patches_en.md); installed pages use [Web hot patches](web-hot-patches_en.md) with production builds, automatic markers and managed rollback. Compatible updates do not restart Manager; initial patch support, Host or dependency ABI changes, and state without a supported migration require a full release.

## Isolating feature failures

Plugin packages retain per-instance loading results and diagnostics. Missing or damaged optional packages do not block available required capabilities; a failed update retains that instance's previously validated candidate and configuration. Missing required capabilities remain visible. Only the failed plugin and its actual dependents become unavailable. Independent consumers of a shared provider are not withdrawn together when one consumer fails activation; replacing an existing provider still rebuilds its affected consumers within the consistency boundary.

Instances sharing Web resources for the same `pluginId + version` prepare and roll back code revision upgrades together, keeping backend and page code consistent. Failed upgrades retain the confirmed revision; conflicting target revisions are explicitly rejected. Configuration-only changes with the same code hash, and instances without shared Web resources, remain independent.

If publication rollback fails, an old code revision does not prove that public state recovered. Admission to interfaces and services is immediately withdrawn for the affected atomic group and its actual dependents. Unconfirmed owners remain quarantined with degraded status while independent features stay available.

Profile and package metadata are read in separate child processes, with at most 2 active and 32 queued jobs by default. Bulk loading produces unique packages with backpressure and shares in-flight reads, so a large Profile does not reject valid plugins by filling its own queue. Each default 30-second budget starts at enqueue and includes startup, reading and closure. Children inherit only necessary OS settings, not production API credentials or Desktop IPC, and never import plugin entrypoints. Metadata is accepted only after process closure. Timeout or stop terminates and joins the original process before a managed cleanup child, bounded to 5 seconds, handles that job's unique staging directory. Unconfirmed closure retains the slot; cleanup failures remain explicit and do not publish the candidate.

Published metadata is retained by the actual generation's complete plugin identity and activationId. Subsequent fallback and Web resources use this confirmed snapshot. A version that loaded but failed activation cannot become a later fallback or replace resources belonging to an older active version.

Preparation, activation, each effect startup and post-publication startup have separate asynchronous wait budgets of 30 seconds by default; this is not a single 30-second deadline for the whole generation switch. Expiration closes the affected scope to new work while retaining ownership of unfinished work and late resource cleanup. Unconfirmed retirement prevents only the same owner from restarting, without holding unrelated plugin publication or failure handling. A timed-out wait is not proof that the operation stopped.

Public API deadlines finish the client's wait promptly while retaining uncertainty for writes that started execution. The original operation and late stream cleanup keep their actual leases. A drain timeout rejects with unfinished counts intact rather than claiming success or replaying a write. Availability is checked at the owning plugin and its dependencies, so one missing capability does not reject every unrelated mutation. Existing connection authentication and transaction checks remain in force.

When source discovery receives another edit, stale groups are requeued before compilation so repeated obsolete builds do not delay independent modules. Post-compilation source-version and publication-identity checks remain in place.

API registration reuses validated path metadata and independently reusable schema validators. Caches have entry and capacity limits while retaining reference scope and existing matching semantics. Lifecycle phases yield to the event loop so health checks, cancellation and unrelated requests can run. Cancelled phases that have not entered do not execute; work that has entered retains its actual ownership.

Bulk HTTP API registration uses `await registerOperationsAsync(..., context.lifecycle.signal)`: contracts and callbacks are captured first, preparation yields between operations, and the complete batch is installed only after success and a cancellation check. Failed preparation publishes no partial routes. Resources created before an await must immediately register idempotent cleanup; failed stops and late resources retain their unconfirmed-retirement fences.

Speech shutdown is handled and confirmed by the verified process owner, without racing additional microphone or playback HTTP stop requests. Stopping does not require launch dependencies to remain installed. Only an explicitly offline state can be reported as already stopped. Unknown ownership, an unowned process, failed termination or a still-online service remains an unconfirmed stop.

Trusted in-process business callbacks execute through their existing owners without short node:vm deadlines interrupting transactions. An asynchronous deadline ends waiting, not the underlying work; active resources and cleanup retain ownership. Native blocking calls, module evaluation and non-cooperative synchronous code require the existing Worker/process isolation and confirmed exit. Validation covers normal cold starts, injected failures, independent API responsiveness and actual retirement.

### Large request stores and API catalogs

A dedicated persistence process handles request records. The Manager retains a committed read model and reads complete delivery payloads and large record lists asynchronously when needed. One owner serializes mutations; caches, events, and successful results become visible only after the complete JSON has been atomically written, synchronized, and replaced. Failed drafts remain unpublished. A lost commit acknowledgement keeps an uncertainty fence and never triggers an automatic replay. This process only stores records and does not create or execute Agent sessions. Older runtime packages can still read the same complete JSON format.

While initialization is pending or records are unavailable, only dependent APIs report local unavailability. They must not return an empty catalog as if records were absent or block unrelated health checks and APIs. Background automation waits for its dependency, and both that wait and shutdown retain real ownership. Application exit confirms that the persistence process has actually closed. Troubleshooting must not delete history or overwrite the user store.

Help, capability, and OpenAPI catalogs are projected and encoded in batches from the same immutable snapshot. Each item retains its original contract validation. Prepared bytes are bound to their immutable response object, and the complete response schema is still validated before sending. Mutable external owner data is copied without being frozen. Fields, pagination, aliases, authentication, and ETag contracts remain unchanged. Large catalogs must not bypass validation through longer timeouts or opaque responses.

## Stable entry point

When an ID lookup for a plan or chat returns 404, search by its known name or page through recently active chats. Verify the full ID, persona or instance, workspace and binding before using a match. A matching name cannot replace the original object, and one 404 does not justify recreating or rebinding it. Response guidance should identify name search or recent-list operations supported by the current version. If an existing object incorrectly returns 404, repair the read, index or storage defect; search guidance does not replace that repair. Management timeouts, 5xx failures and unknown delivery receipts retain their original meaning and must not trigger message replay.

The maintenance plan owns intake, recovery, regression verification, and code quality for Rabi itself. Discover the current Manager and read the plan's unique `taskBinding.sessionId + workspace`. Do not guess by task title or create a task for every check. Keep the long-term plan executing between maintenance cycles; close it only when the user cancels or explicitly replaces it.

Reports contain minimal evidence: time, version/generation, action and expected/actual results, endpoint and error category, reproduction steps, log location, original business plan/task, and attempted recovery. Exclude credentials and unrelated conversations. Deduplicate by module, failing call site, error/symptom, and target; append new evidence to the same issue.

Use the [Rabi interfaces](rabi-agent-interfaces_en.md): discover Manager through Host and verify `/meta`, then use the thread bridge to deliver Agent reports and scheduled work to the bound task. Agent-authored plan feedback is `record_only`, even with `notifyAgent=true`; use it to preserve evidence, not to wake the task. User-authored guidance may use `notifyAgent=true`. Do not send identical content twice. Check feedback/request receipts and task state before retrying uncertain delivery. The maintenance task handles its own findings directly instead of sending messages to itself.

If a bug already has a plan and task binding, forward evidence to that owner and follow progress. Handle small unowned issues serially in the maintenance task. Give larger independently verifiable issues their own plan, creating another task only when necessary and authorized. Never modify the same issue concurrently.

## Outage recovery

Plan-storage recovery runs in a separate child process. Pending recovery or retries do not degrade Manager health; `businessReady` separately reports whether plan storage is ready. Affected plan mutations continue to return retryable 503 responses to avoid concurrent writes during recovery. `backgroundLifecycle.planStorageStartup` exposes recovery status and failure summaries. Do not delete records or bypass conflict validation to obtain readiness.

An independent Worker renews durable receipts for ordinary message delivery. Manager awaits heartbeat Worker startup and shutdown asynchronously, retaining the 10-second deadline for each handshake; waiting does not block HTTP health checks. Delivery still rechecks the original connection authority and receipt owner. An uncertain result requires reconciling the original delivery without automatic replay.

Use Rabi for managed delivery while it is healthy. Only current discovery and bounded retries establishing an outage allow the previously verified maintenance binding to receive reports through its existing Desktop owner. Follow the [delivery fallback contract](rabi-agent-interfaces_en.md); failure on an old port is not outage evidence. Do not switch channels while the original outcome is uncertain.

When plan writes are unavailable, retain a minimal pending report and actual fallback receipt, continue independent local diagnosis, and never directly edit persona plan/callback storage. After recovery, read actual state before reconciling; do not resend delivered content merely to obtain a formal receipt. Host owns installed lifecycle. Do not kill Manager, scan old ports, or start a second Runtime.

## Repair cycle

After a read worker returns a complete catalog, Manager prepares normalized immutable entries with a `setImmediate` yield between entries. The previous snapshot remains visible during preparation. Read fences and cancellation are rechecked before atomically replacing plan, memory and metadata caches. Do not synchronously normalize and copy the entire catalog repeatedly on the Manager thread or publish partially prepared results.

Optional LAN service discovery also starts after structured READY; Host does not wait for mDNS publication to confirm control-plane readiness.

Single-plan projections execute in read-only child processes. Feedback projection ETags retain the complete-package inventory algorithm, but attachments use 64 KiB streaming hashes instead of copying the entire package. Cached file hashes recheck device, file identity, size, mtime and ctime on every read; atomic replacement invalidates the cache, and plans and history remain validated on every read. Traversal and hashing yield between chunks. Plan detail retains revision and feedback summaries from the same full-package snapshot to avoid mixing versions. All-day recording intent restoration is scheduled after structured READY; failures remain diagnostic. Filesystem watch scans have a default 30-second process budget and exponential failure backoff capped at 30 seconds. Queued events do not bypass failure backoff, preventing repeated scan-process creation under load.

1. Confirm issue ownership, existing user/peer changes, failure scope, and reproduction evidence.
2. Reproduce or obtain evidence locating the failure. Make a minimal relevant fix and add meaningful behavioral regression coverage.
3. Run appropriate tests and `npm run build` for functional changes, update necessary bilingual documentation, and retire obsolete entries touched by the change.
4. For Manager, WebGUI, plugin, or startup changes, reload through Host and verify the new instance dynamically. Confirm that root HTML references the new asset hashes before retesting the original failure. Coordinate with the owner of an active build/reload.
5. Record implementation, tests, build, runtime verification, and remaining risks separately. Do not close an issue without required real-world acceptance. Keep the long-term plan open.

Routine local fixes, tests, builds, and necessary local Host reloads are maintenance work. Production publication, business-group messages, credential changes, destructive cleanup, and unrelated project changes require their own authorization. Maintenance does not authorize bulk log deletion or arbitrary dependency upgrades.

## Recurring maintenance

- Weekdays at 09:30: check current Host/Manager health, new failures, pending reports, and original task progress; prioritize blocking problems. Do not redispatch unchanged issues.
- Fridays at 09:30: add a quality review to the daily check, covering the week's changes for data ownership, module responsibilities, error handling, duplicate/retired entries, documentation, and useful tests. Run `check:codex-contract`, `check:event-driven`, `check:plugin-architecture`, and relevant tests, with full tests/builds as appropriate. Avoid unrelated formatting, large refactors, or dependency upgrades.
- Use the configured local timezone, Asia/Hong_Kong in this installation. Scheduling wakes a fixed coordinator task, which dispatches through Rabi. Use the recovery binding only during an outage so Rabi is not the sole source of its own failure notifications.
- Notify only for new actionable issues, completed repairs, failures, or required user decisions; remain quiet when unchanged. Record scope, actual results, and next actions.
- The host and Codex/Desktop must be able to run for scheduled work. Agents report discovered issues in the current turn rather than waiting for a scheduled check. Periodic maintenance is not a promise of real-time monitoring.

## Acceptance

Verify the actual plan/binding readback, target task receipt, enabled schedules, and reachable workflow references separately. Every subsequent bug still requires its own repair and original-scenario verification. Creating the maintenance entry does not prove completion of a quality review or a repair.

## Route catalog startup recovery

Windows process identity discovery requests only PID, parent PID, start time, and executable path, with a 60-second timeout. Failed discovery remains a failure; process ownership checks are not skipped.

Manager publishes structured READY first, then enumerates immediate Route and role directories in the background without recursively cold-reading the entire storage tree. Directory enumeration, each Route, each persona presentation, and each role's plan recovery run in terminable child processes. Local and NAS storage use the same path without changing configured directories. Defaults are four items per batch and two concurrent items (capped at sixteen and four), ten seconds per catalog-read item, and thirty seconds per catalog-read batch; batches yield to the event loop. A concurrency slot is released only after child termination is confirmed. Unconfirmed termination stops retries and retains degraded status rather than overlapping writes.

Every successful result is published immediately. `routeCatalogStartup.revision` and `snapshotInstalled=true` identify a readable catalog. Loaded Routes can be queried and run during running/degraded states, but catalog mutations continue returning 503 until the complete catalog is ready, preventing unloaded entries from being treated as deletions. Durable Route transaction recovery remains an integrity fence before reads; mutations and receipt resolution retain the existing serial transaction path. `planStorageStartup.summary.readyRoles` counts roles that completed lifecycle, layout, feedback, and package recovery. Plan writes for those roles are released individually; other roles still receive `PLAN_STORAGE_STARTUP_UNAVAILABLE`. Background work requiring the entire plan catalog still waits for full readiness.

Plan recovery includes layout, lifecycle, feedback and package receipt checks for one persona. Its per-item budget is 60 seconds, batch budget 150 seconds and default no-progress watchdog 180 seconds. Other catalog reads retain the 10-second/30-second budgets. Recovery remains in the background, ready personas publish immediately, and timed-out children must exit before retrying.

Failures preserve successful results, mark the lifecycle degraded, and retry in the background with exponential backoff from five seconds to a sixty-second cap. Plan recovery skips roles already completed in the current lifecycle and retains them when enumeration fails. Catalog captures no longer exhaust the mutation attempt limit. Existing timeout settings act as no-progress watchdogs, refreshing the deadline on progress rather than limiting total tree-loading time. `POST /reload` does not require an installed snapshot and remains serialized by the existing lifecycle. Evaluate `/meta` live/requiredReady separately from business recovery; unrelated interfaces remain available.

Regression entry: `node --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/progressiveStorageStartup.test.ts`. Coverage includes hanging items, batch deadlines, concurrency limits, partial success, stale progress, recovery after failure, real local child processes, and matching progressive/transactional catalog hashes. Real NAS, installed-build, and page acceptance still require an authorized deployment window. Do not delete locks or move configured storage to manufacture ready status.

Failed plan recovery children record bounded error details as `plan_storage_startup_child_failed` in the same private operational log. IPC and public health responses retain opaque failures. Task kind, role ID and child PID distinguish storage conflicts, file errors and timeouts.

Physical Codex Hook recall builds a fresh snapshot in its isolated worker, with at most four concurrent file reads per recent/consolidated memory directory. It never reuses UI caches or expired catalogs. File ordering, Markdown precedence, ID deduplication and recall updates remain unchanged, reducing serial NAS reads that can exhaust the thirty-second worker budget.

Hook context enumerates active plans only. Expired completed plans retain their existing archival transaction without a second catalog scan. Memory bodies remain in worker memory; each request enumerates current files and validates size, modification/change times and file identity. Changes reload, deletions remove, and unstable or failed reads never reuse an older body.

Physical Hook reads have a forty-five-second per-read default, configurable through `RABIROUTE_CODEX_HOOK_READ_TIMEOUT_MS`; ordinary knowledge pages retain thirty seconds. Cold persona context reads differ from paged queries, and adapter request budgets must cover the read plus discovery and identity checks. Large plan catalogs can configure item, batch and no-progress budgets through `RABIROUTE_PLAN_STORAGE_STARTUP_ITEM_TIMEOUT_MS`, `RABIROUTE_PLAN_STORAGE_STARTUP_BATCH_TIMEOUT_MS` and the existing `RABIROUTE_PLAN_STORAGE_STARTUP_TIMEOUT_MS`. Retries still require confirmed child termination and retain conflict checks.

Memory pages and counts derive from the same asynchronous physical catalogs and reuse metadata-verified bodies, avoiding a second synchronous memory scan for counts. Private operational logs record start, completion and elapsed time for plan lifecycle, layout, feedback and package recovery stages, identifying where a child stalled before its deadline.

Recent, consolidated and archived pages, counts and Hook context share an in-progress physical memory read for the same persona, avoiding concurrent cold scans of one directory. Results are not retained across requests as unchecked snapshots. Each read verifies files in the Rabi worker; IPC carries the persona directory and consumers validate ownership. UI caches and other personas cannot supply context.

Memory catalogs use one dedicated resident child with concurrency one. Page projection and other knowledge queries cannot scatter its file cache across children. Every request still validates current files and failures are not cached. The catalog read budget defaults to thirty-five seconds and is configurable with `RABIROUTE_MEMORY_CATALOG_READ_TIMEOUT_MS`; callers must also budget discovery and binding checks.

Synchronous plan locks allow the initial heartbeat acknowledgement to use the existing lease lifetime instead of failing after ten seconds. No transaction runs before acknowledgement; the worker still verifies the lock file, owner, reclamation fence and expiry on every renewal. Renewal intervals and final acknowledgement limits are unchanged.
