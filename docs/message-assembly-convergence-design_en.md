> Historical task material, reviewed on 2026-11-14. The current C workspace and installed Host are 0.15.2 (`dcfb8a42`). This document preserves its original task-stage content. Version references, line numbers and completion markers retain their original context. Verify current behavior against the [code architecture](code-architecture_en.md), [Agent integration requirements](agent-adapter-standard-requirements_en.md) and formal acceptance evidence.

[中文](message-assembly-convergence-design.md)

# Message assembly convergence design (O4, not implemented)

This batch changes neither `contextDetail`, route configuration nor `messageGroupPrompt`. See the [execution plan](agent-delivery-optimization-plan.md) and [assembly architecture](message-assembly-architecture.md).

## Scope

Replace three inline compositions with one ordered section registry. Existing owners supply facts, routing and reply state; rendering performs no additional queries. Message Agent scheduling, merging and receipts remain separate, sharing only content sections.

## Section registry

| Order / section | compact | full | Message Agent | Enable when |
| --- | --- | --- | --- | --- |
| 1 Original content | Required | Required | Required | Render exactly once, preserving original text |
| 2 Situation and message identity | Required | Required | Required | Emit available IDs, references and group IDs; missing identity does not block delivery |
| 3 Recent / focused conversation | Bounded summary | Within full budget | Group scope | Respect history limits; zero reads no history; exclude current group |
| 4 Attachments | Conditional | Conditional | Conditional | Preserve availability and source IDs |
| 5 Message codes and quoted content | Conditional | Conditional | Conditional | Evidence exists in the original message; never infer missing references |
| 6 Identity and situation | Summary | Detail | By responsibility | Available from the local role or authenticated source; preview performs no writes |
| 7 Persona, plans, memories, skills | Links and required reads | Detail and required reads | By responsibility | Preserve required reads and remote source ownership |
| 8 Specialized tasks | Conditional | Conditional | Conditional | Actual feedback, consolidation, mobile configuration or companion event |
| 9 Tools, devices, diagnostics | Relevant links | Detail | Relevant links | Required by the event and target capability |
| 10 Reply and scheduling control | Existing contract | Existing contract | Existing scheduling contract | Supplied by existing owner, never removed by budgeting |

The envelope wraps content exactly once outside the registry. Preserve original content, identity, required reads and control blocks first; trim optional detail first. Full does not mean unlimited history or expanded permissions.

## Registry contract

Each entry declares a stable section ID, order, supported targets, modes, predicate, budget priority and renderer. Prepare record, routing result, knowledge view, target responsibility and control blocks once. Renderers consume this input without querying; disabled sections do not fetch data. Scheduling-specific renderers remain separate without duplicating shared sections.

Deduplicate reference IDs in source order and omit absent values. Native group replies use `repliedMessageId`; panel-style `replyContext` is an open object. Define each producer's contract before migration: arbitrary target message IDs are not necessarily quoted messages. O2 reads native group replies and explicit replyContext message IDs.

## Product decision for contextDetail

Recommend route-visible `contextDetail: compact | full`, defaulting to compact to preserve production behavior. Rules inherit the route value; no additional rule override in this design. Ship API validation, persistence, WebGUI and bilingual guidance together, explaining the context length cost.

Resolve one effective mode and feed it to the registry. During migration, explicit caller options override route configuration, then compact is the default. Existing functions become thin delegates, not parallel assemblers. Message Agents retain their own responsibility parameter.

If the product instead rejects a visible setting, merge necessary sections into the default registry and remove full plus its test-only callers in the same follow-up. This alternative requires a later decision and is not implemented here.

## Migration and acceptance

1. Capture fixtures for all three entry points: group/private chat, panel, feedback, voice, remote personas, grouped messages and missing sources.
2. Extract pure renderers and shared input; migrate compact first. Compare content, envelope, controls and required reads byte-for-byte and explain intended differences.
3. Migrate full and shared Message Agent sections. Keep scheduling under its current owner; remove replaced duplicate composition.
4. Connect configuration, API and UI together. Verify defaults, explicit full, persistence round trips and existing invalid-value validation.
5. Regress zero history, reference deduplication, unavailable attachments, read-only preview, unavailable remote sources, budget trimming and reply completion before switching the production entry point.

## O1–O3 behavior in this batch

Source-less create/send retain both Markdown headers, unknown identity fields, delivery time and optional delivery ID. Response `data.warnings` is a string array: empty for valid sources, distinct warnings for omitted and incomplete sources. Required normalization and wire fields remain unchanged. Compact situation sections add message ID, reference IDs and deduplicated group IDs. No deployment occurred; installed-runtime acceptance requires a later authorized switch.
