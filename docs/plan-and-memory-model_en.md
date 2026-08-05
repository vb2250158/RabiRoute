<!-- docs-language-switch -->
<div align="center">
English | <a href="./plan-and-memory-model.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Plans and Memory Model

> Status: current guide. Checked against `src/roleKnowledge.ts`, the Manager API, and tests. Implemented behavior and future work are separated explicitly.

RabiRoute remains a message gateway and Policy Router. Plans, memories, and role skills are handler-maintained context for routing and execution; they do not turn RabiRoute into an Agent OS, project manager, or autonomous planner.

## Storage model

Role knowledge is stored under:

```text
data/roles/<RoleId>/
  personaConfig.json
  persona.md
  growth.md
  skills.md
  skills/*.md
  plans/items/active/*.json
  plans/archive/*.json
  plans/attachments/<planId>/*
  plans/feedback/*.jsonl
  memory/recent/*.json
  memory/consolidated/*.json
  memory/consolidation-runs/*.json
```

The filesystem is the source of truth. The Manager API reads and writes these files. Qt and WebGUI keep plan content read-only; approval feedback stays on Manager-declared approval steps, while RibiWebGUI also accepts whole-plan guidance for running plans outside approval.

## Plans

Plan status is one of:

```text
`未开始`  not started
`进行中`  in progress
`暂停`    paused
`已完成`  completed
`已归档`  archived
```

`暂停` is a real top-level plan state for an explicit temporary stop. A step that needs approval, plan confirmation, or authorization remains in progress and carries a complete `approvalRequest` plus `waitingFor`. When the contract is complete, actionable, and has `responseStatus=pending`, Manager derives the blocked state automatically. QA, missing materials, execution failures, and external artifacts stay actionable through inquiry, retry, rerouting, decomposition, or evidence gathering.

A plan describes one focused objective. Common fields:

```json
{
  "id": "plan-example",
  "title": "Refresh the routing guide",
  "focus": "routing documentation accuracy",
  "status": "进行中",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "verify-schema",
  "currentStep": "verify schema and tests",
  "nextAction": "update both language versions",
  "waitingFor": "",
  "blockedBy": "",
  "attachments": [
    {
      "id": "attachment-preview",
      "kind": "image",
      "name": "plan-preview.png",
      "path": "C:/Path/To/data/roles/Role/plans/attachments/plan-id/attachment-preview-plan-preview.png",
      "size": 2048,
      "mimeType": "image/png",
      "sha256": "<sha256>"
    }
  ],
  "steps": [
    {
      "id": "inspect-current",
      "title": "Inspect the current model and UI",
      "status": "已完成",
      "startedAt": "2026-07-16T00:00:00.000Z",
      "completedAt": "2026-07-16T00:10:00.000Z"
    },
    {
      "id": "verify-schema",
      "title": "Verify the structured step contract",
      "status": "进行中",
      "startedAt": "2026-07-16T00:10:00.000Z",
      "approvalRequest": {
        "approver": "Project owner",
        "request": "Approve updating the plan contract with the listed files and commands.",
        "recommendation": "Approve the smallest Schema, Manager DTO, dual-client UI, and documentation change.",
        "alternatives": ["Request a smaller scope and resubmit", "Reject and keep the current behavior"],
        "reason": "This changes the public Plan schema and both user interfaces.",
        "files": [
          { "path": "src/roleKnowledge.ts", "action": "modify", "change": "Add approval-contract schema, normalization, and write validation." },
          { "path": "ribiwebgui/src/pages/RoleKnowledgePage.vue", "action": "modify", "change": "Render the contract and missing-field guidance while still accepting user approval feedback." }
        ],
        "commands": [
          { "command": "npm run build:backend", "purpose": "Compile and validate the Manager backend.", "expectedEffect": "Produces local dist build output only." }
        ],
        "changes": [],
        "validation": ["Node targeted tests, tray tests, and the WebGUI build all pass."],
        "rollback": ["If validation fails, revert only the source and documentation listed in this contract."],
        "outOfScope": ["No commit, push, or runtime data/ changes."],
        "requestedAt": "2026-07-16T00:10:00.000Z",
        "sourceMessageId": "example-message-id",
        "responseStatus": "pending"
      }
    },
    { "id": "update-readers", "title": "Update APIs, readers, and docs", "status": "未开始" }
  ],
  "project": {
    "name": "RabiRoute",
    "path": "C:/Path/To/RabiRoute"
  },
  "source": {
    "kind": "agent",
    "summary": "Created during a documentation audit"
  },
  "taskBinding": {
    "agentType": "codex",
    "sessionId": "exact-source-session-id",
    "sessionTitle": "Plan execution task",
    "workspace": "C:/Path/To/Project",
    "completionHook": {
      "enabled": true,
      "gatewayId": "Role__reminder"
    }
  },
  "keywords": ["routing", "documentation", "schema"],
  "createdAt": "2026-07-16T00:00:00.000Z",
  "updatedAt": "2026-07-16T00:00:00.000Z"
}
```

`steps` is the ordered execution path. Every new plan must list all of its steps, with at most one step in `进行中`. Top-level `currentStepId` must point to that step so both the UI and Agents can answer exactly where execution is. A paused plan must keep exactly one in-progress resume step and `currentStepId` must point to it. A missing pointer, a pointer to another step, zero in-progress steps, or multiple in-progress steps is rejected consistently by Manager writes, work-cycle finish preflight, and strict audit. Resuming changes only the top-level status back to `进行中`; it does not rebuild the steps or rewrite the resume point. A step may include `detail`, `waitingFor`, `blockedBy`, `startedAt`, `completedAt`, and `approvalRequest`. `waitingFor` names who or what the Agent must ask or follow up with. Ordinary waits, failures, and missing resources remain actionable; every inspection chooses inquiry, escalation, retry, rerouting, decomposition, an alternative, or evidence gathering. Only a complete actionable current approval contract with `responseStatus=pending` is blocked. `isBlocked` remains a compatibility projection written by Manager for older clients; it is not an Agent input or the source of truth. `blockedBy` is human-readable context only and cannot create a blocked state. Manager fills `startedAt` when a step is first written as `进行中`, then fills `completedAt` while preserving the start time when it becomes `已完成`. Reopening a completed step clears its stale `completedAt`; resetting it to `未开始` clears both timestamps. A step created directly as completed, or a legacy step missing timestamps, is backfilled with the next plan-write time, which cannot reconstruct older history. RibiWebGUI shows only the start time for an in-progress step, only the completion time for a completed step, and no time for a not-started step. `currentStep` remains a progress note; it no longer acts as the step list, step identity, or phase classifier. Because structured steps already express the future path, the UI does not repeat `nextAction`; Agents and legacy plans may still use that field, but it also does not classify the phase.

`attachments` is the optional plan-level attachment list. For a new attachment, an Agent may provide a local `path`, or `name`, optional `mimeType`, and `contentBase64` in POST/PATCH. Manager validates and copies the content into the persona-private `plans/attachments/<planId>/` directory. Plan JSON stores only `id/kind/name/path/size/mimeType/sha256` metadata and never stores Base64. A plan may contain up to 8 attachments, limited to 10 MiB each and 25 MiB in total. Omitting `attachments` from PATCH preserves the current list; sending `attachments: []` clears the list from the plan record.

WebGUI never reads the stored local path directly. It requests files through `GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId`. PNG, JPEG, WebP, and GIF images; MP4/M4V, WebM, Ogg Video, and MOV/QuickTime videos; and Markdown files all render in compact, fixed-width 16:9 preview cards that shrink only when their container is narrower. A Markdown card streams at most the first 12 KiB of source, turns it into a plain-text excerpt capped at 180 characters, and clamps the visible lines without executing HTML, links, or images; clicking it opens the complete document dialog. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Video responses support byte ranges; actual playback codecs still depend on the current browser. Markdown files up to 2 MiB render GFM headings, lists, tables, blockquotes, and code in-page; raw HTML, dangerous or relative links, and remote image loading are disabled, while the dialog retains a source-download action. Other files show name, type, and size and open or download through the attachment response. The read boundary rechecks that the real path remains inside that plan's managed directory, failing closed on traversal or symlink escape.

A current step that requires approval should include a complete `approvalRequest`. `approver`, `request`, `recommendation`, `alternatives`, and `reason` state the owner, decision, preferred and fallback choices, and rationale. `files` lists exact paths, `create/modify/delete/move`, and the concrete edit; `commands` contains complete commands, purpose, and expected effects; `changes` identifies configuration, database, cloud, or external-system targets. `validation`, `rollback`, and `outOfScope` define acceptance, recovery, and explicit exclusions. `requestedAt`, `sourceMessageId / feedbackId`, and `responseStatus` record request provenance and receipt state. At least one of `files / commands / changes` must be concrete. Missing fields produce `presentation.approval.state=incomplete` and `enabled=false`, while the plan stays in progress for the Agent to investigate and repair. Once the contract is complete with `responseStatus=pending`, Manager returns `ready/enabled=true`, the internal `blocked` tone, and the user-facing stage `Awaiting approval` from the same gate.

Existing runtime plans need no bulk migration. Manager normalizes the gate at the read boundary: legacy `isBlocked=true` values without a complete pending approval contract are downgraded to running and cleaned on the next canonical POST/PATCH, while `blockedBy` remains available as context. The system never invents an approver, provenance, recommendation, alternatives, or request time; the Agent must fill those fields from real messages and investigation evidence.

`taskBinding` is the optional exact plan-to-execution-session binding. The current implementation supports only `agentType=codex`. `sessionId` is the required complete execution-task ID; `sessionTitle` is display metadata and `workspace` is a Stop-Hook safety check. With `completionHook.enabled=true`, Manager forwards the official final answer through the existing role-panel path to the same persona's Route after that session finishes a turn. `gatewayId` disambiguates multiple Routes. Delivery is deduplicated by `sessionId + turnId` and records a stage-completion fact only; it does not advance steps, change plan status, or write memory automatically. A top-level paused plan receives no completion reminder, so the binding is not re-driven while paused.

`taskBinding` identifies the plan's independent business-execution task; it never points to a persistent plan secretary. Secretaries are control-plane workers: they maintain plans and memory, resolve and deduplicate business tasks, inspect real status, consume results, and continue the bound task. Investigation, implementation, testing, Unity/SVN/build/release work, and external-system changes belong to the business task. A secretary may create temporary child agents only for plan inventory, deduplication, status checks, and result summaries; neither the secretary nor those children modify business files.

After a business-task completion reminder, the main-persona Agent must, in the same turn, assign a plan secretary to consume the result, PATCH the plan and memory, and continue the exact business `taskBinding.sessionId + workspace` when the plan remains actionable. Pausing a plan or rotating a secretary never clears the business binding. Rebinding is allowed only after the business task is genuinely unavailable and a controlled migration has completed; completed plans may retain the binding as historical evidence. Completion callbacks, heartbeats, and resume inspections should use all available secretary slots across management shards and end only when both `actionable plans without management = 0` and `actionable but idle business tasks = 0`. Already active business tasks are not sent duplicate turns. Authorized inquiry and evidence gathering continue without bypassing action gates.

Plan-management writes are isolated by `planId`: one control-plane writer per plan, with different plans allowed to proceed concurrently. Shared ledgers, issue mappings, and delivery receipts are read at the latest version inside short file locks, merged only at the target record, and atomically replaced; a stale whole-file snapshot must never overwrite another plan. Lock metadata is fully written to a candidate and atomically published with a same-volume hard link. The hot path never deletes a stale or corrupt lock automatically: it fails closed, and repair is allowed only during an explicitly quiescent maintenance window with writers paused. `claim` and `clarify` use a separate lease keyed by source message and stable operation key, persisting a reservation before delivery. An uncertain send or a sent-but-unverified result remains `uncertain` / `sent_unverified` and is never resent automatically.

A fresh `work-cycle begin` reads the plan and recent memory before it creates the bound task's history snapshot or persists a cycle. Idempotent Manager GETs use bounded retries with a per-attempt timeout; POST, PATCH, and other potentially side-effecting requests are never replayed automatically. If recent-memory reads still fail after retry exhaustion, begin releases the plan lease and leaves neither a started cycle nor a history snapshot for that attempt. The error remains visible to the secretary; a later direct GET success does not retroactively complete the failed begin.

Global strict audit is observational and compares ledger snapshots from before and after validation. Only a cycle whose identity stayed stable can become `invalid`; a cycle that appeared, disappeared, or changed during the audit is `incomplete`. Active cycles or plan leases make `quiescent=false` but do not block unrelated plans. Plan closure uses plan-scoped strict audit, while global quiescence is reserved for explicit maintenance or final drain. Thread-status reconciliation likewise skips only active plans and continues the rest.

The target Codex Route must already have an exact task ID and must differ from the execution session. Multiple plans bound to one execution session, workspace mismatch, execution-context persona mismatch, a missing or wrong-persona gateway, or multiple same-persona gateways without `gatewayId` all fail closed. The capability remains experimental until verified between two real Desktop tasks.

Completed plans remain visible for confirmation. A role-knowledge snapshot archives them when the latest `updatedAt` is more than the current fixed 72-hour window old. It sets `archivedAt` and moves the file to `plans/archive/`.

`completedArchiveAfterHours` is not currently a public `personaConfig.json` field. Do not present it as user-configurable yet.

## Focus and write limits

Every plan and memory must have a single-line `focus` describing one subject. Independent subjects belong in separate items.

Default plan limits:

```text
titleChars=80
focusChars=80
currentStepChars=1200
stepTitleChars=120
stepDetailChars=600
stepWaitingForChars=300
stepBlockedByChars=300
approvalRequestChars=600
approvalReasonChars=600
approvalPathChars=1000
approvalDetailChars=800
approvalCommandChars=2000
approvalListItemChars=800
maxSteps=100
nextActionChars=600
waitingForChars=300
blockedByChars=600
sourceSummaryChars=240
keywordChars=32
maxKeywords=24
totalChars=12000
```

Default memory limits:

```text
titleChars=80
focusChars=80
contentChars=4000
sourceSummaryChars=240
keywordChars=32
maxKeywords=24
totalChars=4600
```

Override these limits under:

```json
{
  "knowledgeLimits": {
    "plan": {
      "totalChars": 3200
    },
    "memory": {
      "contentChars": 5000
    }
  }
}
```

Invalid writes fail with HTTP 400; RabiRoute does not silently truncate them. Validate all existing files with:

```http
GET /api/roles/:roleId/knowledge-validation
```

## Recent memory

Recent memory stores a focused fact, preference, conclusion, or unresolved question that is still editable or waiting to be consolidated.

```json
{
  "id": "memory-example",
  "title": "Documentation follows implementation",
  "focus": "documentation fact-source rule",
  "content": "Check code, schemas, APIs, WebGUI, and tests before maintaining the English version.",
  "keywords": ["documentation", "fact source", "tests"],
  "source": {
    "kind": "agent",
    "summary": "Confirmed during the audit"
  },
  "createdAt": "2026-07-16T00:00:00.000Z",
  "updatedAt": "2026-07-16T00:00:00.000Z"
}
```

`keywords` is required. RabiRoute's hot-path recall matches IDs, titles, and keywords rather than tokenizing every body.

Memory activity uses the later of `updatedAt` and `viewedAt`:

- Reading a recent or consolidated memory by ID refreshes `viewedAt`.
- Updating recent memory refreshes both `updatedAt` and `viewedAt`.
- A recall match placed in required reads refreshes `viewedAt`.

## Current memory windows

```text
recentEditableHours = 24
recentConsolidationHours = 72
```

These are fixed defaults in the current implementation, not public persona configuration fields.

- Recent memories active within 24 hours are listed directly in the packet.
- Older unconsolidated memories are normally omitted but can still be recalled by ID, title, or keyword.
- An explicit consolidation request is due when an unconsolidated recent memory has been inactive for more than 72 hours.
- Consolidation input includes unconsolidated memories inactive for more than 24 hours.

The Manager API can override the two thresholds for one consolidation request.

## Consolidated memory

Consolidated memory is a stable record produced from one or more recent memories. It stores `inputMemoryIds` and `consolidationRunId` for traceability. Existing consolidated memories have no ordinary update endpoint.

If a consolidated fact is wrong, create a corrective recent memory. A later run can produce a new stable item without mutating history in place.

## Explicit consolidation flow

Current entry points:

1. The built-in `manual_trigger` with `triggerId=memory-consolidation`.
2. `POST /api/roles/:roleId/memory/consolidation-requests`.

```json
{
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

When due, RabiRoute creates a run under `memory/consolidation-runs/` and supplies the eligible recent memories to the handler. `force=true` skips the due check but does not include items still inside the editable window.

Time passing alone does not start a resident background job. Automatic scheduling remains future work.

The handler returns:

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "Stable documentation rule",
      "focus": "documentation fact-source rule",
      "content": "Public documentation is calibrated before its English version is maintained.",
      "keywords": ["documentation", "fact source"]
    }
  ]
}
```

to:

```http
POST /api/roles/:roleId/memory/consolidation-runs/:runId/result
```

RabiRoute writes the consolidated output, completes the run, and marks each input recent memory with `consolidatedAt` and `consolidationRunId`.

## Recall and packet injection

The packet includes lightweight indexes rather than full bodies:

- active plans;
- recent memories inside the active window;
- active role skills;
- matched knowledge and skills;
- a required-read list, normally up to five items, with GET endpoints.

Candidates include non-archived plans (`未开始`, `进行中`, `暂停`, and `已完成`), unconsolidated recent memories, consolidated memories, and non-archived role skills. Only `进行中` plans enter the default active-plan index; paused plans remain searchable but are not treated as active. Active plans and active recent memories receive only a small ranking bonus. A candidate must still match the current message to enter required reads.

The handler must read required items before replying, changing role knowledge, delegating work, or taking an external action.

## Manager API

```http
GET   /api/roles/:roleId/plans
GET   /api/roles/:roleId/plans/:planId
POST  /api/roles/:roleId/plans
PATCH /api/roles/:roleId/plans/:planId
GET   /api/roles/:roleId/plans/:planId/feedback
POST  /api/roles/:roleId/plans/:planId/feedback

GET   /api/roles/:roleId/memory
GET   /api/roles/:roleId/memory/recent
GET   /api/roles/:roleId/memory/recent/:memoryId
POST  /api/roles/:roleId/memory/recent
PATCH /api/roles/:roleId/memory/recent/:memoryId

GET   /api/roles/:roleId/memory/consolidated
GET   /api/roles/:roleId/memory/consolidated/:memoryId
GET   /api/roles/:roleId/memory/consolidation-runs
GET   /api/roles/:roleId/memory/consolidation-runs/:runId
POST  /api/roles/:roleId/memory/consolidation-requests
POST  /api/roles/:roleId/memory/consolidation-runs/:runId/result
```

Both `/roles/...` and `/api/roles/...` prefixes are accepted. Public documentation prefers `/api/roles/...`.

Long plan lists can call `GET /api/roles/:roleId/plans?limit=8&cursor=<offset>&detail=summary` for lightweight cursor pages, then fetch body text, steps, approvals, and attachment metadata by ID through `GET /api/roles/:roleId/plans/:planId`. WebGUI reads eight summaries for the first screen and uses larger background pages for the remaining directory, reducing repeated list queries. The content area mounts a bounded window and appends forward while scrolling. Directory navigation moves that window to the selected plan, so it neither creates every preceding body nor inserts older cards above the current reading position later. WebGUI moves near-viewport details to the front of its bounded queue and yields one rendering frame before consuming another summary page without waiting for detail requests. Only cards with a real request in flight show the loading animation; off-screen cards use a compact pending state plus browser `content-visibility`, avoiding dozens of simultaneous Vuetify skeletons on the main thread. Manager uses a two-level incremental list cache: directory watchers coalesce short bursts of file-write events, while per-file `size + mtimeMs` entries asynchronously reread and normalize only the plan JSON files that changed. Summary requests keep serving the previous complete snapshot while disk I/O is in flight. Canonical POST/PATCH writes update the exact cache entries directly and remain immediately visible. Filesystems without watcher support fall back to a short-TTL validation path. These entries are derived read caches only; plan files remain the sole source of truth.

## Plan guidance and approval feedback

Plan feedback is an independent JSONL audit record stored under `plans/feedback/<planId>.jsonl`. `kind=guidance` is plan-level guidance associated only with `planId` and must not carry `stepId`; `kind=approval_suggestion` is formal feedback associated with an approval step. Neither is a second copy of the plan JSON or the generic Outbox Action Queue.

The read endpoint returns complete `records` after collapsing delivery-state updates for the same `feedbackId`. RibiWebGUI loads them on demand when a guidable plan or approval step is expanded, and presents plan-guidance history separately from approval history. `latest` remains only a lightweight summary and delivery-state signal.

RibiWebGUI submits plan guidance with `kind=guidance`, `author=user`, `source=webgui`, and `notifyAgent=true`, without `stepId`; Manager accepts it only for running plans that are not currently in an approval step. WebGUI and tray approval submissions continue to use `kind=approval_suggestion`, `author=user`, `source=webgui|tray`, and `notifyAgent=true`. Approval input retains file, clipboard-image, and `@` plan-attachment support. Both feedback types are durably recorded before returning `deliveryStatus=pending`, then reuse the same exact `taskBinding` delivery chain: a complete binding goes through `/api/agent/threads` and Desktop IPC to the original business task, while only an incomplete binding sends the full feedback to the persona Agent. Retry, terminal status, and `plan_feedback_changed` semantics remain shared.

After receiving `guidance`, the Agent first reads the current plan and feedback, treats the guidance as whole-plan direction, and explicitly `PATCH`es the plan plus any not-started steps affected by changed scope, priority, method, or path. It then writes `kind=guidance_response`, `author=agent`, and `notifyAgent=false` under the same `planId` without `stepId`. Approval feedback still updates the affected plan/step and approval receipt before writing `approval_response` under the same `planId / stepId`. Neither record advances a plan automatically.

While background delivery is pending, WebGUI keeps the next draft editable but prevents another submission until the prior feedback reaches a terminal state. Plan guidance appears only for running plans outside approval; approval plans continue to expose only the approval contract and approval input inside the owning step.

## Manager presentation order and plan views

Manager uses the current step's `approvalRequest` as the only approval-gate source of truth. A complete actionable contract with `responseStatus=pending` simultaneously produces `presentation.approval.state=ready`, `enabled=true`, the internal `blocked` tone, and `Awaiting approval`, so every approval wait has an actionable entry. An incomplete contract produces `incomplete` while the plan remains in progress for Agent investigation and repair. Legacy `isBlocked` is only a compatibility projection, and `blockedBy` is explanatory text; neither independently creates a display stage.

For a running plan, Manager derives the real presentation stage in one place. A structured current `qa-* / verify-*` step becomes `Awaiting QA acceptance`. A structured package/build step becomes blue `Awaiting unified package` only after all prior work is complete and authoritative `waitingFor` explicitly names bundling, building, package inclusion, target identity, or the user starting a build. Remaining authoritative waits are classified as `Awaiting environment`, `Awaiting assets`, `Awaiting information`, or `Awaiting external response`; work with no real wait becomes `Executing`. QA prose in an implementation step, stale `blockedBy`, future steps, and ordinary notes do not create a stage. The top-level `status` remains only the five-value lifecycle field.

The refined rules show `Waiting for test environment` only for a real runner, MCP service, device, or listener outage with no CLI, fallback-validation, or retry path. An explicit prohibition on Unity GUI, MCP, menus, or PlayMode becomes `Waiting for renewed authorization`. A structured QA step also needs a real receipt for the current send and no remaining action except the verdict; otherwise a repairable send stays `Executing`. Target-package identity and inclusion evidence remain `waiting_package`, while assets, documents, and owner replies remain distinct external waits.

Presentation treats only explicit action sentences in `nextAction` and the current step title as current alternatives. Historical completion evidence in `currentStep` or step `detail`, such as “runtime screenshots sent,” “tests completed,” or “do not resend,” cannot turn a result-only wait back into `Executing`. A still-pending instruction such as “run the CLI check and send the review request” remains executable.

The `implementation/development validation → Awaiting unified package → Awaiting QA acceptance → complete on QA pass; return to investigation and implementation on QA failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real steps and `waitingFor`; producers must not manufacture package or `qa-* / verify-*` steps merely to fit that lifecycle. Manager presents the structured current step and does not infer or force the lifecycle from a title, prose, or `kind`.

`presentation` exposes `status`, `tone`, `sortBucket`, the shared palette, and approval details. Cursor summaries also expose `counts.stages` for `executing / qa / waitingPackage / waitingExternal / approval / pending / paused / completed / archived`. Except for paused plans, ready approvals sort first, incomplete contracts second, then `Awaiting approval → Awaiting QA acceptance → Executing → external waits → Awaiting unified package → Not started → Completed → Archived` and newest `updatedAt`; paused plans remain last.

The secretary's `reconcile-thread-statuses` command consumes this same Manager `presentation` and cross-checks it against structured delivery and environment evidence in the issue ledger and latest completed cycle. Terminal and complete approval waits become `terminal / blocked`; paused plans become `frozen + paused` with `implementationDispatchAllowed=false`; `waiting_package` and exclusive-environment waits backed by current `waiting_environment* + environment-owner` evidence also become `frozen`, unless an authoritative release for the same PID/project supersedes that owner evidence. A structured dependency step or tracking state becomes `frozen_until_dependencies` only when it explicitly waits for other plans' original owners to finish and the plan, issue, and cycle evidence also says that no independent CLI, control-plane, or business action remains. Contacting or coordinating owners, completing a missing contract, obtaining a reply, or retaining a CLI, retry, or fallback path keeps the plan `actionable`. A QA or ordinary inquiry with a real `status=sent / sentMessageId` receipt becomes stable `waiting_result` when issue/cycle evidence explicitly says that only the result remains, no independent local action exists, no separate review or confirmation request is still unsent or unresolved, and resending is forbidden. An older QA receipt cannot cover a later owner review or placement confirmation. That receipt may come from structured issue evidence or the latest cycle summaries and is not invalidated by later plan updates or the ordinary deduplication window. A merely recent ordinary send still uses `waiting_result_dedup`. Only idle plans with remaining local work, missing real delivery/receipt, an explicitly due follow-up, a separate pending inquiry, a retry, or an alternative path remain `actionable`; a delivered inquiry does not get repeated merely because local work remains. The result exposes separate `frozenIdle`, `waitingResultIdle`, and `actionableIdle` collections. `implementationDispatchAllowed` is true only while implementation work may still run; terminal, paused, approval-blocked, package, cross-plan-dependency, test-environment, renewed-authorization, and QA-verdict waits return false because no implementation action remains.

For the refined states, `waiting_package` returns `frozen_until_package + wait_for_target_package`; a cross-plan dependency with no independent action returns `frozen_until_dependencies` with `requiredAction=null`; a real test-infrastructure wait returns `frozen_until_test_environment + wait_for_test_environment`; renewed authorization returns `waiting_for_authorization + request_authorization`. These waits set `implementationDispatchAllowed=false`. A sent QA request that only awaits a verdict returns `waiting_result + wait_for_qa_result` and also forbids implementation dispatch. A missing QA receipt with a repairable send path remains `actionable + send_qa_request`. Available CLI or fallback validation remains actionable, while ordinary missing external information continues to use `inquire_until_result`.

The Qt tray and RibiWebGUI both consume this Manager DTO, stage summary, view membership, palette, and order. Their shared knowledge categories are `Current / Plans / Recent Memory / Archived`: Current combines in-progress plans with recent memory, paused plans remain only under Plans, and Archived combines archived plans with consolidated memory. Neither client reads `data/` directly nor owns a separate state-recognition, category, status-color, or ordering table. If `presentation` is absent, clients show neutral `Status unknown` instead of inferring a real stage from lifecycle fields.

Both the Qt tray and RibiWebGUI's Plans & Memory page consume this Manager DTO and its existing order. Neither reads `data/` directly nor maintains a separate status or sorting implementation. RibiWebGUI shows a non-duplicate `focus` below the plan title and nests the approval contract inside the step card identified by `presentation.approval.stepId`. Search examines all content values returned for a plan or memory, including steps, current actions, waiting/blocking details, approval contracts, attachment metadata, memory bodies, and source summaries, instead of limiting matches to title, focus, and keywords. Its page-level directory floats outside the plan panel, stays sticky, and scrolls within the viewport; it contains only the plans visible under the current tab and search query, while plan cards remain in normal page flow.

## Qt tray view

The Qt panel displays current plans, recent memory, consolidated memory, and diagnostics. It does not create, complete, archive, delete, normalize, or migrate plan/memory content. Approval-enabled plan cards may append formal feedback through Manager without changing the plan itself. Incomplete approval contracts keep approval input disabled in both clients; RibiWebGUI's whole-plan guidance appears only when the plan is outside approval.

## Boundary

RabiRoute does not convert raw chat logs into memory automatically and does not decide what the handler should remember. The handler creates focused plans and recent memories. RabiRoute provides storage, indexing, validation, recall side effects, explicit consolidation runs, plan-content/memory views, and constrained plan-guidance and approval-feedback entries.
