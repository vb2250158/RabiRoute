---
name: plan-task-orchestration
description: Use before any PangHu project change or any repository task governed by RabiRoute plan admission, including bug fixes, features, UI, assets, config, data, docs, prompts, skills, builds, deployments, and external writes; also use to create, deduplicate, bind, resume, audit, migrate, or complete a formal plan. Drive the unique bound task through 调查中 → 信息不足/待审批 → 执行中 → 待验收 with evidence, owner-feedback rollback, parallel work, and no duplicate dispatches. Do not use for strictly read-only investigation that will not produce or execute a change.
---

# Plan Task Orchestration

Use one RabiRoute plan as the lifecycle truth and one Codex task as that plan's execution context. Keep the mapping stable from investigation through acceptance.

## Read the current contracts

Before writing a plan or binding a task, read the relevant sections of:

- [Rabi Agent interfaces](../../docs/rabi-agent-interfaces.md) for the current Manager APIs and Codex thread bridge.
- [Plan and memory model](../../docs/plan-and-memory-model.md) for the current Plan schema, approval projection, feedback, task binding, and lifecycle rules.
- [Create RabiRoute Agent adapter](../create-rabiroute-agent-adapter/SKILL.md) when changing or diagnosing task discovery, Desktop ownership, thread creation, or delivery behavior.

Resolve the current Manager generation before every plan read or write. Installed mode obtains `managerBaseUrl`, `applicationGenerationId`, and `managerInstanceId` from `RabiRouteHost.exe --command status --json`; source mode uses only the Manager's freshly printed structured READY URL. Validate the address and identities against `/meta`, and rediscover after a restart instead of retaining the old URL. Prefer native Codex Desktop task tools for task ownership when they are available; otherwise call `POST /api/agent/threads` through the same validated Manager address.

## Handle Manager availability without blocking project work

1. Resolve the current generation endpoint before the first Manager call. A previous URL refusing connections means that URL is stale; rediscover it before classifying Manager availability.
2. Treat `401 + WEBGUI_TOKEN_REQUIRED` as an authentication case and follow the project credential rule. After current-generation discovery, treat connection refusal, timeout, DNS failure, HTTP `5xx`, an unhealthy `/meta`, or an identity mismatch as an availability failure.
3. The installed application's sole lifecycle owner is `RabiRouteHost.exe`. Do not scan ports, read retired endpoint lock files, launch Manager directly, terminate Host/Manager/tray processes, or start a second Runtime. Host owns same-generation recovery. Source mode without an injected or freshly printed READY URL also fails closed instead of guessing an endpoint.
4. Search only bounded source candidates for read-only recovery evidence: an injected or configured RabiRoute root, the documented sibling project path, and an explicit project path. Never scan arbitrary drives for a checkout.
5. If Manager remains unavailable, use direct role files only for read-only semantic deduplication and recovery. Do not write role files, create placeholder plans, or dispatch tasks through files.
6. When discovery or recovery evidence remains insufficient, use the governing project's versioned offline plan-adjustment queue before continuing authorized project work. For PangHu, create or update one validated JSON record under `RabiPlanCache/pending/`; record the full task session, intended plan change, acceptance criteria, changed SVN-relative files, validations, revisions, and remaining work. Commit the cache with the related project change. Never store credentials, player privacy, private messages, or full logs.
7. Treat the offline cache as a synchronization queue, not plan truth. Manager plan writes and task delivery remain unavailable evidence, not a business-work blocker. If the cache tool itself cannot be repaired, record that failure once and continue the authorized work.
8. When Manager returns, rediscover and validate its current generation before processing pending records oldest first. Semantically deduplicate by outcome, scope, and acceptance criteria, create or update the real plan through Manager, reread it, then mark the cache `synced` only with the real `planId` and sync session. Commit that receipt. If Manager does not return, leave the record pending and report only the actual Rabi state.

## Preserve the invariants

- Create a formal plan only for work that needs cross-turn execution, waiting, follow-up, or acceptance. Do not create one for chat or a one-turn answer.
- When a project-level policy says that any potentially mutating task requires a plan, perform plan admission before business investigation, design, implementation, or file writes while Manager is available. During a verified availability failure, follow the fallback above and continue the authorized project work. A strictly read-only task remains exempt only while it cannot produce or execute a project change.
- Give each plan one single-line `focus`, one coherent outcome, explicit acceptance criteria, and ordered `steps`.
- Bind exactly one independent business execution task to one plan. Do not bind a coordinator, reminder, or persona chat task.
- Keep `taskBinding.sessionId + workspace` as the stable identity. Treat `sessionTitle` as mutable display metadata.
- Treat the plan as the status truth, the bound task as the execution-history truth, and optional memory as recovery context. Never let one substitute for another.
- Allow only one control-plane writer per `planId`. Reread before PATCH and verify the returned plan after writing.
- Do not bulk-create tasks for old plans. Repair a binding only when that plan becomes active, relevant, or explicitly audited.
- Keep all execution, external action, approval, privacy, and sandbox boundaries in force. This skill grants no additional authority.
- Treat plan attachments as lifecycle evidence, not approval-only decoration. Preserve the most useful available source documents, screenshots, references, generated designs, implementation previews, test evidence, and acceptance artifacts in the plan whenever they materially help understanding, decision, execution, or verification.

## Keep the control loop efficient

- In one orchestration turn, consume all currently available results and feedback, make one coherent plan update, and dispatch the next authorized work package when the bound task is idle. Do not stop after metadata repair, status narration, or a plan PATCH while executable work remains.
- Batch independent Manager reads, plan summaries, candidate details, task-state checks, feedback reads, and evidence checks. Run disjoint read-only or validation work in parallel when the available tools support it; keep dependent writes and irreversible actions ordered.
- Reuse verified facts and record consumption checkpoints such as `sessionId + turnId`, feedback IDs, plan revision, and evidence references. Read the full history again only for first binding, changed scope, conflicting evidence, recovery, or an explicit audit. Normal continuation reads the current plan and only the unconsumed delta.
- Prefer the largest safe work package that can run without another decision. A package may contain several ordered actions, files, checks, and independent subchecks when they serve the same current-step outcome. Do not create a new dispatch for each command, file, test, or plan-field update.
- Stop the loop only for terminal acceptance, explicit pause or cancellation, a still-running task or long process, a complete pending approval, a genuine external result with no authorized local action, or an authority boundary. Tool count, elapsed time, one failed attempt, and a successful status update are not stop conditions.

## Run the orchestration workflow

### 1. Deduplicate the plan

1. Page through plan summaries with `GET /api/roles/:roleId/plans`, including enough active and recent terminal records to find the target.
2. Select candidates using the goal, project/workspace, deliverables, scope, acceptance criteria, and stable keywords.
3. Read every plausible candidate in full with `GET /api/roles/:roleId/plans/:planId`.
4. Reuse the existing `planId` when the intended outcome, scope, and acceptance criteria match. Do not merge plans merely because their titles or keywords overlap.
5. Create a new plan only when no candidate represents the same commitment. Split independent outcomes into child or sibling plans, each with its own task binding.
6. If the matching plan is bound to another valid business task, stop business work in the current task and deliver only the new user requirements, evidence, attachments, and acceptance changes to that exact binding. Do not run a second investigation or implementation in parallel.

When creating or repairing a plan, use only the supported top-level lifecycle states:

`未开始 → 进行中 → 暂停 → 已完成 → 已归档`

Maintain exactly one `进行中` step for an active or paused plan and point `currentStepId` to it.

### 2. Design the executable step path

Before binding or dispatching work, classify the plan's actual phase from the latest plan, bound-task history, feedback, and evidence. Do not infer the phase from the title, an old local note, or a generic lifecycle status.

1. If the plan already has a `进行中` step, treat it as the highest-priority work item. Finish it, revise it, or explicitly replace it before starting an untouched later step. Do not skip claimed work merely because a newer request looks easier.
2. For a single change item, keep the visible path to the canonical milestones: `调查中`, optional `信息不足`, `待审批` when owner approval is required, `执行中`, and `待验收`. Put evidence collection inside investigation; put implementation review, tests, synchronization, submission, and readback inside execution; put package and QA mechanics inside the acceptance path only when required. Do not create separate visible steps for every control-plane read, command, file, test, attachment update, or status write.
3. Give every step one observable outcome. Its title and `detail` should make the following recoverable: entry evidence, concrete action, expected artifact or state change, pass/fail check, and failure route. Put a real external dependency in `waitingFor`; put a real decision gate in `approvalRequest`. Do not use titles such as `继续处理`, `推进任务`, `等待环境`, or `验证一下` without the object and success condition.
4. Keep steps coarse enough to represent business state, not Agent activity. Combine all actions that must succeed for one state transition into the same step. Split different features, bugs, pages, or independently accepted outcomes into separate plans rather than adding unrelated steps to one plan.
5. Use `未开始 → 进行中 → 已完成` as the normal step transition. Reopen a completed step only when later evidence invalidates its check, QA fails, or the user changes the accepted contract; record the reason and update downstream steps affected by that change.
6. Before dispatching a newly selected step, PATCH the same plan so exactly that step is `进行中`, update `currentStepId`, `currentStep`, `nextAction`, and `waitingFor`, then reread the Manager result. If the write or readback fails, do not dispatch. This is the claim boundary that prevents two tasks or turns from starting the same work.
7. If the current step is no longer executable, do not leave it indefinitely as generic `进行中`. Revise it into a concrete clarification, approval, dependency, recovery, or evidence step; update later steps to match the new facts. If the new outcome is independently acceptable, split it into another plan.
8. When guidance, approval feedback, QA failure, or new source evidence arrives, consume every unhandled item that affects the plan, update the remaining step path first, and only then continue the bound task. Preserve feedback and prior evidence as audit history instead of overwriting why the path changed.

Borrow execution mechanics from specialized workflows without copying their external table columns. For a single change item, expose the canonical workflow labels below through the current step; keep top-level plan status within the supported lifecycle values.

### 3. Use one canonical change-state machine

Use this state machine for a bug, requested modification, document change, UI change, configuration change, or other single item that needs investigation, owner approval, implementation, and acceptance:

`调查中 → 信息不足 → 调查中`

`调查中 → 待审批 → 执行中 → 待验收 → 已完成`

`待审批 --负责人要求修改--> 调查中`

`待验收 --验收失败--> 调查中`

Keep top-level `status=进行中` until acceptance passes. Record the machine-readable phase on the current step: investigation, information gathering, solution design, and approval preparation use `workPhase=analysis`; implementation and development validation after approval or explicit direct authorization use `workPhase=execution`. Manager turns those two values into the public `分析中` and `执行中` statuses. `信息不足`、`待审批`、`待验收` remain precise workflow steps or Manager-derived special statuses, not new top-level lifecycle values. Prefix the current step title with the applicable workflow label so the user sees `调查中：<对象>`, `信息不足：<对象>`, `待审批：<对象>`, `执行中：<对象>`, or `待验收：<对象>` rather than an internal activity name.

When an external collaboration source explicitly marks the item as waiting for discussion, keep top-level `status=暂停`, preserve `currentStepId` and its single in-progress resume step, and set `discussionState=pending` on that step. Manager derives the public `待讨论` presentation. Clear the marker when discussion ends before resuming or moving to another lifecycle state. Do not write `待讨论` as a top-level status and do not infer it from titles, detail, `waitingFor`, or generic paused plans.

Reserve `qa-*` and `verify-*` step IDs for actual target-package QA or acceptance. Use `audit-*`, `review-*`, `validate-*`, or another concrete non-QA prefix for developer checks, policy audits, prompt validation, compilation, and static verification; otherwise Manager presentation may incorrectly show `等待 QA`.

#### 调查中

- Set the current step to `workPhase=analysis`.
- Collect the relevant source, code, configuration, Prefab, runtime, screenshot, log, history, and owner evidence in the largest safe batch.
- Before leaving investigation, write a reviewable conclusion containing: the observed problem and scope, evidence, root cause or decision reason, exact files/components/configuration to change, concrete changes, impact and out-of-scope items, and validation method.
- Do not enter approval merely because investigation started, an Agent has a guess, or someone must answer a question. Approval is only for a complete proposed change.

#### 信息不足

- Keep the current step at `workPhase=analysis`.
- Enter `信息不足` when a load-bearing fact is missing and the Agent cannot produce a defensible cause plus concrete change proposal.
- Set the current step ID to `information-needed-*`. In `detail`, list what is already known, why it is insufficient, and which conclusion cannot yet be made. In `waitingFor`, name the responsible person or source and the exact questions, screenshots, reproduction steps, configuration IDs, logs, decisions, or other evidence required.
- Clear any stale `approvalRequest`. Information collection is not approval.
- Continue every authorized independent investigation while waiting. When the requested information arrives, complete the information step and create or reopen an `investigate-*` step before drafting approval.

#### 待审批

- Keep the approval step at `workPhase=analysis`; Manager's complete pending approval contract overrides it with the public `待审批` status.
- Enter `待审批` only after investigation produced a complete review package. The current `approve-*` step must carry a complete `approvalRequest`, and the plan must already state the cause, exact changes, affected files/components/configuration, impact, validation, rollback, and exclusions.
- If any of those items is missing, remove the incomplete approval contract and return to `调查中` or `信息不足`. Do not leave a plan in pending approval with only a title, generic request, or unexplained waiting text.
- An approval request asks the responsible owner to approve or revise the written proposal. It must not ask the owner to perform the Agent's investigation or invent the change plan.
- On approval, complete the approval decision step, select `implement-*` with `workPhase=execution`, and dispatch implementation in the same orchestration turn.
- When the owner adds a correction, objection, or note, record that approval decision, preserve the feedback, and create `investigate-revision-*` as the single current step. Recheck the evidence and rewrite the proposal before requesting approval again; do not keep the rejected proposal in `待审批`.

#### 执行中与待验收

- `执行中` starts only from an approved proposal or an explicit user instruction that already authorizes the same concrete change. Bind the implementation package to that approved cause, change list, scope, and validation method.
- Every current implementation or development-validation step must carry `workPhase=execution`; do not rely on its title to classify the plan.
- After implementation, Agent-owned review, required tests, applicable synchronization/submission, and conflict-free readback pass, leave `执行中`. Do not send the item back to approval merely because implementation finished.
- Move to the applicable acceptance path: use `manual-verify-*` for direct owner acceptance, or the existing package and `qa-*` / `verify-*` steps when a target package is required. These are mechanical substeps of `待验收`; do not invent extra status names between implementation and acceptance.
- On acceptance failure, preserve the failure evidence and return to `investigate-revision-*` with `workPhase=analysis`. Re-establish the cause and proposal before another implementation attempt.
- Complete the plan only when the acceptance result passes and every required delivery step has evidence.

When opening or reconciling an existing plan, repair state drift before dispatch: incomplete approval becomes `调查中` or `信息不足`; implemented work becomes the applicable `待验收` path; rejected approval or failed acceptance returns to investigation. Perform the repair and the next authorized action in the same orchestration turn.

### 4. Resolve the unique task binding

1. If `taskBinding` exists, read the exact task by its full `sessionId`.
2. Accept the binding only when the task exists, is not archived, and its canonical workspace matches `taskBinding.workspace`. Ignore title drift.
3. If the binding is missing, search Desktop tasks by project, outcome, deliverable, and acceptance criteria. Read plausible task histories from the initial request through the latest result.
4. Reuse a task only when its full history confirms the same plan scope. Stop for the smallest necessary clarification when multiple candidates remain genuinely ambiguous.
5. Create one task in the plan's project workspace only when no matching task exists. Put the plan ID, scope, current step, acceptance criteria, evidence, and authority boundaries in the initial prompt.
6. Persist the returned full task ID and canonical workspace in `taskBinding` immediately. If task creation succeeded but its initial turn failed, retry with `send` to that same ID; never create another task.

### 5. Maintain plan attachments

At plan creation and after each material stage, inventory the files already available to the task. Attach the files that materially support the current decision or acceptance, including source documents, user screenshots, reference art, diagrams, reports, generated art, design previews, recorded demonstrations, implementation screenshots, test reports, and final acceptance evidence.

- Inspect each attachment before adding it. Use readable names that distinguish source reference, candidate design, current implementation, and final acceptance.
- Prefer the smallest set that preserves the decision and acceptance record. When API count or size limits prevent attaching everything, keep the highest-value files and record the controlled location and omission reason in the plan.
- Never attach secrets, tokens, cookies, private conversations, player-private data, unrelated windows, or files outside the task's authority.
- Attachments supplement evidence. They do not replace source attribution, tests, revisions, package identity, delivery receipts, or QA results.
- On PATCH, preserve existing managed attachment objects unless an attachment is intentionally removed. Do not accidentally clear the list while adding a new stage artifact.

An archived, missing, or workspace-mismatched bound task fails closed. Do not silently replace it. Use the recovery procedure below.

### 6. Dispatch the largest safe work package

Before every dispatch:

1. Read the current plan, bound-task state, every unconsumed task result, new feedback, and new evidence. Read the full task history only when the binding or scope is unverified, evidence conflicts, or recovery requires it.
2. Consume all available completed work in one pass and PATCH the plan once before asking for more work. Do not issue separate writes for narration, intermediate commands, or unchanged fields.
3. Build the largest safe work package that can complete the current step without another decision. Include all ordered actions, files, checks, expected outputs, pass/fail conditions, and explicit stop conditions needed for that outcome; do not reduce the package to one command or one tiny action.
4. Batch independent reads, queries, and validation targets. Parallelize disjoint subtasks only when the bound task's tools, policy, and write ownership allow it; keep dependent mutations ordered and preserve one business task per plan.
5. Send the package once to the exact `sessionId + workspace`. Instruct the bound task to continue through the package until the current-step check passes or a real stop condition is reached.

Do not send a generic "continue". Include only the delta the task needs: the verified checkpoint, remaining package, acceptance check, and changed authority or stop boundary.

For PangHu work in the formal Main checkout, an open or busy Unity Editor, another task's Unity test, an import, or a shared test queue is not a reason to stop the business task or defer all work. Keep the existing Editor running and do not cancel or replace another task's run. Continue implementation, narrow SVN updates and merges, static asset/Prefab/config checks, non-Unity runners, CLI checks, and other independent work in parallel. If the remaining Unity interaction cannot be run without disturbing the current Editor, record it as an explicit human/runtime acceptance item and continue the rest of the plan. Test availability must not become a global development lock.

### 7. Consume results and prove status

A created task, accepted dispatch, completed turn, command exit code, or produced draft is not plan completion.

After a task turn or completion-hook reminder:

1. Read every unconsumed official result together with the artifacts or test evidence it cites.
2. Compare the combined evidence with the current step and plan acceptance criteria.
3. Mark a step `已完成` only when its own check passes. Then select the next step as the single `进行中` step.
4. PATCH the plan once with real progress, output references, waiting state, next action, and the latest consumption checkpoint.
5. Add or update the material stage attachments, or record why no useful attachment exists.
6. Reread the returned plan and current task state. If the task is idle and the next step is authorized and actionable, dispatch its work package in the same orchestration turn. Do not wait for another reminder or user message merely because the previous step completed.
7. If validation fails, keep the same plan and task, revise the current step or package from the failure evidence, and retry with a changed method. Do not return to broad discovery or stop at the failure report while a local recovery remains.

Completion reminders are deduplicated by `sessionId + turnId`, but they do not update the plan automatically. Consume each result once.

### 8. Handle waiting, feedback, and approval

- Keep nonterminal work under top-level `status=进行中`, but use the canonical current-step state. Missing load-bearing data becomes `information-needed-*` with exact `waitingFor`; a complete proposal becomes `approve-*`; implementation completion enters the applicable acceptance path. Do not collapse all waits and failures into an unexplained generic step.
- Do not put a PangHu plan into a wait-only state merely because Main Unity is open, importing, running another test, unavailable through MCP, or shared by another task. Remove that condition from `waitingFor` when independent implementation or verification remains. Dispatch the original bound task to continue in formal Main without stopping the Editor; prefer static resource contracts, direct serialization checks, non-Unity runners, and CLI validation. Leave only the specific runtime interaction for human or later Unity acceptance when it cannot run concurrently.
- For PangHu plans whose business implementation is already authorized, treat routine Main/Release/Art synchronization and SVN submission inside the verified plan scope as an actionable delivery step, not a new approval gate. When source, direction, files, dependency closure, ownership, and conflict-free status are verified, remove stale sync-only `approvalRequest` / `waitingFor` text and dispatch the original bound task to update, merge, synchronize, submit, and read back. Stop only for an explicit read-only or no-submit instruction, unresolved ownership, semantic conflict, extra files, scope expansion, frozen-build changes, production, upload, publish, or external delivery.
- A lifecycle audit correction is incomplete if it only rewrites `steps`, `currentStep`, or `nextAction`. When synchronization, submission, or conflict-free readback is still missing and the bound task is idle, write an executable delivery-closure step, clear evidence-request wording from `waitingFor`, and dispatch that original task in the same orchestration turn. Do not stop after correcting structured fields or ask the task to merely report what another actor should execute. “Do not expand business scope” excludes extra files and new semantics; it does not exclude synchronization, SVN submission, or readback already required by the approved plan.
- Store only supported top-level plan statuses: `未开始`, `进行中`, `暂停`, `已完成`, or `已归档`. A PangHu plan presented as waiting for a package or QA keeps top-level `status=进行中`; Manager derives those presentation states from the current structured step and evidence. Never write `等待打包` or `等待 QA 验收` into top-level `status`.
- A delivery-closure dispatch must require the bound task to write revision, exact changed paths, and the machine-readable sentence `无文本/属性/树冲突或 obstruction，svn status --show-updates 无 *`. Generic text such as “已回读”, “无目标 diff”, or “无远端更新” is not enough.
- PangHu Main Unity Editor is continuously user-owned. Every renamed wait for a test environment, Unity, Editor, MCP, runner, import, compilation, PlayMode, GameView, shared tests, or a test slot is actionable rather than a valid waiting stage. Keep the existing Editor running and dispatch all independent implementation, static/CLI/non-Unity tests, synchronization, submission, and readback; after that delivery closure, enter package waiting. Put UI, Prefab, Scene, serialized-reference, Unity-lifecycle, and real-interaction checks in target-package QA: immediately visible checks go to the user, ordinary repeatable checks go to QA, and difficult checks go to QA first and reach the user only if QA explicitly cannot cover them. Compilation or `matched=0` is never acceptance evidence.
- QA tests only the already-built target package. Write human-executable instructions that identify the page, button, and visible visual or numeric result. Never ask QA to inspect logs, SVN revisions, hashes, fields, static contracts, or to run callback/validation tools; keep those as development-side package-entry evidence.
- Do not write `isBlocked`. It is a Manager-derived compatibility projection, not an Agent input or state truth. `blockedBy` is explanatory text only.
- For an approval, authorization, or decision gate, PATCH a complete current-step `approvalRequest` with the approver, concrete request, recommendation, alternatives, reason, affected files/commands/changes, validation, rollback, out-of-scope items, request source, and `responseStatus=pending`. At least one of files, commands, or changes must be concrete.
- Treat `presentation.approval.state=ready` and `enabled=true` as proof that the approval contract is submit-ready. While it is pending, do not dispatch implementation beyond the approved contract; continue only authorized clarification and evidence work.
- Treat guidance and approval feedback as evidence that requires an Agent decision and explicit PATCH, not a Manager-side automatic transition. A correction, objection, or rejected proposal returns the same item to `investigate-revision-*`; an approval advances it to `implement-*` in the same orchestration turn. Then write the matching Agent response record once.
- If no authorized outbound channel exists, prepare the exact question or draft and request authority instead of claiming that a person was contacted.

### 9. Pause, resume, and close

- Pause only after an explicit user, owner, or policy instruction. Keep the current `进行中` step and `currentStepId` as the recovery point, and stop task dispatches.
- Resume by PATCHing only the top-level status back to `进行中`, rereading the recovery point, and continuing the original bound task.
- Mark the plan `已完成` only after every acceptance criterion has evidence. Keep failed validation in the same plan and task.
- For bulk cleanup, migration, or synchronization, record a `completionCoverage` evidence block with `baselineTotal`, `processed`, `deleted`, `alreadyAbsent`, `retained`, `blocked`, and `remaining`. Before completion, verify `processed + remaining = baselineTotal` and `deleted + alreadyAbsent + retained + blocked = processed`; `remaining`, `retained`, and `blocked` must all be zero. A conflict-free SVN status, a commit revision, or a few exact paths only proves that level. A screenshot, later message, or temporary path list that narrows work must be recorded as `仅完成子范围`; keep the original plan active or split an independent subgoal. Without `baselineTotal`, report `目标清单待恢复`, not plan completion.
- Close or replace a plan only for explicit cancellation, confirmed invalidity, or a recorded successor. Preserve the old/new mapping and reason when a successor takes over.

## Prevent duplicate delivery

| Observed state | Required action |
| --- | --- |
| Bound task is `active` or `in-progress` | Do not resend the same next action. Observe or wait for the turn result. |
| Bound task is idle and the plan has an authorized actionable step | Send one precise next action, then verify acceptance. |
| Delivery is `uncertain` or `sent_unverified` | Preserve the uncertainty and inspect task history/status; do not auto-resend. |
| Task was created but its initial turn failed | Save the returned ID and retry that same task with `send`. |
| The same plan is mentioned again | Reuse its `planId` and bound task after rereading both. |
| A completion reminder repeats | Consume the `sessionId + turnId` result once; do not create work from the duplicate. |
| The plan is paused or has a pending ready approval | Do not dispatch implementation. |
| The bound task is archived, absent, or in another workspace | Fail closed and perform controlled recovery. |

Only steer an active task when genuinely new user input must alter the running turn and the owner interface explicitly supports steering. Never use steering as a heartbeat.

## Recover or migrate a binding

1. Recheck the exact task ID, archived state, workspace, Desktop owner availability, and latest task history.
2. Retry loading the same owner when the task exists but is temporarily unavailable. Do not use CLI, isolated app-server execution, or another Runtime.
3. If the task is genuinely unrecoverable, collect the old task ID, last verified result, incomplete work, current plan step, acceptance criteria, authority limits, and recovery reason.
4. Create at most one replacement task in the same canonical workspace, hand over that evidence, and PATCH the plan with the old/new IDs and migration reason.
5. Verify the new binding by exact ID before dispatching additional work.

Do not change a valid binding merely to rename, repartition a coordinator, clear a pause, or react to a stale display title.

## Finish with an audit

Before reporting completion, verify:

- no duplicate plan represents the same commitment;
- the plan has one focus and one valid current step pointer;
- exactly one business task is bound by full ID and workspace;
- no identical instruction was dispatched twice;
- waits and approvals match Manager-derived presentation;
- every completed step and terminal state has acceptance evidence;
- useful source, design, implementation, test, and acceptance files are attached or have a recorded omission reason;
- Manager writes were reread successfully when Manager was available; otherwise the availability failure and any read-only local recovery were recorded without blocking project completion;
- no private role data, runtime logs, tokens, or relationship/persona content entered this project-level skill or public examples.
