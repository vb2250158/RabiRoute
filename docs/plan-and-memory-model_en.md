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
  plans/active/<planId>/
    plan.json
    history.jsonl
    feedback.jsonl
    attachments/
    feedback-attachments/<feedbackId>/
  plans/archive/<planId>/
    plan.json
    history.jsonl
    feedback.jsonl
    attachments/
    feedback-attachments/<feedbackId>/
  memory/recent/*.md
  memory/consolidated/*.md
  memory/consolidation-runs/*.json
  identity-relations/events.jsonl
```

The filesystem is the source of truth. The Manager API reads and writes these files. Qt and WebGUI keep plan content read-only; approval feedback stays on Manager-declared approval steps, while RibiWebGUI also accepts whole-plan guidance for running plans outside approval.

`plan.json` is the sole business source of truth for the current plan state, and Manager creates, updates, and archives it only through the plan-storage Repository. Legacy-layout migration, incomplete-transaction recovery, and canonical-directory reconciliation determine plan-storage read/mutation eligibility, with every attempt running in a terminable one-shot child. Manager endpoint and identity, the complete required-plugin set, and handler READY do not wait for NAS recovery, so Host and Tray remain on the current application generation. While eligibility is `running` or `degraded`, existing read-only endpoints remain available, plan mutations fail closed, and `/health` reports the degradation explicitly. Once eligibility is ready, runtime modules use only the recovered canonical layout and neither scan nor read the legacy layout. Migration never reads attachment bodies. When legacy and canonical content are identical, a manifest-and-receipt transaction retires the duplicate; divergent content is preserved as evidence and fails plan mutation closed. Moving a plan from `active/` to `archive/` is likewise one lease-owned Repository lifecycle transaction, not a bare `rename` or background migration.

### Identity-relation memory

Identity-relation memory has the `identity_relation` knowledge type. It is persona-private material alongside plans and recent memory, but it never enters the 24/72-hour recent-memory consolidation flow. It stores endpoint accounts, participant entities, and relation cards as append-only events:

```text
data/roles/<RoleId>/identity-relations/events.jsonl
```

An account key is exactly `platform + endpointIdentityNamespace + senderStableId`. Route configuration IDs, display names, avatars, and the current topic are not identity keys. One account may have candidate or confirmed participant mappings, while one participant may have multiple accounts. A relation card records collaboration, reporting, or decision scope between people, organizations, and projects, with `candidate`, `confirmed`, `corrected`, or `retired` state, group/project scope, and minimal evidence references.

This data resolves participants only. It must not turn platform privileges, a temporary speaking role, or one discussion into business authority. Candidate relations cannot support naming, authorization, project attribution, or execution. Delivery places project relation cards that apply to the current conversation into the Situation record, but that means only that the Agent may participate in the discussion; it never grants management of that project's plans, tasks, or long-term memory. Multi-PC synchronization unions events; when concurrent heads for one record disagree, the current view explicitly marks a conflict and stops automatic confirmation instead of choosing one by file order. One persona correction containing every material field supersedes all current heads and lets later synchronization converge. A handler confirms or corrects identity relations explicitly through the API; identity context on a delivery does not require a plan/memory callback.

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
  "importance": 2,
  "urgency": 2,
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
      "path": "C:/Path/To/data/roles/Role/plans/active/plan-id/attachments/attachment-preview-plan-preview.png",
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
  "secretaryBinding": {
    "agentType": "codex",
    "sessionId": "exact-secretary-session-id",
    "sessionTitle": "Primary Persona 协助处理计划1",
    "workspace": "C:/Path/To/RabiRoute",
    "assignedAt": "2026-06-08T00:00:00+08:00"
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

`attachments` is the optional plan-level attachment list. For a new attachment, an Agent may provide a local `path`, or `name`, optional `mimeType`, and `contentBase64` in POST/PATCH. Manager validates and copies the content into that plan directory: `plans/active/<planId>/attachments/`. Plan JSON stores only `id/kind/name/path/size/mimeType/sha256` metadata and never stores Base64. A plan may contain up to 8 attachments, limited to 10 MiB each and 25 MiB in total. Omitting `attachments` from PATCH preserves the current list; sending `attachments: []` clears the list from the plan record.

WebGUI never reads the stored local path directly. It requests files through `GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId`. PNG, JPEG, WebP, and GIF images; MP4/M4V, WebM, Ogg Video, and MOV/QuickTime videos; and Markdown files all render in compact, fixed-width 16:9 preview cards that shrink only when their container is narrower. A Markdown card streams at most the first 12 KiB of source, turns it into a plain-text excerpt capped at 180 characters, and clamps the visible lines without executing HTML, links, or images; clicking it opens the complete document dialog. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Video responses support byte ranges; actual playback codecs still depend on the current browser. Markdown files up to 2 MiB render GFM headings, lists, tables, blockquotes, and code in-page; raw HTML, dangerous or relative links, and remote image loading are disabled, while the dialog retains a source-download action. Other files show name, type, and size and open or download through the attachment response. The read boundary rechecks that the real path remains inside that plan's managed directory, failing closed on traversal or symlink escape.

A current step that requires approval should include a complete `approvalRequest`. `approver`, `request`, `recommendation`, `alternatives`, and `reason` state the owner, decision, preferred and fallback choices, and rationale. `files` lists exact paths, `create/modify/delete/move`, and the concrete edit; `commands` contains complete commands, purpose, and expected effects; `changes` identifies configuration, database, cloud, or external-system targets. `validation`, `rollback`, and `outOfScope` define acceptance, recovery, and explicit exclusions. `requestedAt`, `sourceMessageId / feedbackId`, and `responseStatus` record request provenance and receipt state. At least one of `files / commands / changes` must be concrete. Missing fields produce `presentation.approval.state=incomplete` and `enabled=false`, while the plan stays in progress for the Agent to investigate and repair. Once the contract is complete with `responseStatus=pending`, Manager returns `ready/enabled=true`, the internal `blocked` tone, and the user-facing stage `Awaiting approval` from the same gate.

Existing runtime plans need no bulk migration. Manager normalizes the gate at the read boundary: legacy `isBlocked=true` values without a complete pending approval contract are downgraded to running and cleaned on the next canonical POST/PATCH, while `blockedBy` remains available as context. The system never invents an approver, provenance, recommendation, alternatives, or request time; the Agent must fill those fields from real messages and investigation evidence.

`secretaryBinding` is the plan's exact current control-plane owner and is separate from the business `taskBinding`. It stores the bound Agent type, complete session ID, display name, workspace, optional DSH apiproxy origin, and assignment time. When control delivery first needs an owner, Manager selects one stable session from the enabled Route pool and persists it. A governance `begin/finish` updates the binding to the Secretary actually managing that plan. A still-configured binding is reused; reassignment happens only after the binding becomes unavailable or leaves the configured pool.

`taskBinding` is the optional exact plan-to-execution-session binding. `agentType` determines the session owner: `codex` uses a Codex Desktop task and `dsh` uses a DSH session. `sessionId` is the required complete ID; `sessionTitle` is display metadata; `workspace` is a safety check; and a DSH binding may store `baseUrl` for its actual apiproxy. `completionHook.enabled=true` applies only to Codex completion callbacks: Manager handles the official final answer after that task finishes a turn; when a Plan Secretary is enabled and bound it delivers directly to `secretaryBinding` without writing the Primary Persona role-panel timeline; otherwise it falls back to the same persona's Route. `gatewayId` disambiguates multiple Routes. Delivery is deduplicated by `sessionId + turnId` and records a stage-completion fact only; it does not advance steps, change plan status, or write memory automatically. A top-level paused plan receives no completion reminder, so the binding is not re-driven while paused.

Manager exposes the read-only batch endpoint `GET /api/roles/:roleId/plan-agents/status?planId=...`, resolving each `taskBinding` and optional `secretaryBinding` by its `agentType + sessionId + workspace`. Codex reads the Desktop task; DSH reads the session through its bound `baseUrl` or the local default apiproxy when none was saved. Agent work state is returned separately from the session's `active / idle / not_loaded / unavailable / archived / missing / workspace_mismatch` state. A timeout or read failure is `unknown`; plan lifecycle state is never used as a substitute. `POST /api/roles/:roleId/plan-agents/:planId/open` locates only an exact verified, unarchived, workspace-matching binding: Codex opens the target task and DSH opens DSH Web with an exact session-selection request. It sends no prompt, creates no session, and does not change the binding.

`taskBinding` identifies the plan's independent business-execution task; it never points to a persistent plan secretary. Secretaries are control-plane workers: they maintain plans and memory, resolve and deduplicate business tasks, inspect real status, consume results, and continue the bound task. Investigation, implementation, testing, Unity/SVN/build/release work, and external-system changes belong to the business task. A secretary may create temporary child agents only for plan inventory, deduplication, status checks, and result summaries; neither the secretary nor those children modify business files.

After a business-task completion reminder, the responsible Secretary directly consumes the result, PATCHes the plan and memory, and continues the exact business `taskBinding.sessionId + workspace` when the plan remains actionable. Ordinary progress, state changes, waiting conditions, and next actions remain with the Secretary. It escalates only decisions, approval, authorization, missing user input, cross-plan conflicts, complete closure, or safety-reviewed outbound communication to the Primary Persona. Pausing a plan or rotating a Secretary never clears the business binding. Rebinding is allowed only after the business task is genuinely unavailable and a controlled migration has completed; completed plans may retain the binding as historical evidence. Completion callbacks, heartbeats, and resume inspections should use all available Secretary slots across management shards and end only when both `actionable plans without management = 0` and `actionable but idle business tasks = 0`. Already active business tasks are not sent duplicate turns. Authorized inquiry and evidence gathering continue without bypassing action gates.

PangHu work remains actionable when the formal Main Unity Editor is open, importing, running another test, temporarily unavailable through MCP, or using a shared test queue. A Secretary must not turn these conditions into a global freeze or a wait for an exclusive workstation, and must not stop the Editor, cancel another run, or overwrite unrelated changes. The original business task continues implementation, narrow SVN updates and merges, static asset/prefab/configuration and direct-serialization contracts, non-Unity runners, and CLI validation. GameView, PlayMode, or interaction checks that cannot run concurrently become explicit human or later runtime acceptance items. Unrelated full-suite failures do not block matched validation or feature development, but their failures and skipped checks remain recorded.

Plan-management writes are isolated by `planId`: one control-plane writer per plan, with different plans allowed to proceed concurrently. Shared ledgers, issue mappings, and delivery receipts are read at the latest version inside short file locks, merged only at the target record, and atomically replaced; a stale whole-file snapshot must never overwrite another plan. Lock metadata is fully written to a candidate and atomically published with a same-volume hard link. The hot path never deletes a stale or corrupt lock automatically: it fails closed, and repair is allowed only during an explicitly quiescent maintenance window with writers paused. `claim` and `clarify` use a separate lease keyed by source message and stable operation key, persisting a reservation before delivery. An uncertain send or a sent-but-unverified result remains `uncertain` / `sent_unverified` and is never resent automatically.

A fresh `work-cycle begin` reads the plan and recent memory before it creates the bound task's history snapshot or persists a cycle. Idempotent Manager GETs use bounded retries with a per-attempt timeout; POST, PATCH, and other potentially side-effecting requests are never replayed automatically. If recent-memory reads still fail after retry exhaustion, begin releases the plan lease and leaves neither a started cycle nor a history snapshot for that attempt. The error remains visible to the secretary; a later direct GET success does not retroactively complete the failed begin.

Global strict audit is observational and compares ledger snapshots from before and after validation. Only a cycle whose identity stayed stable can become `invalid`; a cycle that appeared, disappeared, or changed during the audit is `incomplete`. Active cycles or plan leases make `quiescent=false` but do not block unrelated plans. Plan closure uses plan-scoped strict audit, while global quiescence is reserved for explicit maintenance or final drain. Thread-status reconciliation likewise skips only active plans and continues the rest.

The target Codex Route must already have an exact task ID and must differ from the execution session. Multiple plans bound to one execution session, workspace mismatch, execution-context persona mismatch, a missing or wrong-persona gateway, or multiple same-persona gateways without `gatewayId` all fail closed. The capability remains experimental until verified between two real Desktop tasks.

Completed plans remain visible for confirmation. A role-knowledge snapshot archives them when the latest `updatedAt` is more than the current fixed 72-hour window old. It sets `archivedAt` and moves the whole directory from `plans/active/<planId>/` to `plans/archive/<planId>/`.

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

Recent memory stores a focused fact, preference, conclusion, or unresolved question that is still editable or waiting to be consolidated. Once Manager writes `consolidatedAt`, the source file remains under `memory/recent/` for audit traceability but moves to the Archived category and no longer counts or appears as recent memory.

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

Memory now distinguishes direct viewing from a true recall hit:

- Reading a recent or consolidated memory by ID refreshes `viewedAt`.
- Updating recent memory refreshes both `updatedAt` and `viewedAt`.
- A recall match placed in required reads refreshes both `viewedAt` and `recalledAt`.

The editable and default-context windows still use the later of `updatedAt` and `viewedAt`, so an Agent can explicitly read and then correct an old recent memory. The 24/72-hour consolidation clock instead uses the later of `updatedAt` and `recalledAt`; a direct read does not postpone consolidation, while a true recall hit or update does.

New recent and consolidated memories are stored as Markdown files. Lifecycle, source, keyword, and trace fields stay in frontmatter, while the body is ordinary readable Markdown. Legacy `.json` memories remain readable. If both formats contain the same ID, Manager prefers `.md` and counts the item once. WebGUI renders headings, lists, tables, code, links, and mixed text/images; images load only from HTTP(S), while local absolute paths and dangerous protocols are blocked.

## Current memory windows

```text
recentEditableHours = 24
recentConsolidationHours = 72
```

These are fixed defaults in the current implementation, not public persona configuration fields.

- Recent memories active within 24 hours are listed directly in the packet.
- Older unconsolidated memories are normally omitted but can still be recalled by ID, title, or keyword.
- An explicit consolidation request is due when an unconsolidated recent memory has not been updated or recalled for more than 72 hours.
- When the least-active memory reaches 72 hours, Manager freezes that run's `triggerAt` and its candidate ceiling at `triggerAt - 24 hours`. A late execution does not add memories that crossed 24 hours after the original trigger. An update or true recall before execution can still remove an item by changing its activity time.

Manager dynamically projects `triggersNextConsolidation` and `willEnterNextConsolidation` booleans onto recent-memory list items. The projection is cached with the memory catalog and invalidated after a create, update, or recall hit. WebGUI displays those booleans instead of recalculating the candidate set.

The consolidation run stores `triggerMemoryId`, `triggerAt`, `candidateCutoffAt`, and `deliveredAt` after Desktop accepts the request. A Manager restart does not redeliver the same accepted run. The UI projection and the actual request use the same Manager-owned cohort function.

The Manager API can override the two thresholds for one consolidation request.

## Consolidated memory

Consolidated memory is a stable, recallable record produced from one or more recent memories and shown in its own Consolidated Memory tab. It stores `inputMemoryIds` and `consolidationRunId` for traceability. Existing consolidated memories have no ordinary update endpoint. The source records marked with `consolidatedAt` are shown separately under Archived together with archived plans.

If a consolidated fact is wrong, create a corrective recent memory. A later run can produce a new stable item without mutating history in place.

## Automatic and explicit consolidation flow

Current entry points:

1. Manager's one-shot deadline scheduler when the least-active memory reaches 72 hours.
2. The built-in `manual_trigger` with `triggerId=memory-consolidation`.
3. `POST /api/roles/:roleId/memory/consolidation-requests`.

```json
{
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

When due, RabiRoute creates a run under `memory/consolidation-runs/` and supplies the eligible recent memories to the handler. `force=true` skips the due check but does not include items still inside the editable window.

Manager schedules the earliest known 72-hour deadline without a resident polling loop. At the deadline it rereads current memory activity, so an update or true recall can postpone the run before delivery.

A Codex Route may enable a dedicated Memory Consolidation Agent. Automatic or manual `manual_trigger + triggerId=memory-consolidation` delivery then goes only to the persistent Desktop task `<Primary Persona task name> 记忆整理`, using `gpt-5.6-terra` by default. The Primary Persona does not receive the same request. Missing Desktop ownership or delivery failure fails explicitly without a fallback Runtime or Primary-Persona retry. The switch chooses the handler; it does not enable or disable the 72-hour scheduler.

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

Long plan lists use `GET /api/roles/:roleId/plans?limit=8&cursor=<offset>&detail=summary&view=<current|plans|archived>&query=<text>` to read lightweight batches of eight within the selected category and search. Each summary includes the current-step title, progress counts, and attachment count, so WebGUI mounts it immediately without waiting for the body. When a card approaches the viewport, `GET /api/roles/:roleId/plans/:planId?detail=preview` reads only its body preview, current-step detail, blocker information, and attachment metadata; image, video, and Markdown attachments remain visible on the collapsed card. Expanding the card calls the single-plan endpoint without `detail` to fetch complete steps and approval contracts. Feedback, live Agent state, and revision history remain separate on-demand reads. Later summary pages send `facets=0`, yield one rendering frame between batches, and do not keep the first-screen global loading indicator active. Viewport previews allow at most four concurrent requests, and directory navigation moves the target preview to the front of that queue. Off-screen cards retain browser `content-visibility`. Manager keeps its two-level incremental plan cache and reuses presented ordering while the plan catalog is unchanged. Preview and full-detail reads prefer the warm list cache. Directory watchers coalesce write bursts and asynchronously reread only changed plan JSON; canonical POST/PATCH writes update the exact cache entry, while filesystems without watcher support fall back to short-TTL validation. These are derived read caches only, and plan files remain the sole source of truth.

Memory lists can call `GET /api/roles/:roleId/memory?kind=<recent|consolidated|archived>&limit=24&cursor=<offset>&query=<text>`. WebGUI requests only the currently visible recent, consolidated, or archived-memory category, returns at most 24 items for the first screen, and requests more on scroll instead of transferring every memory when the page opens. Manager reuses parsed memory catalogs until their directory changes. When the browser tab is hidden, the knowledge page stops further loading, closes its Manager event connection, and ignores stale request results; becoming visible triggers one catch-up read for the current category.

Plan pagination also accepts `sort=<status|updated|importance|urgency>`, repeated `status=<presentation-status>`, repeated `tag=<keywords-tag>`, and `facets=0`. `updated` compares the `updatedAt` timestamp. The other three modes compare Manager-projected integer levels. Status uses `statusLevel`; importance and urgency use `0–4`, where `0` is highest, `1` high, `2` medium, `3` low, and `4` not set. Legacy `priority` strings are converted once at the read boundary. A legacy plan without `urgency` may derive a compatibility level from `dueAt`. Sorting never compares display labels. The response also carries the Chinese and English labels plus palettes for each level, and WebGUI only renders them. Manager applies filters and sorting before pagination.

## Plan guidance and approval feedback

Plan feedback is an independent JSONL audit record stored as `feedback.jsonl` inside the same plan directory. `kind=guidance` is plan-level guidance associated only with `planId` and must not carry `stepId`; `kind=approval_suggestion` is formal feedback associated with an approval step. Neither is a second copy of the plan JSON or the generic Outbox Action Queue.

The read endpoint returns complete `records` after collapsing delivery-state updates for the same `feedbackId`. RibiWebGUI can load them on demand from every plan detail and preserves plan-guidance and approval-feedback history after approval, completion, and archival. `latest` remains only a lightweight summary and delivery-state signal.

## Plan revision history

The plan JSON is the current-state record. Every create, update, and archive also appends a full plan snapshot to that plan directory's `history.jsonl`. The snapshots retain the steps, approval contract, status, and timestamps from that point, so later Agents can review the actual plan before and after an approval result.

```http
GET /api/roles/:roleId/plans/:planId/history
```

RibiWebGUI provides a collapsed **Work history** section in every plan detail. It separately shows plan guidance, step approval feedback, and plan revisions. Completion, a move to `archive/`, or leaving the pending-approval state never removes these records from the interface. Archiving changes only the default plan view and the plan JSON directory; it does not delete feedback files, feedback attachments, or revision history. Removing local runtime data is a separate manual file operation, not a plan lifecycle action.

RibiWebGUI submits plan guidance with `kind=guidance`, `author=user`, `source=webgui`, and `notifyAgent=true`, without `stepId`; Manager accepts it only for running plans that are not currently in an approval step. WebGUI and tray approval submissions continue to use `kind=approval_suggestion`, `author=user`, `source=webgui|tray`, and `notifyAgent=true`. Plan guidance and approval use the same feedback composer, so both support `@` references to plan attachments, keyboard submission, file selection, clipboard paste, attachment previews, and removal. Future composer capabilities must be added through this shared component so both inputs receive them together. Newly uploaded content is stored under the same plan directory's private `feedback-attachments/<feedbackId>/` directory; JSONL records never embed the binary content. Both feedback types are durably recorded before returning `deliveryStatus=pending`. A complete business binding goes through `/api/agent/threads` and Desktop IPC to the original task; with Plan Secretary enabled, the responsible `secretaryBinding` simultaneously receives the control notice and the Primary Persona is not notified for every automatic delivery. An incomplete business binding sends the full feedback to the Secretary first, falling back to the Primary Persona only when no usable Secretary is enabled. Retry, terminal status, and `plan_feedback_changed` semantics remain shared.

After receiving `guidance`, the Agent first reads the current plan and feedback, treats the guidance as whole-plan direction, and explicitly `PATCH`es the plan plus any not-started steps affected by changed scope, priority, method, or path. It then writes `kind=guidance_response`, `author=agent`, and `notifyAgent=false` under the same `planId` without `stepId`. Approval feedback still updates the affected plan/step and approval receipt before writing `approval_response` under the same `planId / stepId`. Neither record advances a plan automatically.

While background delivery is pending, WebGUI keeps the next draft editable but prevents another submission until the prior feedback reaches a terminal state. Plan guidance appears only for running plans outside approval; approval plans continue to expose only the approval contract and approval input inside the owning step.

## Manager presentation order and plan views

Manager uses the current step's `approvalRequest` as the only approval-gate source of truth. A complete actionable contract with `responseStatus=pending` simultaneously produces `presentation.approval.state=ready`, `enabled=true`, the internal `blocked` tone, and `Awaiting approval`, so every approval wait has an actionable entry. An incomplete contract produces `incomplete` while the plan remains in progress for Agent investigation and repair. Legacy `isBlocked` is only a compatibility projection, and `blockedBy` is explanatory text; neither independently creates a display stage.

Manager exposes only six non-terminal presentation states: green `In progress`, blue `Awaiting package`, purple `Awaiting QA`, gray `Paused`, red `Awaiting approval`, and orange `Awaiting manual verification`. External information, assets, owners, accounts, devices, authorization, and receipts remain internal wait details. The top-level lifecycle field is unchanged.

CLI, static checks, fallback validation, retries, sending, or coordination keep a plan green `In progress`. Delivery closure followed only by missing package identity or inclusion proof is blue `Awaiting package`; proven inclusion is purple `Awaiting QA`. A complete approval contract is red `Awaiting approval`. A `manual-verify-*` step appears orange `Awaiting manual verification` only after development closure. No remaining safe action is gray `Paused`; reconcile keeps the exact internal reason.

Presentation treats only explicit action sentences in `nextAction` and the current step title as current alternatives. Historical completion evidence in `currentStep` or step `detail`, such as “runtime screenshots sent,” “tests completed,” or “do not resend,” cannot turn a result-only wait back into `Executing`. A still-pending instruction such as “run the CLI check and send the review request” remains executable.

The `implementation/development validation and applicable Main/Release/Art sync, SVN commit, and conflict-free readback → Awaiting package → Awaiting QA → complete on QA pass; return to investigation and implementation on QA failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. A Main-only change, unfinished applicable sync, missing commit, or incomplete readback remains `In progress`. Manager evaluates the structured current step together with completed delivery-step records: when the same delivery has revisions, applicability, matching-test results, submission, and conflict-free readback, but still lacks target-package identity or inclusion proof, a post-reconcile delivery-verification step remains `Awaiting package`. Once the target package proves inclusion, the plan enters its QA step; the QA send receipt is evidence for that step and does not create a separate “package complete, send QA” main stage. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real steps and `waitingFor`; producers must not manufacture package or QA steps merely to fit that lifecycle. Manager does not infer or force the lifecycle from a plan title, prose, or `kind`.

`presentation` exposes `status`, `tone`, `statusLevel`, `sortBucket`, the shared palette, and approval details. `counts.stages` summarizes only the public stages; orange `Awaiting manual verification` uses `manualVerification`. Non-terminal presentation sorts `Awaiting approval → Awaiting QA → Awaiting manual verification → In progress → Awaiting package → Paused`, with Paused last.

The secretary's `reconcile-thread-statuses` command consumes this same Manager `presentation` and cross-checks it against structured delivery and environment evidence in the issue ledger and latest completed cycle. Terminal and complete approval waits become `terminal / blocked`; paused plans become `frozen + paused` with `implementationDispatchAllowed=false`; `waiting_package` and exclusive-environment waits backed by current `waiting_environment* + environment-owner` evidence also become `frozen`, unless an authoritative release for the same PID/project supersedes that owner evidence. A structured dependency step or tracking state becomes `frozen_until_dependencies` only when it explicitly waits for other plans' original owners to finish and the plan, issue, and cycle evidence also says that no independent CLI, control-plane, or business action remains. Contacting or coordinating owners, completing a missing contract, obtaining a reply, or retaining a CLI, retry, or fallback path keeps the plan `actionable`. A QA or ordinary inquiry with a real `status=sent / sentMessageId` receipt becomes stable `waiting_result` when issue/cycle evidence explicitly says that only the result remains, no independent local action exists, no separate review or confirmation request is still unsent or unresolved, and resending is forbidden. An older QA receipt cannot cover a later owner review or placement confirmation. That receipt may come from structured issue evidence or the latest cycle summaries and is not invalidated by later plan updates or the ordinary deduplication window. A merely recent ordinary send still uses `waiting_result_dedup`. Only idle plans with remaining local work, missing real delivery/receipt, an explicitly due follow-up, a separate pending inquiry, a retry, or an alternative path remain `actionable`; a delivered inquiry does not get repeated merely because local work remains. The result exposes separate `frozenIdle`, `waitingResultIdle`, and `actionableIdle` collections. `implementationDispatchAllowed` is true only while implementation work may still run; terminal, paused, approval-blocked, package, cross-plan-dependency, test-environment, renewed-authorization, and QA-verdict waits return false because no implementation action remains.

For the refined states, `waiting_package` returns `frozen_until_package + wait_for_target_package`; a cross-plan dependency with no independent action returns `frozen_until_dependencies` with `requiredAction=null`; a real test-infrastructure wait returns `frozen_until_test_environment + wait_for_test_environment`; renewed authorization returns `waiting_for_authorization + request_authorization`. These waits set `implementationDispatchAllowed=false`. The green QA stage also forbids implementation dispatch: a missing QA receipt with a repairable send path returns `actionable + send_qa_request`, while a sent request that only awaits a verdict returns `waiting_result + wait_for_qa_result`. Strict audit rejects a QA step that claims only the verdict remains without a current receipt. Available CLI or fallback validation remains actionable, while ordinary missing external information continues to use `inquire_until_result`.

The Qt tray and RibiWebGUI both consume this Manager DTO, stage summary, view membership, palette, and order. RibiWebGUI uses four tabs: `Current Plans / Recent Memory / Consolidated Memory / Archived`; Archived combines archived plans with source memories marked by `consolidatedAt`. The Qt tray keeps its compact categories. Neither client reads `data/` directly nor owns a separate state-recognition, status-color, or ordering table. If `presentation` is absent, clients show neutral `Status unknown` instead of inferring a real stage from lifecycle fields.

Both the Qt tray and RibiWebGUI's Plans & Memory page consume this Manager DTO and its existing order. Neither reads `data/` directly nor maintains a separate status or sorting implementation. RibiWebGUI shows a non-duplicate `focus` below the plan title and nests the approval contract inside the step card identified by `presentation.approval.stepId`. Search examines all content values returned for a plan or memory, including steps, current actions, waiting/blocking details, approval contracts, attachment metadata, memory bodies, and source summaries, instead of limiting matches to title, focus, and keywords. Its page-level directory floats outside the plan panel, stays sticky, and scrolls within the viewport; it contains only the plans visible under the current tab and search query, while plan cards remain in normal page flow.

## Qt tray view

The Qt panel displays current plans, recent memory, consolidated memory, and diagnostics. It does not create, complete, archive, delete, normalize, or migrate plan/memory content. Approval-enabled plan cards may append formal feedback through Manager without changing the plan itself. Incomplete approval contracts keep approval input disabled in both clients; RibiWebGUI's whole-plan guidance appears only when the plan is outside approval.

## Boundary

RabiRoute does not convert raw chat logs into memory automatically and does not decide what the handler should remember. The handler creates focused plans and recent memories. RabiRoute provides storage, indexing, validation, recall side effects, explicit consolidation runs, plan-content/memory views, and constrained plan-guidance and approval-feedback entries.
