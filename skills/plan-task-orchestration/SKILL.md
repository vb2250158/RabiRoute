---
name: plan-task-orchestration
description: Orchestrate RabiRoute formal plans and their unique Codex execution tasks. Use when Codex needs to create, deduplicate, resume, pause, audit, migrate, or complete a plan; bind or recover its taskBinding; consume a completion reminder or plan feedback; handle waiting or approval; or prevent duplicate plans, sessions, and task dispatches.
---

# Plan Task Orchestration

Use one RabiRoute plan as the lifecycle truth and one Codex task as that plan's execution context. Keep the mapping stable from investigation through acceptance.

## Read the current contracts

Before writing a plan or binding a task, read the relevant sections of:

- [Rabi Agent interfaces](../../docs/rabi-agent-interfaces.md) for the current Manager APIs and Codex thread bridge.
- [Plan and memory model](../../docs/plan-and-memory-model.md) for the current Plan schema, approval projection, feedback, task binding, and lifecycle rules.
- [Create RabiRoute Agent adapter](../create-rabiroute-agent-adapter/SKILL.md) when changing or diagnosing task discovery, Desktop ownership, thread creation, or delivery behavior.

Use the configured Manager base URL or an injected API URL. Do not guess a host or port. Prefer native Codex Desktop task tools when they are available; otherwise use `POST /api/agent/threads`. Never start a second Runtime as a fallback.

Write plans only through the Manager API. If Manager is unavailable, use direct role files only for read-only recovery and report that writes remain pending.

## Preserve the invariants

- Create a formal plan only for work that needs cross-turn execution, waiting, follow-up, or acceptance. Do not create one for chat or a one-turn answer.
- When a project-level policy says that any potentially mutating task requires a plan, perform plan admission before business investigation, design, implementation, or file writes. A strictly read-only task remains exempt only while it cannot produce or execute a project change.
- Give each plan one single-line `focus`, one coherent outcome, explicit acceptance criteria, and ordered `steps`.
- Bind exactly one independent business execution task to one plan. Do not bind a coordinator, reminder, or persona chat task.
- Keep `taskBinding.sessionId + workspace` as the stable identity. Treat `sessionTitle` as mutable display metadata.
- Treat the plan as the status truth, the bound task as the execution-history truth, and optional memory as recovery context. Never let one substitute for another.
- Allow only one control-plane writer per `planId`. Reread before PATCH and verify the returned plan after writing.
- Do not bulk-create tasks for old plans. Repair a binding only when that plan becomes active, relevant, or explicitly audited.
- Keep all execution, external action, approval, privacy, and sandbox boundaries in force. This skill grants no additional authority.
- Treat plan attachments as lifecycle evidence, not approval-only decoration. Preserve the most useful available source documents, screenshots, references, generated designs, implementation previews, test evidence, and acceptance artifacts in the plan whenever they materially help understanding, decision, execution, or verification.

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

### 2. Resolve the unique task binding

1. If `taskBinding` exists, read the exact task by its full `sessionId`.
2. Accept the binding only when the task exists, is not archived, and its canonical workspace matches `taskBinding.workspace`. Ignore title drift.
3. If the binding is missing, search Desktop tasks by project, outcome, deliverable, and acceptance criteria. Read plausible task histories from the initial request through the latest result.
4. Reuse a task only when its full history confirms the same plan scope. Stop for the smallest necessary clarification when multiple candidates remain genuinely ambiguous.
5. Create one task in the plan's project workspace only when no matching task exists. Put the plan ID, scope, current step, acceptance criteria, evidence, and authority boundaries in the initial prompt.
6. Persist the returned full task ID and canonical workspace in `taskBinding` immediately. If task creation succeeded but its initial turn failed, retry with `send` to that same ID; never create another task.

### 2.5 Maintain plan attachments

At plan creation and after each material stage, inventory the files already available to the task. Attach the files that materially support the current decision or acceptance, including source documents, user screenshots, reference art, diagrams, reports, generated art, design previews, recorded demonstrations, implementation screenshots, test reports, and final acceptance evidence.

- Inspect each attachment before adding it. Use readable names that distinguish source reference, candidate design, current implementation, and final acceptance.
- Prefer the smallest set that preserves the decision and acceptance record. When API count or size limits prevent attaching everything, keep the highest-value files and record the controlled location and omission reason in the plan.
- Never attach secrets, tokens, cookies, private conversations, player-private data, unrelated windows, or files outside the task's authority.
- Attachments supplement evidence. They do not replace source attribution, tests, revisions, package identity, delivery receipts, or QA results.
- On PATCH, preserve existing managed attachment objects unless an attachment is intentionally removed. Do not accidentally clear the list while adding a new stage artifact.

An archived, missing, or workspace-mismatched bound task fails closed. Do not silently replace it. Use the recovery procedure below.

### 3. Dispatch one actionable next step

Before every dispatch:

1. Reread the full plan, the bound task's current state and history, the latest feedback, and the evidence produced since the last turn.
2. Consume completed work and PATCH the plan before asking for more work.
3. Choose one concrete next action with an observable output and a pass/fail check. Update the current step, `currentStep`, `nextAction`, and `waitingFor` as applicable.
4. Send the instruction once to the exact `sessionId + workspace`.

Do not send a generic "continue". Include only the delta the task needs: the verified current state, the next action, its acceptance check, and any changed authority boundary.

For PangHu work in the formal Main checkout, an open or busy Unity Editor, another task's Unity test, an import, or a shared test queue is not a reason to stop the business task or defer all work. Keep the existing Editor running and do not cancel or replace another task's run. Continue implementation, narrow SVN updates and merges, static asset/Prefab/config checks, non-Unity runners, CLI checks, and other independent work in parallel. If the remaining Unity interaction cannot be run without disturbing the current Editor, record it as an explicit human/runtime acceptance item and continue the rest of the plan. Test availability must not become a global development lock.

### 4. Consume results and prove status

A created task, accepted dispatch, completed turn, command exit code, or produced draft is not plan completion.

After a task turn or completion-hook reminder:

1. Read the official task result and the artifacts or test evidence it cites.
2. Compare the evidence with the current step and plan acceptance criteria.
3. Mark a step `已完成` only when its own check passes. Then select the next step as the single `进行中` step.
4. PATCH the plan's real progress, output references, waiting state, and next action.
5. Add or update the material stage attachments, or record why no useful attachment exists.
6. Reread the plan and task state before deciding whether another dispatch is required.

Completion reminders are deduplicated by `sessionId + turnId`, but they do not update the plan automatically. Consume each result once.

### 5. Handle waiting, feedback, and approval

- Keep ordinary waits, failures, QA, missing data, and external results under `status=进行中`. Put the responsible party or condition in the current step's `waitingFor`, then pursue an authorized clarification, retry, alternative, escalation, or evidence-gathering action.
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
- Treat guidance and approval feedback as input, not an automatic state transition. Read the plan and feedback, PATCH the same plan, then write the matching Agent response record once.
- If no authorized outbound channel exists, prepare the exact question or draft and request authority instead of claiming that a person was contacted.

### 6. Pause, resume, and close

- Pause only after an explicit user, owner, or policy instruction. Keep the current `进行中` step and `currentStepId` as the recovery point, and stop task dispatches.
- Resume by PATCHing only the top-level status back to `进行中`, rereading the recovery point, and continuing the original bound task.
- Mark the plan `已完成` only after every acceptance criterion has evidence. Keep failed validation in the same plan and task.
- For bulk cleanup, migration, or synchronization, record a `completionCoverage` evidence block with `baselineTotal`, `processed`, `deleted`, `alreadyAbsent`, `retained`, `blocked`, and `remaining`. Before completion, verify `processed + remaining = baselineTotal` and `deleted + alreadyAbsent + retained + blocked = processed`; `remaining`, `retained`, and `blocked` must all be zero. A clean working copy, a commit revision, or a few exact paths only proves that level. A screenshot, later message, or temporary path list that narrows work must be recorded as `仅完成子范围`; keep the original plan active or split an independent subgoal. Without `baselineTotal`, report `目标清单待恢复`, not plan completion.
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
- Manager writes were reread successfully;
- no private role data, runtime logs, tokens, or relationship/persona content entered this project-level skill or public examples.
