<!-- docs-language-switch -->
<div align="center">
English | <a href="./code-architecture.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Code Architecture

> Status: current code map. Module paths, Codex transport, and adapter maturity are aligned with the repository.

## Event-driven red line

By default, the owner of a business-state change emits an event, and Routes, personas, clients, or control surfaces react to it. Where reliable events exist, fixed-interval HTTP requests, full-directory scans, and repeated JSONL reads must not be used to discover whether anything changed. A cursor exists only for gap recovery and idempotency after an event-stream reconnect, never as a polling cadence. Settle, retry, timeout, and Heartbeat use one-shot scheduled events that must have explicit work; they cannot idle-scan. Low-level audio stall watchdogs and SSE/WS transport keepalives do not read business state. A controlled exception is allowed only when the host or upstream explicitly lacks events, SSE, WebSocket, or change notifications and removing polling would break an existing function. The exception must bound its lifecycle and read scope, use a long wait or minute-scale low frequency, support stop/backoff, and document the reason. Exactly five controlled exception classes remain: while the Android foreground service is already known offline, it checks only current OS connectivity every five minutes to cover rare vendors that miss the registered default-network callback, stops immediately after recovery, and never queries Relay, messages, or cursors; DashScope remote asynchronous meeting ASR checks job completion within the request deadline; the explicitly enabled Xiaomi Health ADB Companion has no upstream push API; Rokid AIUI QuickJS uses a 25-second foreground event-backed downlink wait; and visible AIUI pages refresh glasses battery no more often than once per 60 seconds because the host exposes no verified change event.

## High-level flow

```text
src/index.ts
  -> message adapters
  -> history records
  -> src/forwarding.ts
     -> routing/routeDecision.ts
     -> routing/agentPacket.ts
     -> agentAdapters/* / Codex Runtime

src/manager.ts
  -> manager/controlPlaneRoutes.ts
  -> config repository and migration
  -> runtime registry/status
  -> message endpoint managers/scans
  -> Codex Desktop IPC bridge
  -> RibiWebGUI static/API service
```

See [Path and Directory Conventions](path-and-directory-conventions_en.md) for complete ownership of software, public samples, local data, runtime state, and logs. `src/shared/projectDirectoryLayout.ts` supplies fixed project locations, while `src/shared/pathPolicy.ts` validates constrained relative paths. Route runtime data and persona data use separate `routeDataDir` and `personaDataDir` fields; legacy `dataDir` is accepted only at the configuration boundary.

## Client applications and shared SDK

- `apps/rabilink-android/`: one Android project containing the phone controller and the `glass-app` module.
- `apps/rabilink-aiui/`: the independent Rokid AIUI/Lingzhu client project.
- `packages/android-sdk/`: shared Android event, message, and status contracts consumed by client apps.

These directories are clients of RabiRoute, not sources of truth for Manager configuration or runtime data. Copyable integration samples stay under `examples/`; complete products belong under `apps/`, and only stable cross-app interfaces belong under `packages/`.

## Backend entries

### `src/index.ts`

One gateway subprocess. It loads normalized route configuration, starts gateway-level message adapters, records events, and invokes forwarding. Manager-level endpoints such as role panel and Remote Agent do not start duplicate listeners here.

### `src/config.ts`

Runtime configuration types and environment/default resolution used by the gateway. Shared validation and port ownership belong in `src/shared/gatewayConfigModel.ts` rather than being duplicated in adapters.

## Message path

### `src/adapters/`

Protocol translation for live gateway inputs:

- NapCat/OneBot, including non-blocking `get_msg` fallback through `napcatReplyMessages.ts` when a referenced QQ message is missing from local history.
- WeCom smart-bot WebSocket.
- Experimental personal-Weixin OpenClaw/iLink explicit QR login, long-poll ingress, protected restart recovery, and source-session text or allowlisted local-file replies. Windows protects session material with current-user DPAPI; other platforms use an access-restricted local key with AES-256-GCM. Temporary network/5xx failures retain the session; only explicit `-14` or HTTP 401/403 rejection invalidates it. Inbound media is record-only and real-account longevity remains unverified.
- Feishu enterprise-app callbacks with URL challenge handling, raw-body signature and Verification Token checks, Encrypt Key decryption, durable `event_id` deduplication, `chat_id` context isolation, and source-chat text replies. Missing credentials or event-subscription enablement fails closed without falling back to the generic Webhook.
- Webhook-like inputs such as XiaoAI, plus legacy-only FenneNote parsing. New PC speech uses RabiSpeech.
- RabiLink compatibility/input paths.
- heartbeat/manual and other internal adapters.

An adapter should parse, normalize, record, report health, and call forwarding. It should not build handler prompts or send an immediate external reply from an inbound callback.

### `src/history.ts`

Append-only JSONL helpers and record types for protocol-specific messages, packets, Outbox results, adapter logs, and other runtime evidence. These files remain audit and compatibility evidence, but they are no longer separate sources of truth for automatic recent context.

### `src/messageContextStore.ts`

The canonical persona-scoped bidirectional conversation store:

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

`current.jsonl` has no entry-count cap. When an archive check finds any record older than 72 hours, it moves the complete contiguous prefix older than 24 hours into a sequence-range archive. Automatic Agent context reads only `current.jsonl`; archives remain explicit-query evidence. Queries match the current persona, logical endpoint, and conversation, with inbound and outbound records sharing one message-count budget. Attachment records keep only safe metadata rather than private absolute paths. `src/messageContext.ts` is a compatibility facade over this implementation.

### `src/forwarding.ts`

The orchestration center for a matched event:

1. Record the inbound event in each relevant persona's canonical conversation ledger before low-signal or rule filtering.
2. Build a `RouteDecision` for the current route profile.
3. Build an `AgentPacket` for each matched rule.
4. Record the packet.
5. Deliver through the selected handler adapter/runtime and report status/errors.

Keep handler transport and session policy behind the adapter/runtime boundary.

## Routing module

### `src/routing/routeDecision.ts`

Pure routing semantics: route kind, route text, regex, target filters, and matched rules. A decision should not read role memory, send messages, or start a handler.

### `src/routing/agentPacket.ts`

Combines a decision with role context. It creates workspace-relative template values and the generated wrapper containing recent bidirectional messages from the current persona/logical endpoint/conversation, role knowledge, logs, reply API/context, and endpoint-specific delivery instructions. Automatic recent context never reads the archive directory.

When the routed message explicitly asks the Agent to handle multi-PC persona synchronization, AgentPacket adds the one-shot loopback contract for same-application peer discovery, current-persona synchronization, and terminal conflict inspection. Ordinary messages receive no persona-sync prompt. Manager's event-driven automatic reconciler runs independently and is neither created nor owned by packet construction.

When the current message asks who spoke across a day/time range, how user speech differs from other speakers, or how to resolve a voiceprint, AgentPacket adds the current persona's `voice-transcripts` query and append-only `voice-identities` correction contract. Uncertain evidence must remain unknown; the host still makes no identity decision.

When a Route configures persistent plan-secretary tasks, AgentPacket adds each slot's full task ID, visible name, workspace, and control-plane boundary. Plan `taskBinding` still identifies an independent business task. Secretaries and their temporary children only inventory plans, deduplicate tasks, inspect status, consume results, and continue business tasks; they do not modify business files.

`src/routing/agentCapabilityHints.ts` owns these intent-gated capability prompts and their trigger vocabulary. It returns call contracts only: it reads no persona data, performs no HTTP, and decides neither identity nor synchronization targets. AgentPacket only presents the returned lines in the current task, keeping capability discovery out of routing and control-plane ownership.

Packet construction invokes `roleKnowledgeSnapshot`, so matched memory can refresh `viewedAt`. A memory-consolidation run is evaluated only for the explicit `triggerId=memory-consolidation` path.

### `src/routing/types.ts`

Common route-event and decision types shared by forwarding and tests.

## Handler adapters and Codex

### `src/agentAdapters/`

- `agentAdapter.ts`: registry/dispatch boundary.
- `astrbotAdapter.ts`: experimental AstrBot delivery.
- `managerApi.ts`: scan, login, deployment, and adapter-control read models.
- `stateReporter.ts` and ordering helpers: runtime status reporting.

Copilot CLI and Marvis use their dedicated modules outside this folder where appropriate.

### Codex internal boundary

- `src/codexRuntime.ts`: stable task identity, Desktop-owner delivery policy, and high-level create/read/send behavior.
- `src/codexRolloutActivity.ts`: asynchronous reverse-chunk inspection of the Desktop rollout tail to determine whether the latest turn is still active, with results cached by file version.
- `src/codexDesktopBridge.ts`: the single read-model entry for Codex tasks. Complete ID, cwd, archive state, and rollout location come from Desktop owner state; the exposed display name is overlaid only from the current left-sidebar index; delivery then uses Desktop IPC start/steer.
- `src/codexAppServerClient.ts`: short-lived metadata driver for creating and naming an empty task; it must not execute real prompts.
- `src/agentThreads.ts`: controlled local thread bridge.

The thread bridge supports list/read/resolve/create/rename/send. `rename` changes only the Desktop-visible name and preserves the full ID plus workspace identity.

Codex task facts have two distinct authoritative owners: identity is the complete task ID plus workspace, while the current display name comes only from the Desktop left sidebar. SQLite `threads.title`, the first prompt, Route `codexThreadName`, and runtime `monitorThreadName` are not additional name authorities. `codexThreadName` is only a bootstrap lookup/create hint when no valid ID exists; once the ID is valid, a rename never changes the binding or creates a replacement.

Desktop IPC is the only real-message transport. The target Desktop task owns model, tools, sandbox, approvals, and turn execution. A valid saved task ID is authoritative within its workspace; a stale index title or completed goal must not create a duplicate. Do not introduce shared-port, per-route stdio, CLI, or app-server execution fallbacks.

`codexPlanAssistantSessions` stores 1–8 persistent Desktop plan-management secretary task identities and initialization records per Route. Manager owns their one shared model through `codexPlanAssistantModel`; WebGUI does not copy model state into each task entry. These slots are control-plane sessions and never replace the independent business task stored in plan `taskBinding`. Secretaries maintain plans and memory, resolve and deduplicate business tasks, inspect status, consume results, and continue the bound task. They and their temporary control-plane children do not modify business files. Control-plane writes use a `planId` keyed lease: one writer for the same plan, parallel work across different plans, and locked latest-value merge plus atomic replacement for shared JSON. Locks are atomically published from complete candidate files; stale or corrupt locks fail closed on the hot path and require an explicitly quiescent repair. A same-key claim or clarification lease covers reservation, delivery, verification, and terminal receipt, so uncertain results are never automatically resent. Global audit compares before/after ledger snapshots and marks only stable-cycle failures invalid; plan-scoped strict audit closes one plan, and reconciliation skips only active plans. This layer remains experimental until real Desktop multi-task acceptance is complete.

Matched ordinary messages are delivered immediately: the Desktop bridge first attempts `steer` against an active turn and falls back to `start` only when no active turn exists. There is no general busy-skip switch for ordinary endpoint traffic. Heartbeat may explicitly skip while busy, and speech may explicitly use keyword wake-up instead of hot delivery.

Heartbeat busy checks inspect only the rollout tail needed to find the latest turn. They must not synchronously read or split the complete JSONL file. An incomplete final row is ignored while Desktop appends it, and oversized irrelevant rows are discarded so a long-running task cannot stall Manager or the Route child.

Codex activity merges two timestamped sources. Desktop IPC contributes a connection-scoped active marker, while the latest rollout turn/terminal event provides durable lifecycle evidence. A newer terminal clears an older IPC marker; a genuinely newer IPC start remains active until the rollout catches up. Disconnecting IPC clears its connection-scoped markers so a completed task cannot remain active because of a previous connection.

`src/messageAgentPool.ts` does not own Codex task runtime status. Exact `/api/agent/threads` reads combine Desktop host readiness, connection-scoped activity, and the Codex rollout terminal state into `active / idle / notLoaded / unavailable`. The pool uses only an in-memory reservation during one allocation and never persists these states. `agents.json` stores only the full task ID, current sidebar name, workspace, index, and initialization metadata. `routing-affinity.json` stores only recovery hints that associate message groups with endpoints, conversations, and speakers. If Desktop is offline or current status cannot be read, the group stays in `pending.json` and resumes after recovery; local snapshots cannot authorize pool expansion.

The message-processing board does not persist task activity either. On every board read, Manager resolves the current sidebar title and `active / idle / notLoaded / unavailable` status from Codex by exact task ID and adds them only to that response. A failed read is shown as unavailable instead of reusing a previous idle or active observation.

## Message-processing requirement state

`src/messageProcessing/board.ts` is the Manager-owned message-processing state machine. `src/messageProcessing/persistence.ts` stores it under runtime `data/.runtime/message-processing-board.json`, so business rules do not choose their file location. Gateway registers a requirement before a message group enters a Codex Message Agent task and records the exact Desktop task after acceptance. The Message Agent submits reply, no-reply, or structured-handoff outcomes through the Manager API, and Outbox writes the real delivery result back through `replyContext.messageProcessingRequirementId`. Explicit mentions, direct replies, private messages, and plan-progress updates are required items; ordinary group discussion remains an Agent decision.

Agent-to-Agent response responsibility is persisted separately by `src/agentRequests/` in `data/.runtime/agent-requests.json`. `/api/agent/threads` changes a request to awaiting response only after the Desktop owner accepts the delivery. A formal response carries the original `requestId`, result, and next action. Codex `Stop` records that the target turn ended and schedules a reminder five minutes later without blocking the final answer. When the Route enforcement switch is enabled, `PreToolUse` rejects persistent-task delivery tools that bypass Rabi. A formal response to a Message Agent handoff returns the original publishing worker to `processing` so it can decide outbound delivery, approval, or another handoff.

Plan association comes only from structured `/api/agent/threads` `messageProcessing.planId`, never from title or text guesses. After `roleKnowledge.updatePlan()` completes its canonical write, it emits an in-process update event. Manager compares linked plan snapshots and creates notification requirements for status, current-step, next-action, wait-state, or step-progress changes. WebGUI reads the same state through Manager SSE events without polling chat logs or plan directories and does not create a second statistics source.

## Outbox / Action Gate

`src/outbox.ts` receives handler replies and resolves:

- route/source context;
- explicit target;
- pipeline and reply-to-source behavior;
- adapter output policy and payload support;
- endpoint credentials/configuration;
- platform sender implementation.

It supports current NapCat, WeCom, source-session personal-Weixin text/files, RabiLink, and role-panel return paths, retains legacy FenneNote compatibility, and records `sent`, `draft`, `blocked`, or `failed`.

`src/manager/agentReplyIdempotency.ts` sits between the Manager HTTP boundary and Outbox. When a caller explicitly supplies a stable `deliveryId`, it persists a reservation under runtime `data/agent-reply-idempotency/` before allowing the single winning request into `handleAgentReply()`. Concurrent calls and restart recovery for the same ID/payload only read the original result; changed payloads conflict, while `reserved/sending/uncertain` states fail closed. `GET /api/agent/replies/receipts/:deliveryId` exposes only that durable receipt. It neither guesses external-platform success nor auto-replays; QQ and similar channels still require real platform readback by `sentMessageId`.

There is no persistent generic Action Queue. Future approval/retry work should be layered on top of this audited result model.

## Manager control plane

### `src/manager.ts`

Starts the loopback Manager, loads route/role configuration, serves WebGUI/API, and coordinates route subprocesses and shared services.

### `src/manager/controlPlaneRoutes.ts`

The current broad HTTP control-plane router. It handles gateway operations, scans, Agent replies/threads, role knowledge, shutdown, and endpoint-specific actions. Continue extracting stable domain helpers instead of growing unrelated inline logic indefinitely.

`manager/personaCatalog.ts` is the shared source for persona scanning, Markdown-title parsing, fallback-file selection, and caching. Route summaries and cross-persona APIs must not implement competing display-name rules.

`manager/personaMessageAuthority.ts` issues and verifies HMAC capabilities bound to both a Route and persona. Its secret stays in local runtime data; directory responses, timelines, and delivery receipts never expose the capability.

`manager/personaMessagingRoutes.ts` remains a thin HTTP layer. It returns a directory without persona bodies or local paths, validates source capability, target Route, hop count, and durable idempotency, then calls the shared delivery service.

`manager/rolePanelDelivery.ts` owns the single delivery meaning used by both the local role-panel endpoint and cross-persona messaging. It records `status=sent` only after handler acceptance and records `status=failed` on rejection.

`manager/durableDeliveryIdempotency.ts` supplies the persistent reservation/receipt contract shared by Agent replies and persona messages: the same ID and request execute once, changed content conflicts, and uncertain work is never replayed automatically.

GET scans remain pure read models. `/api/scan/message-adapters` must not reuse startup, login, configuration-migration, or repair commands; those actions belong only to explicit POST control paths. `manager/scanController.ts` starts independent probes concurrently under one shared deadline and returns timeout/error fallbacks, `messageEndpoints/napcatHealthScan.ts` performs read-only per-runtime/per-instance NapCat observation, and `manager/messageAdapterHealth.ts` keeps QQ, personal Weixin, RabiLink, and speech operational states independent instead of promoting one endpoint failure to global offline.

Reads that may traverse large history stores must not run on Manager's main HTTP thread. `manager/managerReadWorkerPool.ts` runs voice-history queries in a bounded worker pool with separate concurrency, queue, and execution limits, and terminates the worker when the request disconnects. Concurrent summary-only voice requests for the same range share one scan. `messageContextStore.ts` filters archive files by indexed start/end timestamps before reading candidate bodies. When no conflict snapshot exists, the HTTP endpoint returns 202 immediately and a separate single-worker catalog pool performs rate-limited background traversal, without consuming voice capacity or running the directory at full speed. Control-plane diagnostics use `manager/jsonlTail.ts` to read bounded file tails and a request-scoped cache to avoid reading one shared log repeatedly for different cards. `/meta.readWorkers`, `/meta.catalogWorkers`, and `/meta.httpLimits` expose operational limits without business content.

It also selects loopback or LAN listening from `data/Config.json.webguiLan` and applies one non-local WebGUI-token gate at the HTTP boundary. The static shell may load without authorization, but Manager status, actions, SSE, and private resources remain inaccessible without the key.

`RABIROUTE_MANAGER_READ_ONLY=1` is reserved for built-artifact acceptance. It forces Gateway, Relay, LAN discovery, Route-watcher, and persona-file-watcher autostart off, skips startup speech-microphone reconciliation and configuration-directory migration, and rejects POST, PUT, PATCH, and DELETE at the HTTP boundary. `scripts/test-built-manager-readonly.mjs` starts the current `dist/manager.js` on a temporary loopback port, waits for stdout readiness events rather than polling, and reads only the Gateway summary, persona-sync manifest/index status/conflicts, host-wide speech messages, and every manifest persona's voice-identity and voice-conversation views. Read-only reconciliation does not write the manifest cache. Evidence contains only statuses, index mode, counts, and build hashes; it never stores persona names, role IDs, file paths, transcript bodies, people, tokens, Relay URLs, or listener addresses. The existing Manager on port 8790 is not restarted.

### `src/manager/configRepository.ts`

Reads/writes route and role configuration, preserving the split between `adapterConfig.json` and `personaConfig.json`.

### `src/manager/configMigration.ts`

Compatibility normalization at the configuration boundary. Runtime and frontend code should consume canonical fields after migration.

### `src/shared/gatewayConfigModel.ts`

Shared configuration types, normalization, validation, defaults, NapCat instance resolution, Route-owned listener conflicts, and cross-route constraints. A NapCat HTTP URL is an outbound dependency endpoint and may be shared by several Routes; normalization must not rewrite it as though each Route owned that listening port.

### `src/manager/runtimeRegistry.ts`

Owns the Manager's gateway runtime map. Avoid scattering competing `Map<string, GatewayRuntime>` sources of truth.

### `src/manager/statusPayload.ts`

Builds the Manager status read model consumed by WebGUI and diagnostics.

## Message endpoint management

`src/messageEndpoints/` supports control-plane scans and lifecycle actions:

- `napcatManager.ts`: NapCat Shell/WebUI/token/OneBot setup, launch, health, and instance operations.
- `webhookLikeScans.ts`: generic webhook, XiaoAI, and legacy FenneNote HTTP callback scans.
- `wecomManager.ts`: WeCom SDK, credential, connection/authentication, and recent-message scan.
- `remoteAgentManager.ts`: discovery, challenge authentication, connections, tasks, events, and returned files.

These modules do not replace live gateway adapter code.

## Role knowledge

`src/roleKnowledge.ts` owns:

- plans and delayed archiving;
- recent and consolidated memory;
- consolidation runs/results;
- role skills;
- metadata recall and required-read selection;
- write limits/validation;
- Agent context snapshots.

`src/roleKnowledge.ts` defines the five top-level lifecycle states and the step-level `approvalRequest` execution contract, while `planApprovalGate()` is the single interpreter for approval preparation and pending decisions. `planIsBlocked()` is true only when the current contract is complete, actionable, and has `responseStatus=pending`. `isBlocked` is generated during read/write normalization as a legacy-client compatibility projection, and `blockedBy` is explanatory text only. Legacy non-approval blockers are downgraded to running at read time and cleaned on the next canonical write. Missing contract fields produce `preparing/incomplete` without rejecting the plan write, so the Agent continues investigation and repair. `src/planPackageWaiting.ts` derives unified-package waiting only from a structured package/build step, completed prior work, and an explicit package dependency. `src/roleKnowledgePresentation.ts` produces the read-only Manager DTO: a complete pending approval displays `Awaiting approval`; a structured current `qa-* / verify-*` step displays `Awaiting QA acceptance`; a qualifying package/build step displays blue `Awaiting unified package`; remaining authoritative `waitingFor` values are classified as `Awaiting environment / assets / information / external response`; and work with no real wait displays `Executing`. Only producers of plans that change project content such as code, prefabs, assets, or configuration add the package/QA lifecycle. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real steps; the presentation layer does not invent package or QA steps from titles, prose, or `kind`. `src/roleKnowledgePagination.ts` summarizes the same tones under `counts.stages`. XinghaiBuilder's `work-cycle-parallelism.mjs` reuses this DTO and cross-checks issue/cycle `status=sent / sentMessageId` receipts, explicit result-only/no-local-work evidence, environment owners, and authoritative releases for the same PID/project before classifying idle work as `terminal / blocked / actionable / frozen / waiting_result`. A structured cross-plan dependency becomes `frozen_until_dependencies` only when evidence both waits for other plans' original owners and states that no independent action remains; owner coordination, a missing contract, or any CLI, retry, or fallback path remains actionable. Later plan updates do not invalidate a real delivery receipt, and stale owner evidence cannot override a newer authoritative release. A presentation tone alone cannot create an environment freeze, and a generic external wait cannot automatically suppress actionable work. WebGUI and Qt pass through Manager presentation, categories, palette, contract, stage counts, and list order; when presentation is absent they show a neutral unknown state instead of deriving another classifier from lifecycle or prose.

`src/planAttachments.ts` owns plan-level attachment count/size limits, local-path or Base64 ingestion, image/video signature checks, hashing, and materialization into the persona-private managed directory. `src/manager/planAttachmentRoutes.ts` serves only `roleId + planId + attachmentId` reads and verifies both lexical containment and realpath containment before responding; images and videos are inline, videos support one byte range, and the public plan DTO omits the local `path`. WebGUI consumes only this HTTP boundary for fixed-width 16:9 image, video, and short Markdown preview cards, ordinary file cards, and complete in-page previews. A Markdown card streams only the beginning of the source and turns it into truncated plain text; it does not execute Markdown HTML, links, or images. LAN resources consistently pass through `managerResourceUrl` to apply the current-session credential. WebGUI owns neither a plan editor nor arbitrary local-path access.

`src/planFeedback.ts` owns plan-feedback JSONL, delivery-state collapsing for one `feedbackId`, and read summaries. `guidance` is associated only with `planId` for running plans outside approval, while `approval_suggestion` is associated with an approval step. Manager persists either type at `/api/roles/:roleId/plans/:planId/feedback`, then `src/manager/planApprovalFeedbackDelivery.ts` reuses the exact business `taskBinding`. `src/manager/planSecretaryAssignment.ts` resolves the separate `secretaryBinding`: a valid existing assignment is reused; an unassigned plan gets one stable task from the enabled Secretary pool by plan ID, and `controlPlaneRoutes.ts` persists it through canonical `updatePlan()`. With Plan Secretary enabled, the guidance/approval body reaches the business task and the responsible Secretary receives the control notice; an incomplete business binding sends full feedback to the Secretary first. The persona Agent is only the no-Secretary fallback. Terminal state is emitted as `plan_feedback_changed`, and events do not enter the role-panel timeline or conversation ledger. The bound task handles guidance by PATCHing the whole plan and any affected not-started steps before writing a step-less `guidance_response`; approval still writes `approval_response`. Feedback does not advance plan state automatically.

`src/context/rabiContextManager.ts` is the sole role-context trigger boundary. It maps `session_start`, `user_prompt`, `reasoning_pre_tool`, `reasoning_post_tool`, `message_delivery`, and side-effect-free `preview` to one recall, archival, `viewedAt`, and presentation policy. It is also the only production caller of `roleKnowledgeSnapshot()`.

`AgentPacket` adapts normal routes as `message_delivery`; `manager/codexHookContext.ts` adapts Codex lifecycle events as session, prompt, reasoning, and plan-task `Stop` completion events. Context events render through `routing/roleKnowledgeContext.ts`. A Stop event does not enter recall: it matches the exact plan `taskBinding` stored by `roleKnowledge.ts` and persists `sessionId + turnId` deduplication state.

`manager/planTaskCompletionDelivery.ts` owns the completion handoff. It selects the plan-specified gateway or the only gateway for that persona. With Plan Secretary enabled, the official Stop result is sent directly through the Manager thread bridge to `secretaryBinding`, carrying the business task's `sourceThreadId` and `sourceAgentType=plan_agent`, without writing the Primary Persona role-panel timeline. Only the no-Secretary fallback writes the timeline and invokes the existing RolePanel trigger. Source-equals-target loops fail closed. Real prompts still use Desktop IPC only; the target Desktop owner, shared Secretary model, tools, and approval state have no second source of truth. `controlPlaneRoutes.ts` owns assignment persistence, dependency wiring, and HTTP; the plugin only forwards official Stop fields and neither changes plan state nor guesses completion from transcripts. The capability remains experimental until verified between two real Desktop tasks. Role knowledge is handler context and must not affect whether `RouteDecision` matches.

## Frontend and desktop

`ribiwebgui/` is the Vue/Vuetify control surface for configuration, scans, status, logs, documentation, and Plans & Memory. `gatewayStore.ts` paints from `/gateways?summary=1&includeConfig=1`, which retains complete editable Route definitions but omits logs, message files, and full persona bodies. Console, Message Adapters, and Log Diagnostics call `ensureDiagnostics()` only when they need the heavier runtime read. `PersonaTemplatePage.vue` renders a plain-text summary capped at 420 characters, while `PersonaDocumentPage.vue` opens the selected `persona.md` in a separate safe Markdown reader. Both use the WebGUI-authenticated `/api/roles/:roleId/persona-document` endpoint, which allows one Markdown file at the role-directory root and caps it at 2 MiB. `ribiwebgui/src/pages/RoleKnowledgePage.vue` reads `/api/roles/:roleId/plans` and `/memory`; plan content stays read-only, and each card separates overview, current execution, and full steps. `roleKnowledgeClient.ts` uses `loadRolePlanPageWithPriorityDetails()` to read the first eight summaries and then fetch complete details for the first two visible cards in parallel before the page applies the result, preventing bulk directory rendering from delaying first-screen details. Later visible-tab pages contain up to 50 summaries. Memory requests only the visible category, starting with 24 items and automatically continuing in pages of up to 100. A directory jump still mounts only a bounded window beginning at the target and moves that target's detail request to the front of the existing two-request queue; it does not create a second browser-owned data source. A hidden browser tab stops further loading and closes its own Manager event connection, then performs one catch-up read and resumes completion when visible again. Running plans with no approval state expose whole-plan guidance at the top of details and submit only `planId`. Each approval contract remains nested in the step card identified by Manager's `presentation.approval.stepId`; only `ready/enabled=true` accepts a formal approval decision. After persistence, the page updates only the local card and listens for `plan_feedback_changed` to read one plan summary instead of reloading all knowledge. The page is a client of Manager APIs, not the configuration source of truth.

After plan-summary completion and one render yield, `manager/planAgentStatusRoutes.ts` batch-reads the real Desktop task state for each `taskBinding` and optional `secretaryBinding`. `manager/planAgentStatus.ts` owns the 2.8-second bounded read, per-request binding deduplication, workspace verification, and separation of Agent work state from task state; the WebGUI's three-second request budget only decides when to show Unknown. A working task replaces directory time with a spinner, while every other result retains the time. Opening calls only `openCodexDesktopThread()` for an exact verified task, never a prompt, task creation, or fallback Runtime.

`src/roleKnowledge.ts` builds and caches a consolidation projection for recent-memory lists. It uses each memory's `updatedAt` / `recalledAt` to derive the 24-hour candidate boundary and 72-hour trigger, then supplies `triggersNextConsolidation` and `willEnterNextConsolidation`. `src/manager/memoryConsolidationScheduler.ts` arms a one-shot task for the earliest deadline, reevaluates activity when it fires, creates the run, and delivers a Manager-owned event. When the least-active memory reaches 72 hours, `recentMemoryConsolidationCohort()` freezes `triggerAt` and `candidateCutoffAt`; the list projection and real request share that result, so delayed execution cannot enlarge the cohort. New memories are written as `.md` with structured frontmatter and a standard Markdown body. Legacy `.json` remains readable, and `.md` wins when both contain the same ID. A memory write or external catalog change invalidates the projection with the memory catalog cache. `RoleKnowledgePage.vue` consumes Manager output and does not duplicate the candidate algorithm in the browser.

`src/memoryConsolidationAgent.ts` owns only the dedicated Codex memory task's exact owner, persistent binding, and Desktop IPC delivery. When configured, `forwarding.ts` sends only `manual_trigger + memory-consolidation` to `<Primary Persona task name> 记忆整理`, verifies that the Primary Desktop task is readable before first creation, and defaults the dedicated task to `gpt-5.6-terra`. Failure does not fall back to the Primary Persona or another Runtime.

`GET /api/roles/:roleId/memory?counts=1` returns only memory catalog counts. `RoleKnowledgePage.vue` starts it in parallel with the first plan screen regardless of the selected top-level tab, preventing a direct visit to Current Plans from leaving memory tab counts at zero. Memory bodies remain paged only for the visible memory category.

Memory cards render safe Markdown directly, stay capped at 512px with clipped overflow, and open complete content in the detail dialog. `markdownPreview.ts` permits HTTP(S) images only and blocks local absolute paths, `data:` URLs, and script protocols.

`ribiwebgui/src/components/PersonaAvatar.vue` owns consistent WebGUI avatar presentation and initial fallback. `src/personaAvatar.ts` owns persona-directory path constraints, image validation, content-addressed files, and atomic config switching. `src/manager/personaAvatarRoutes.ts` owns `/api/roles/:roleId/avatar` and the presentation DTO; `controlPlaneRoutes.ts` only registers it. Both WebGUI and Qt read avatars through Manager HTTP; Qt no longer resolves persona files through a local `RoleContextRepository`. Avatar metadata is presentation-only and never enters AgentPacket, route matching, or handler delivery semantics.

Speech control has an explicit frontend/backend split:

```text
SpeechServicePage / SpeechHostMonitor
  -> frontend speech store
  -> frontend speech client adapter
  -> Manager speech interface
  -> manager/speechControl.ts
  -> localSpeechClient adapter
  -> RabiSpeech Python implementation
```

`src/shared/speechControlContract.ts` is the stable camelCase interface between Manager and WebGUI and owns Route speech defaults. `ribiwebgui/src/speech/speechControlClient.ts` is the only frontend module that knows `/api/speech/*` paths and the `{ code, data }` envelope. `ribiwebgui/src/stores/speechStore.ts` owns the speech read model, commands, and shared event-stream lifecycle. RabiSpeech `/v1/events` is proxied by Manager `/api/speech/events`; microphone, playback, audio-stream, and persisted-record events update only their matching read models, while an SSE reconnect performs one snapshot recovery pass. No periodic status or record requests are used. `src/manager/speechControl.ts` owns Route policy, RabiSpeech payload mapping, and read-model normalization. `POST /api/speech/messages` waits for the gateway child process to report a real terminal outcome: `delivered` only after the Desktop owner's start/steer succeeds, `recorded` for a keyword-policy record-only result, and a 4xx/5xx response on failure. It does not wait for the Agent answer, Outbox, or TTS playback. Python snake_case and model-runtime details must not leak into Vue pages; RabiSpeech remains an independent loopback provider runtime rather than being merged into Manager. Local providers are the defaults. External API providers require explicit machine configuration, environment-variable secrets, and expose their boundary through `local_only` / `relay_safe` capabilities.

Model Management is a separate host control plane rather than Route state. `src/manager/speechModelManager.ts` reads only fixed aliases from `plugin-adapters/rabi-speech/model-catalog.json`, serializes repository-owned installer scripts, rejects browser-supplied repositories, URLs, and paths, and removes private absolute paths from responses. `src/shared/speechModelManagement.ts`, `ribiwebgui/src/pages/ModelManagementPage.vue`, and `ribiwebgui/src/speech/speechModelManagementClient.ts` own the shared read model, dialog content, and browser adapter. Speech Service loads the dialog on demand from its top-right action; it can still list and download weights while RabiSpeech is stopped. The legacy `/#/models` address redirects to Speech Service and is no longer a sidebar page. `GET /api/speech/model-management` returns environment, catalog, and task state; the two POST surfaces install the core environment or one allowlisted model and remain blocked by Manager read-only mode. `speech_model_management_changed` events refresh the dialog, with one catch-up snapshot on SSE reconnect and no periodic job polling. A downloaded weight set is not presented as inference, waveform, or real-device acceptance, and `runtime=isolated` remains a separate setup requirement.

`ribiwebgui/src/lazyRouteRecovery.ts` handles a long-open browser tab requesting an obsolete page chunk after WebGUI is rebuilt. After Vue Router confirms a dynamic-import or chunk-load failure, recovery preserves the page the user just selected and the existing `webgui_token`, then reloads once. A session-scoped marker prevents reload loops, and ordinary page errors do not trigger this path.

`src/manager/speechEventProxy.ts` owns the one-to-one lifetime between a Manager SSE client and its RabiSpeech upstream stream. When a browser or acceptance client disconnects, only that upstream fetch is aborted. The resulting `AbortError` is a normal terminal event consumed by the proxy rather than an unhandled Node stream error that can terminate Manager. A non-`text/event-stream` upstream fails closed before Manager writes SSE response headers, so stale Manager/WebGUI HTML can never impersonate an event stream.

Route `speechPushMode` is the delivery source of truth. `hot` enters the ordinary start/steer path after every completed ASR segment. `keyword` still records the segment but wakes the Agent only when the persona-owned `speechTriggerKeywords` matches. An empty keyword list never falls back to hot delivery.

Host-level waveform, five-stage pipeline, counters, runtime events, and recent transcripts live only in `SpeechHostMonitor` under **Speech Service → ASR**. A Route's **Message adapters → Speech endpoint** section displays only that Route's subscription policy: hot/persona-keyword delivery, persona TTS summary, host/persona responsibility guidance, Agent-reply autoplay, and the single-ASR broadcast explanation. It must not embed the host monitor again.

WebGUI localization is split by responsibility:

- `src/i18n/index.ts` owns the single locale state, browser preference, `<html lang>`, and locale-change event.
- `src/i18n/catalog.ts` contains manually reviewed English UI copy and dynamic-text rules.
- `src/i18n/domLocalizer.ts` applies registered copy to Vue/Vuetify DOM while skipping `data-no-i18n`, code, editable content, and input bodies.
- `src/components/LocaleSwitcher.vue` exposes the top-bar `中 / EN` control.
- `src/pages/ProjectDocsPage.vue` renders `docs/user-guide/*.md` with bilingual task navigation, full-text search, an on-page outline, and shareable `?page=` links. Deeper developer Markdown remains a separate repository source reached through links.

The `rabiroute:webgui:locale` local-storage value is only a browser-side UI preference, never a project save. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values must stay verbatim; dynamic user-data regions are marked with `data-no-i18n`.

LAN access follows the same ownership rule. `src/manager/globalConfig.ts` owns the persisted `webguiLan` truth, `src/manager/webguiLanAccess.ts` owns key generation, address classification, and authorization, and `controlPlaneRoutes.ts` only wires the HTTP gate plus `/api/webgui-access`. `ribiwebgui/src/managerApi.ts` captures the URL token, keeps the current-session credential, and adapts fetch/SSE. `webguiLanRedirect.ts` changes a loopback page to the preferred LAN origin only after Manager is actually listening on the LAN, preserving the current hash Route/page and a one-time URL token. `routeScopedNavigation.ts` centrally encodes Route configuration names into `#/routes/<Route>/overview|adapters|persona|knowledge|speech|runtime`, recognizes legacy short paths, and preserves the hash query. `App.vue` combines the sidebar Current Route with the current page type to own URL synchronization; individual pages consume that stable navigation contract instead of defining separate Route URL rules. `OverviewPage.vue` still renders Manager DTOs, derives current Route shortcuts, and submits commands; it owns no second access switch or key.

RabiLink remote WebGUI preserves the same frontend/local-Manager ownership boundary. Relay's `/manage/<account>/<RabiGUID>/` owns only the account session, selected PC, static build, and constrained proxy. Ordinary HTTP requests enter `webguiRequests`; PC-side `rabiLinkRelayRuntime.ts` forwards only allowed headers to loopback Manager and returns status, response headers, and a Base64 body. `Range` / `If-Range` plus `206` responses provide media byte access. Manager `/api/events` bypasses the one-shot queue: Runtime maintains one local SSE stream, parses events, posts them through `/worker/webgui-events`, and Relay's `webguiEventHub` publishes only to the matching account application and PC. The Relay login cookie, PC application token, and LAN `webgui_token` are neither forwarded nor reused across boundaries. Request/response Base64 and event JSON each have explicit size gates.

`desktop/tray-task-window/` is the optional PySide6/Qt local panel. It reads plans/memory/status and provides role conversation UI. Plan content and memory remain read-only, while Manager-declared approval steps can append feedback without advancing the plan. Desktop lifecycle uses the Manager shutdown endpoint.

The tray and RibiWebGUI use the same Manager backend. Manager first uses `roleKnowledgePresentation.ts` to derive plan view membership, display states, the shared status palette, approval capability, and shared ordering; both clients render the returned DTO, categories, palette, and order. Qt-free `DesktopRefreshService` calls `/gateways?summary=1`, `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar` through `ManagerClient`, then produces DTOs. Approval submissions use the same client's plan-feedback endpoint and wait through `qt_async`. The packaged tray does not import `PlanRepository` or `RoleContextRepository` and never reads `data/` directly. Business-free `qt_async` provides the generic thread-pool bridge; `tray_app` only composes UI, handles user events, and applies cached DTOs. Hidden panels request neither conversation/avatar data nor widget rebuilds, refresh application waits while the tray menu is visible, unchanged state does not rebuild menus or panels, and entries beyond five are created lazily. Windows does not register implicit `setContextMenu`; presentation-only `TrayMenuController` maps both left-click `Trigger` and right-click `Context` directly to non-blocking `QMenu.popup()` on the prewarmed menu, while double-click does not reopen it. Transient failures may retain a clearly stale snapshot, while a real Manager disconnect must clear live state.

Gateway summaries return only persona identity, path, avatar, a lightweight title extracted from the file prefix, and other presentation metadata; they neither read nor serialize full persona Markdown bodies. Full `/gateways` responses retain the preview details required by the persona page.

## Plugin adapters

Raw speech messages carry whole-utterance RMS and peak as PCM loudness facts from RabiSpeech through `SpeechIngressStore`, Route events, persona `voice-transcripts.jsonl`, and `conversation/current.jsonl`. These fields serve thresholds, quality checks, and diagnostics only; they never contribute to a host identity or “who is the user” decision, whose interpretation remains persona-owned. Disabling pre-roll does not change audio ownership: with `pre_roll_ms=0`, the first PCM block that triggers VAD still belongs to the current utterance.

External/companion adapters live under `plugin-adapters/` or `scripts/` when they are independently deployable. They communicate through documented Manager/Relay protocols and must not import private runtime data into public examples.

`plugin-adapters/rabi-speech/` is an independent loopback TTS/ASR provider service, not a message or handler adapter. Its registry can contain local workers, OpenAI-compatible APIs, and native DashScope APIs at the same time, while keeping local defaults and forbidding silent cloud fallback. `AudioTranscoder` is the finalized-audio preparation owner shared by every provider, persona TTS, and direct HTTP call. A WAV-only sample-rate change uses local NumPy + SoundFile resampling and does not depend on the host process PATH; cross-format conversion alone invokes explicitly configured or discoverable ffmpeg. Callers and individual providers must not maintain a second output-resampling rule. The benchmark pipeline records TTS generation, WAV output, ASR transcription, cold/load/warm timings, RTF, memory, error rates, and machine metadata; raw runtime artifacts remain ignored while the sanitized HTML report is copied through `ribiwebgui/public/reports/`. The local Manager serves `reports/` at its root, while RabiLink Relay serves the same build directory under the authenticated remote-PC prefix.

The live speech view belongs to the control plane. `src/manager/speechServiceStatus.ts` probes only a loopback RabiSpeech URL and removes private paths. `src/manager/speechRuntimeControl.ts` owns the WebGUI page-wide lifecycle command, serializes transitions, waits for real health after startup, and verifies Windows process ownership before stopping. `src/manager/speechControl.ts` then maps models, microphone state, playback, audio-stream selection, persistent speech records, and message commands to `speechControlContract` before the frontend speech store receives them. `GET /api/speech/status` supplies the normalized read model, while `POST /api/speech/runtime/start|stop` controls only this workspace's local runtime. The top-level WebGUI switch projects real online state; when it is off, the page renders no runtime parameters below the title, state, errors, and switch. Audio defaults to the local sound card. When LAN `remote_audio` is enabled, `remote_audio.py` treats an authenticated remote client strictly as a microphone/speaker: the client never owns VAD, segmentation, or models, and disconnect does not trigger silent local fallback. RabiSpeech persists the host playback volume and returns it with playback status; the WebGUI global-queue card updates that `0–100` value only through Manager. Each audio item freezes the value when playback starts, so an adjustment applies from the next item that begins playing; it does not belong to a Route or persona. The host microphone, ASR model, VAD, and segmentation settings also belong only to RabiSpeech and are edited on the Speech Service page through Manager. A Route speech-endpoint toggle is only the subscription source of truth. Manager receives each host transcript once and broadcasts it to every subscribed Route; each Route independently owns hot/persona-keyword delivery and reply-playback policy. Disabling one Route removes only that subscription, and Manager stops the microphone only after the final subscription is disabled. Persona `voice/voice-profile.json` is the single source of truth for TTS model, voice binding, language, speed, and speaking instructions; legacy Route TTS fields are read-only compatibility inputs. The page describes the current PC. The static benchmark describes only its named target machine, so the two must remain separate data sources.

RabiSpeech `speech_records.py` is the single truth source for ASR/TTS text records and follows FenneNote's date-based append pattern. `tts_audio_store.py` separately owns rebuildable finalized-audio caches: resolved persona output goes to `data/roles/<RoleId>/voice/cache/tts-audio/`, while non-persona direct calls use a private RabiSpeech fallback. Both default to a 24-hour per-file mtime window. The Manager read model allows only safe POSIX-style relative references, keeps a bare filename for legacy records, and omits absolute paths, parent traversal, and backslash paths. WebGUI embeds recent persistent bidirectional records in the ASR page and shows the relative cache reference plus expected expiry without turning it into a filesystem link or adding a separate meeting selection/export workflow. Passing the cache window does not change the text record, and raw ASR input audio is still not duplicated by default.

`speaker_profiles.py` owns host-wide person metadata and manual `recordId + speakerLabel` bindings; `speaker_recognition.py` separately owns local neural embeddings, confirmed multi-prototypes, and unknown clusters. Provider `0/1` labels never inherit through a long-lived microphone `sessionId` and no longer own voiceprint sample grouping. When one Provider label spans multiple disjoint time turns, the raw value remains in `speaker`, while the voiceprint layer creates per-turn `speakerLabel` values, extracts each embedding independently, and lets opaque clusters decide whether those turns contain the same or different voices. A wrong label therefore cannot concatenate different people into one sample, while genuinely repeated speech still converges to one voiceprint. The WebGUI dropdown corrects only the selected recording turn, while also marking that turn's embedding as a confirmed prototype. Later matches require sufficient effective speech, a high best score, and a best-versus-second margin; low-confidence audio remains unknown. Enrollment audio is not copied. Vectors stay in ignored `output/speaker-embeddings.json` and never enter public APIs. A present but unvalidated model can cluster and suggest only. Formal automatic assignment additionally requires `validated=true`, `real_person_private` dataset eligibility, complete dataset/policy/model SHA-256 proofs, and a passing target-engine gate; any missing or mismatched proof fails closed with `voiceprint.supported=false`. `scripts/speaker_model_probe.py` runs real inference in an isolated process. Production extraction uses an ONNX Runtime + kaldi-native-fbank 16 kHz / 80-bin / global-mean backend, avoiding the Windows sherpa native pipeline's format rejection of the official model. The embedding store separately bounds confirmed prototypes and unconfirmed samples and rejects low-RMS or materially cross-speaker-overlapping segments.

`src/speechIngressStore.ts` is RabiRoute's host-wide raw speech-message source of truth. RabiSpeech submits one stable record ID, capture start/completion/ingestion times, provider, model, language, duration, peak level, sample rate, channels, audio format, channel, stable source-device metadata, transient stream ID, complete speaker turns, and available word timing/confidence to Manager. `src/shared/speechTranscript.ts` is the common portable segment/word normalization entry for Python snake_case, HTTP responses, and persona ledgers, while `src/routing/speechIngressForwarding.ts` is the single field-mapping entry from a host raw record to a `speech/rabilink` Route event. Manager removes host person names, profile IDs, candidate-profile IDs, and verified-person flags, retaining only opaque voiceprint/cluster IDs, diarization labels, scores, decision evidence, and word timing before appending `data/speech/messages/YYYY-MM-DD.jsonl`. The same scrub runs when persona `conversation/current.jsonl` is written or read, so legacy rows cannot re-inject host identity judgments into persona context. Record-ID lookup and raw-message append share a cross-process lock, and daily Route-receipt appends are serialized, preventing duplicate replay rows or interleaved JSONL. ASR processing and logical endpoint selection are separate: the host microphone or an ordinary Rabi Voice Client emits `messageAdapterType=speech`; Android phone/glasses continuously transport ordered PCM through Relay, then emit `messageAdapterType=rabilink` only after host VAD, segmentation, ASR, and voiceprint processing. Android owns no second ASR/VAD truth source. Stable `sourceDeviceId` owns reply addressing; transient `sourceStreamId` identifies only the current PCM connection and never targets downlink. Sequences begin at 1 and remain contiguous, and Android advances only after PC acknowledgement. The pending chunk keeps a stable `chunkId` across transient stream rebuilds. For each stable `sourceDeviceId`, RabiSpeech retains the `chunkId + PCM SHA-256` of the last accepted chunk, storing identifiers and hashes only. A cross-stream retry after a lost ACK therefore does not enter VAD/ASR again, while subsequent new chunks continue under the rebuilt stream's sequence. Android's system connectivity callback and the existing RabiLink SSE `ready` event immediately wake pending PCM; only temporary service unavailability uses one-shot backoff. A bounded newest-audio buffer discards obsolete PCM during long outages so recovery catches the live stream instead of remaining permanently behind. `start` and each accepted chunk rearm one 15-second expiry event; only expiry retires the virtual client and restores the previous input, with no fixed-interval scan. Manager delivers only to Routes that enable the matching endpoint. `routeProfileId` is a generic Route selector, not a source-type marker; source identity comes from `routeKind/adapterType`, so mobile audio cannot become a role-panel event merely because it selects a profile. `forwarding.ts` still owns the Route-to-persona relationship, so different personas receive their own `voice-transcripts.jsonl` and `conversation/current.jsonl`, while multiple Routes sharing one persona do not duplicate the row. On a persona's first write, the canonical conversation ledger is initialized/appended before the compatibility raw-history file so the current event cannot be imported again as legacy history. Phone audio enters the Agent as `routeKind=rabilink`, and the reply API defaults to the originating `sourceDeviceId`. Each persona interprets who a voiceprint belongs to, who the user is, and whether to respond from its own relationships and context.

Mobile downlink follows the same ownership rule. Relay owns messages, explicit targets, and device receipts. The phone owns the cursor, reliable queues, local playback orchestration, durable message-restore intent, and the user's single requested `PAUSED / PHONE / GLASSES` mode; the foreground Service owns actual runtime mode, capture, and connection state; glasses own only peripheral state and the physical fact that their speaker reached completion. A transition releases the old capture path first, and capture stays paused before a real glasses connection event or after disconnect, never silently enabling two microphones. Activity rebuilds its runtime card from `RUNTIME_UPDATED` broadcasts rather than polling business state. Explicit proactivity is durably transported as a `rabilink.preference` observation and source metadata; neither App nor Relay owns the intervention rule. Phone-private text, control, media, receipt, and downlink queues share fsync plus atomic replacement. Startup removes temporary files and quarantines malformed JSON, missing binaries, and orphaned attachments with visible errors so one poison item cannot block later work. `/api/rabilink/events` `outbox_available` is a wake-up signal, after which Android performs one persisted-cursor delta query for gap recovery. While Android knows the device is offline, its SSE connection and reliable sender block on a Connectivity-callback event gate instead of reconnecting at a fixed interval. Only to cover a vendor missing an already registered callback, the foreground service checks current OS connectivity every five minutes while known offline, stops immediately after recovery, and returns to the SSE `ready → cursor` one-shot catch-up without querying Relay business state. Only an available network with a server failure uses one-shot 1–30 second backoff. Relay emits an SSE keepalive every 15 seconds; 45 seconds without any SSE bytes triggers a transport-stall deadline that rebuilds the half-open socket and returns to the same one-shot cursor catch-up without adding business polling. Restore intent is separate from continuous listening: a started text/media/downlink service restores its cursor and reliable queues after process or device restart, while explicit Stop clears that intent. An Outbox message with explicit `targetDeviceIds` does not TTL-expire until every explicit target returns `delivered`; broadcasts and kind-only targets retain bounded TTL behavior. `delivered` is not `played`: phone and glasses produce `played` only after their own `AudioTrack` marker, persist the receipt to a phone-private disk queue first, and replay it after reconnection. Relay only stores the fact and emits `outbox_receipt`. Glasses BEGIN, PCM, and END share one ordered Classic-BT channel so END cannot overtake audio. The playback worker waits until the main thread confirms capture is paused before accepting PCM, and Activity destruction reports unfinished playback as `playback_failed`; legacy unframed PCM may play for compatibility but cannot produce a success receipt.

`src/acceptance/speechIngressSeparation.ts` and `scripts/test-speech-ingress-separation.mjs` compose those boundaries into isolated built-artifact acceptance. In a temporary data root, the tool writes one PC-microphone record and one mobile record into the same host store and invokes the real `dist/index.js --speech-message` child process for each. It requires exactly two logical endpoints in the host store, one voice-history row and one canonical-conversation row for each of two different personas, no mobile target in the PC context, a mobile reply target derived only from stable `sourceDeviceId` rather than transient `sourceStreamId`, and no host person guess in persona files. Children use an isolated Agent adapter that opens no window or clipboard and never connect to the real Manager, Desktop, QQ, or Relay. The temporary root is removed at completion, leaving only sanitized counts, hashes, and terminal evidence.

`src/personaVoiceIdentities.ts` owns persona-scoped voice-relationship events. Host speech messages and AgentPacket provide only `sourceHostId/sourceHostName` plus opaque voiceprint evidence. Through `/api/roles/:roleId/voice-identities`, a persona appends its own `displayName/relationship/isUser/aliases/notes` to `voice/voice-identities.jsonl`. The identity key combines processing host and voiceprint ID so local cluster IDs cannot collide across PCs. Identical updates are not re-appended; corrections and deletions use new events or tombstones rather than creating a Manager-owned person source of truth. Each new event records its current heads through `supersedes`; concurrent PC branches remain present after JSONL union, the read model derives conflicting fields, and a later persona PUT explicitly converges every head instead of letting file order decide identity.

`src/personaVoiceTranscriptView.ts` is the read-only join for persona voice relationships, while `src/manager/personaVoiceTranscriptRoutes.ts` owns only the stable HTTP boundary. `GET /api/roles/:roleId/voice-transcripts` combines raw conversation-ledger voiceprint evidence with the current persona's relationships into per-segment `user/other/unknown/conflict` views at query time. It supports time, archive, and speaker filters and derives classified duration, coverage rate, and unresolved voiceprints from the complete filtered set; the detail `limit` does not truncate `matchedCount` or the summary. The layer writes no derived name, `isUser`, or statistics back to either source of truth.

RibiWebGUI reuses those two APIs through `personaVoiceIdentityClient.ts` and creates no browser-side voiceprint repository. The persona page's latest-24-hour panel requests `includeDetails=false`, receiving only the summary plus the separate relationship list and no transcript text. Loading, button-busy, error, and notice values are transient presentation state. `personaVoiceConfirmation.ts` stores only one user-initiated attempt's start time, the unresolved voiceprints' starting `lastSeenAt` baseline, waiting/found state, and candidate composite keys. Candidates are unresolved voiceprints with a stable host identity that appear or advance beyond that baseline after the next speech-record event; this changes ordering and markers only and never creates or persists an identity conclusion. The page queries once on entry, persona change, or an explicit user action, and listens for RabiSpeech `records_changed` plus Manager `persona_voice_identity_changed` and `persona_sync_manifest_changed` events. SSE reconnection performs one catch-up query rather than coverage polling.

`src/personaSync.ts` owns local persona reads, archives, merge behavior, and explicit conflict resolution. `src/personaSyncManifestIndex.ts` owns the rebuildable persistent manifest index, one startup reconciliation, and recursive runtime file events. Reconciliation reuses unchanged SHA-256 values through size, mtime, ctime, and file identity; a concrete file event rehashes only its path. Index changes emit `persona_sync_manifest_changed` through Manager SSE. Manifest queries read the index; only hosts without reliable file events reconcile once before a query, with no fixed-interval scan. `src/personaSyncCoordinator.ts` owns peer discovery, transport orchestration, and publication of resolved versions. `src/personaSyncAutoReconciler.ts` owns only event scheduling plus the durable `auto-sync-state.json` pending marker and duplicates no merge semantics. Local file changes, Relay `ready`, and `persona_sync_peer_changed` wake one coalesced full or persona-scoped Coordinator reconciliation. Offline peers wait for another event; temporary online failures use bounded one-shot backoff. `src/manager/personaSyncRoutes.ts` owns the constrained HTTP contract and exposes body-free diagnostics through loopback-only `index-status/auto-status`; `src/manager/personaSyncLanServer.ts` is a dedicated data-plane listener advertised on private IPv4 addresses. It permits only remote manifest, file, and merge operations and never exposes the full Manager/WebGUI control plane. The coordinator first tries this Relay-advertised LAN URL, then falls back to Relay `/api/rabilink/persona-sync/proxy`, which reuses the global worker to reach the target loopback Manager. Relay does not store a master persona. JSONL uses union merge, while ordinary files use common hashes scoped by the application-token hash and stable peer GUID for fast-forward. A one-sided absence with a known common baseline propagates as a deletion after archiving the removed file; concurrent delete-versus-edit carries `remoteDeleted`, peer, and baseline hash into `data/persona-sync/conflicts/`. The same persona, path, peer, remote hash, deletion state, and base hash map directly to a canonical `evidence-<sha256>` file. Automatic reconciliation therefore reuses evidence with one file lookup instead of synchronously traversing the legacy conflict directory; a changed identity or hash remains distinct evidence. Conflict listing scopes traversal to the requested persona, groups legacy timestamp copies by path, peer, and content evidence, and reads only one representative per group; its first catalog still uses asynchronous directory iteration and caches the result. Listing, reading evidence, and `keep_local/use_remote/use_merged` resolution are loopback-only; resolution checks the current local hash, `use_remote` confirms deletion for a deletion conflict, and evidence plus metadata for the duplicate group moves to `resolved-conflicts/` with audit records. The coordinator then uses the captured remote hash as the publication base and sends the resolved result back through LAN or Relay. If either endpoint changed, it returns `not_published`, retains new pending scope, and never claims convergence. Concurrent sync for one peer/persona is single-flight; files and baseline state use locks plus atomic writes. `conversation/` merges reuse the message-context lock, while voice transcripts and persona voice relationships reuse their own file locks, preventing synchronization replacement from interleaving with live appends. Reads and merges inspect the full parent chain and reject symbolic links or Windows junctions. Locks, the manifest index, temporary files, and rebuildable TTS caches are excluded from synchronization.

When Windows reports only a changed directory, the manifest index reconciles that subtree instead of the complete persona. The subtree refresh must still detect deleted files while preserving cached entries from unrelated directories. If Windows omits the changed path entirely, recursive watching stops and reports query-time reconciliation; an unknown path must not trigger repeated scans of every persona and stall Manager.

`ribiwebgui/src/components/PersonaSyncCard.vue` stores only rebuildable page loading, preview, button-busy, notice, and error state. Through `personaSyncClient.ts` it reads peers, index/automatic status, and conflicts, then submits explicit synchronization or basic resolution commands. Merge, deletion, conflict, retry, and convergence semantics remain backend-owned. The page performs one catch-up query on `persona_sync_manifest_changed`, `persona_sync_auto_status`, and Relay/LAN status events and defines no business polling loop.

`src/acceptance/personaSyncDualNode.ts` and `scripts/test-persona-sync-dual-node.mjs` exercise this orchestration with two temporary persona roots, the real Relay Server, a real target worker/Manager data plane, and the dedicated LAN listener. The first phase proves LAN-first JSONL/file/deletion/voice-semantic conflict behavior and resolution publication. Then only the reachable peer URL is removed to force the real Relay fallback. Evidence retains no token, port, persona, or file body. Relay stdout and worker SSE status events own readiness sequencing instead of service-status polling.

## Tests

Tests live beside source modules as `*.test.ts`. Routing tests verify pure decision and packet behavior; Outbox tests verify policy and platform sends; Manager/endpoint tests verify control-plane contracts and security boundaries.

## Common change entry points

| Change | Start here |
| --- | --- |
| New message source | `src/adapters/`, endpoint scan/manager module, shared config model, tests, bilingual docs. |
| New handler | handler adapter/registry, scan/status API, forwarding integration, tests. |
| Route semantics | `routing/routeDecision.ts` and tests. |
| Handler context | `routing/agentPacket.ts`, role knowledge, packet tests, context docs. |
| External reply | `outbox.ts`, adapter policy/config, sender tests, interface docs. |
| Manager API | `manager/controlPlaneRoutes.ts`, extracted domain helper, frontend client, tests. |
| Plan/memory/skills | `roleKnowledge.ts`, role API parser/control plane, validation tests. |
| WebGUI form | Vue page/component plus shared config schema and bilingual user docs. |

## Red lines

- Preserve router/handler separation.
- Keep `RouteDecision` free of role-memory and external side effects.
- Keep formal Codex delivery on Desktop IPC and the target task owner.
- Route external output through Outbox.
- Treat experimental integrations as experimental until real acceptance.
- Keep public examples credential-free and runtime data out of Git.
