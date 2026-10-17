English | [简体中文](workspace-plan-query.md)

# Workspace plan queries

`POST /api/roles/:roleId/plans/query` is read-only pagination using the same recursive keyword matching, status/tag filters and sorting as WebGUI. The body accepts `query`, `cursor`, `limit` (1–250), `view`, `sort`, `statuses` and `tags`.

Required `bindingScope` contains `agentType`, an absolute `workspace`, and host-verified `sessionIds`. A task or secretary binding must match all three. An empty identity list returns an empty page. Scope filtering precedes sorting, pagination, totals and facets. Multiple bindings never duplicate a plan. The caller supplies existing session identities; this endpoint does not query an Agent host.

The DSH Rabi plugin matches workspaces against routed personas, then reads summary pages per role in parallel. Button discovery reads no plans. Closing the dialog cancels reads and its event subscription. Rabi WebGUI owns on-demand plan details.

Resident plan-page owners use a bounded budget. When full, only a prepared owner with no subscribers and no unfinished queries may be evicted; a new role is admitted only after its predecessor's resources have actually stopped. Cancelling an HTTP wait does not settle the underlying query. Preparing or busy owners are never evicted. If every slot is busy, admission still reports capacity rather than deleting plans or increasing the process budget.

## Exact plan reads

Exact plan projections use bounded asynchronous identity reads and still detect duplicate logical IDs in active, archive, and noncanonical physical directories. Finding the first match never skips duplicate verification. Strong ETags derive from the complete storage-package inventory. Package contents reuse the bytes verified by that inventory rather than rereading files after hashing, preventing concurrent replacement from separating the response bytes from their hashes. The feedback summary parses the `feedback.jsonl` bytes already obtained by that same package read instead of acquiring a write lease or creating/reclaiming locks. Plan details and the persona workflow are read in parallel. Workflow reads use the asynchronous read-only entry point: GET never creates, migrates, or upgrades configuration, and a missing workflow fails explicitly. This optimization neither releases the startup recovery gate nor adjudicates historical conflicts. A shared-storage timeout remains a read failure, not an empty plan or successful recovery.

Detail and list presentation resolve old markers through the persona workflow's declared `legacyAliases`, preferring canonical `markerStatus`. Response marker keys and presentation remain consistent. This projection changes no plan bytes, history, or strong ETag; it does not treat activation state as a workflow marker or guess unknown states. Unconfigured markers still fail explicitly.

## Startup recovery exit boundary

An IPC recovery result remains provisional until the child exits. Readiness requires both success and a clean exit; failure results also wait for exit before retrying. Timeout cancellation must confirm termination. If termination fails, retain the process owner and PID, keep the gate closed, and never start overlapping recovery. Stop shares an in-flight cancellation and cannot report stopped without confirmed exit. This boundary neither adjudicates storage conflicts nor admits unrecovered plan writes.

## Status-driven advancement

`GET/PUT /api/roles/:roleId/plan-advance/settings` stores status rules per persona and workspace. `POST .../check` returns candidates, blocking reasons, fingerprints, and the effective prompt without dispatching. `POST .../run` requires the checked fingerprints and rechecks plans, approval, the original bound session, and idle state before reserving dispatch receipts. Automation defaults off; prompts come from persona status configuration. Receipts durably deduplicate each workspace and plan, and uncertain outcomes stop automatic retries. Dispatch uses the formal Agent thread bridge. DSH uses `queue` so a new turn starting after the idle check is not interrupted; the original session is instructed to reread the plan before acting. The host supplies verified workspace `sessionIds`; Rabi never guesses sessions from titles.

The check response's `total` counts plans in the workspace that match enabled status rules. It supports search progress; it is not the number eligible for dispatch. Each item's `eligible` field and the dispatch-time recheck remain authoritative.

Each check reads the complete DSH session catalog once per host, and dispatch reads one fresh status snapshot for its session groups. It does not scan the entire catalog once per plan. DSH status reads have a 10-second limit; a timeout or unreachable host still blocks dispatch. If a new turn starts after the snapshot, queue delivery waits for that turn to finish.

The dispatched message includes the editable prompt for that status, its name and description from the persona workflow, the plan and current-step identity, and the inspect-only or continue-authorized-work constraint. The agent must reread the plan and feedback. The status description explains the phase without expanding authorization, and checking does not directly change plan status. The persona workflow owns status descriptions; workspace advancement settings store only prompts and trigger rules.
