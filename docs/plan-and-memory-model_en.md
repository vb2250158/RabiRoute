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
  plans/feedback/*.jsonl
  memory/recent/*.json
  memory/consolidated/*.json
  memory/consolidation-runs/*.json
```

The filesystem is the source of truth. The Manager API reads and writes these files. Qt and WebGUI keep plan content read-only while allowing approval feedback on Manager-declared approval steps.

## Plans

Plan status is one of:

```text
`未开始`  not started
`进行中`  in progress
`已完成`  completed
`已归档`  archived
```

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
  "steps": [
    { "id": "inspect-current", "title": "Inspect the current model and UI", "status": "已完成" },
    { "id": "verify-schema", "title": "Verify the structured step contract", "status": "进行中" },
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

`steps` is the ordered execution path. Every new plan must list all of its steps, with at most one step in `进行中`. Top-level `currentStepId` must point to that step so both the UI and Agents can answer exactly where execution is. A step may include `detail`, `waitingFor`, `blockedBy`, and `completedAt`: `waitingFor` identifies who or what the plan awaits, while `blockedBy` explains why it cannot proceed and should normally live on the blocked current step. `currentStep` remains a progress note; it no longer acts as the step list or step identity. Because structured steps already express the future path, the UI does not repeat `nextAction`; Agents and legacy plans may still use that field. Legacy plans remain readable and should gain structured steps on their next update.

`taskBinding` is the optional exact plan-to-execution-session binding. The current implementation supports only `agentType=codex`. `sessionId` is the required complete execution-task ID; `sessionTitle` is display metadata and `workspace` is a Stop-Hook safety check. With `completionHook.enabled=true`, Manager forwards the official final answer through the existing role-panel path to the same persona's Route after that session finishes a turn. `gatewayId` disambiguates multiple Routes. Delivery is deduplicated by `sessionId + turnId` and records a stage-completion fact only; it does not advance steps, change plan status, or write memory automatically.

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
maxSteps=100
nextActionChars=600
waitingForChars=300
blockedByChars=600
sourceSummaryChars=240
keywordChars=32
maxKeywords=24
totalChars=2800
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

Candidates include non-archived plans, unconsolidated recent memories, consolidated memories, and non-archived role skills. Active plans and active recent memories receive only a small ranking bonus. A candidate must still match the current message to enter required reads.

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

## Plan approval feedback

Plan approval feedback is an independent JSONL audit record associated with a `planId` and optional `stepId`, stored under `plans/feedback/<planId>.jsonl`. It is neither a second copy of the plan JSON nor the generic Outbox Action Queue.

WebGUI and tray submissions use `kind=approval_suggestion`, `author=user`, `source=webgui|tray`, and `notifyAgent=true`. Manager records the feedback first, then uses the existing role-panel delivery path to notify the bound Agent. `deliveryStatus` distinguishes `pending`, `delivered`, `failed`, and `record_only`. When recording succeeds but delivery fails, clients keep the draft and retry with the same `feedbackId`; Manager collapses delivery updates for that ID instead of creating another approval record.

After receiving approval through QQ or another channel, an Agent may call the same endpoint with `source=qq` and `notifyAgent=false` to record the user's decision. Agent-authored handling notes use `author=agent` and `kind=approval_response`, which are always `record_only`. No feedback submission advances a plan; only a later explicit plan `PATCH` by the Agent changes steps or status.

## Manager presentation order and plan views

The Manager plan API adds read-only `presentation.status` and `presentation.tone` fields for display-only states such as `Blocked` and `Awaiting QA`; these fields are never written back to plan files. `presentation.approval` centrally decides whether approval input is shown and supplies its target `stepId`, label, and helper copy. Plans are ordered as `Blocked → Awaiting QA → In progress → Not started → Completed → Archived`, then newest `updatedAt` first within each status. Recent and consolidated memory are also returned newest-first by `updatedAt`.

Both the Qt tray and RibiWebGUI's Plans & Memory page consume this Manager DTO and its existing order. Neither reads `data/` directly nor maintains a separate status or sorting implementation.

## Qt tray view

The Qt panel displays current plans, recent memory, consolidated memory, and diagnostics. It does not create, complete, archive, delete, normalize, or migrate plan/memory content. Approval-enabled plan cards may append feedback through Manager without changing the plan itself.

## Boundary

RabiRoute does not convert raw chat logs into memory automatically and does not decide what the handler should remember. The handler creates focused plans and recent memories. RabiRoute provides storage, indexing, validation, recall side effects, explicit consolidation runs, plan-content/memory views, and a constrained approval-feedback entry.
