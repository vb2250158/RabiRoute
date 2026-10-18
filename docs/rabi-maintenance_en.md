<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabi-maintenance.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Long-term Rabi maintenance and self-repair

Route catalog child termination timeouts block configuration saves. A later save or receipt lookup rechecks closure with the original process owner. Replacement writes remain blocked until closure is confirmed, after which the current request may proceed. An aggregate task failure is not proof that its children exited; failed or uncertain saves are not automatically replayed.

Saving one Route validates only the delivery rules being written, so unrelated unmigrated Routes do not block the save. Preview and migrate the current persona's legacy delivery rules with `scripts/migrate-agent-delivery-targets.ts`; it preserves snapshots, checks original files, and derives explicit targets from the existing delivery settings.

> Status: an Agent maintenance workflow. Configure and read back the plan, task binding, and scheduled triggers in the current installation. This document is not evidence that all bugs are fixed or a daemon independent of Desktop.

## P0: available APIs, matching documentation, and safe hot patches

This is the highest long-term maintenance priority, ahead of new business features: support frequent changes while keeping existing APIs available.

- **API documentation is a deliverable**: every new or changed endpoint ships matching paths, methods, authentication, request/response schemas, errors, timeouts, idempotency and receipt-query contracts, plus a minimal example. Documentation access must not depend on memory consolidation, an online Agent, or other background work. Do not advertise undeployed endpoints as current capabilities.
- **Validate before activation**: source changes produce an immutable candidate with code/documentation version identities and pass focused tests and compatibility checks. Never overwrite running files with work-in-progress source. Prefer hot replacement for compatible modules, without restarting unrelated APIs, message connections, or tasks.
- **Own in-flight requests explicitly**: new requests enter the replacement while the old module completes its existing requests. Drain requests, subscriptions, and resources before disposal. Freeze uncertain writes with their original key and payload rather than replaying them. Shared storage retains a single writer; zero downtime does not authorize two unisolated business writers.
- **Keep the old service on failure**: candidate preparation, documentation checks, or startup failure must not withdraw the working version. Activation failures must support rollback. Reject hot patches that require incompatible storage changes, cannot drain safely, or change core lifecycle; use a coordinated controlled transition instead of calling a forced restart a hot update.
- **Verify under continuous requests**: exercise independent reads and controlled fixture writes before, during, and after updates, checking disconnects, timeouts, lost requests, duplicate commits, documentation/code versions, and old-resource disposal. A build, one health check, or a page refresh alone does not establish hot-patch readiness.

Current limits: backend source follows the [source hot-patch matrix](source-hot-patches_en.md); installed pages use [Web hot patches](web-hot-patches_en.md) with production builds, automatic markers and managed rollback. Compatible updates do not restart Manager; initial installation, backend or dependency changes require a full release.

## Stable entry point

The maintenance plan owns intake, recovery, regression verification, and code quality for Rabi itself. Discover the current Manager and read the plan's unique `taskBinding.sessionId + workspace`. Do not guess by task title or create a task for every check. Keep the long-term plan executing between maintenance cycles; close it only when the user cancels or explicitly replaces it.

Reports contain minimal evidence: time, version/generation, action and expected/actual results, endpoint and error category, reproduction steps, log location, original business plan/task, and attempted recovery. Exclude credentials and unrelated conversations. Deduplicate by module, failing call site, error/symptom, and target; append new evidence to the same issue.

Use the [Rabi interfaces](rabi-agent-interfaces_en.md): discover Manager through Host and verify `/meta`, then use the thread bridge to deliver Agent reports and scheduled work to the bound task. Agent-authored plan feedback is `record_only`, even with `notifyAgent=true`; use it to preserve evidence, not to wake the task. User-authored guidance may use `notifyAgent=true`. Do not send identical content twice. Check feedback/request receipts and task state before retrying uncertain delivery. The maintenance task handles its own findings directly instead of sending messages to itself.

If a bug already has a plan and task binding, forward evidence to that owner and follow progress. Handle small unowned issues serially in the maintenance task. Give larger independently verifiable issues their own plan, creating another task only when necessary and authorized. Never modify the same issue concurrently.

## Outage recovery

An independent Worker renews durable receipts for ordinary message delivery. Manager awaits heartbeat Worker startup and shutdown asynchronously, retaining the 10-second deadline for each handshake; waiting does not block HTTP health checks. Delivery still rechecks the original connection authority and receipt owner. An uncertain result requires reconciling the original delivery without automatic replay.

Use Rabi for managed delivery while it is healthy. Only current discovery and bounded retries establishing an outage allow the previously verified maintenance binding to receive reports through its existing Desktop owner. Follow the [delivery fallback contract](rabi-agent-interfaces_en.md); failure on an old port is not outage evidence. Do not switch channels while the original outcome is uncertain.

When plan writes are unavailable, retain a minimal pending report and actual fallback receipt, continue independent local diagnosis, and never directly edit persona plan/callback storage. After recovery, read actual state before reconciling; do not resend delivered content merely to obtain a formal receipt. Host owns installed lifecycle. Do not kill Manager, scan old ports, or start a second Runtime.

## Repair cycle

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
