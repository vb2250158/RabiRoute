<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.persona

Daily schedules support adding or removing several times while keeping one rule, action and enable switch. Incomplete times stay in the draft and prevent saving; valid times are deduplicated and sorted. The [configuration API](../../../docs/role-configuration-api-contracts_en.md) uses the same daily list.

Personal Bot destinations select DSH, then DS Bot and a real Bot without requiring a primary-role session. Only explicitly addressed rules appear in that Bot's schedule list; their storage role can differ from its bound persona. Existing primary-role rules retain their destinations. See [DS Bot automation destinations](../../../docs/role-configuration-api-contracts_en.md#ds-bot-automation-destinations) for catalog reads, source-configuration revisions and native delivery receipts.

Built-in Manager plugin. Instance `manager:persona` provides `manager.persona@1`. Its implementation accesses host resources only through `@rabiroute/plugin-sdk` and versioned capabilities declared by the manifest.

## Persona Skills

`GET /api/roles/:roleId/skills`, `/skills/:skillId` and `/download` retain the native catalog, content and complete archive reads. Editing uses `GET /api/roles/:roleId/skills/:skillId/source`, which returns the full `document`, supporting-file index and a strong ETag.

Create with `POST /api/roles/:roleId/skills` and `{id,content,files?}`. `content` is the full `SKILL.md`; `files` maps relative paths inside that Skill to UTF-8 text. Update with `PUT /api/roles/:roleId/skills/:skillId` and `{content?,files?,deleteFiles?}`. Unspecified resources stay intact. `DELETE` at the same path removes the active catalog entry and preserves an owned recovery copy in role state.

Writes carry the original `Idempotency-Key`. Updates and deletion carry the exact source ETag as `If-Match`. The same key and intent return the original result, conflicting intent returns409, and a stale revision returns412. `GET /api/roles/:roleId/skill-operations/:requestId` reads the original command receipt. Operations retain the original role directory, connection and role lock.

Before replacement, the owner verifies the complete original revision after moving it into its recovery location. An external edit returns 412 and restores the original contents. An unconfirmed replacement or restore returns `SKILL_REQUEST_UNCERTAIN` with the original request ID and retains the prepared receipt and recovery copy.

## Automation delivery templates

Choose a default or plugin template while adding automation, then edit its schedule, target Agent, busy policy and message in the existing rule editor. A template expands into an ordinary rule. Later template changes preserve user-edited rules, and execution uses the existing automation scheduler.

Defaults cover memory consolidation and Skill maintenance, work review and memory capture, plan progress, message summaries, runtime status and blank delivery. The memory task reads related memories and existing Skills, updates an existing method or creates a reusable Skill, then saves, reads back and summarizes actual results.

`GET /api/automation/templates?limit=20&query=...&cursor=...` returns paged summaries. `GET /api/automation/templates/:templateId` reads one complete editable action. Plugins declare templates in the existing operation's `discovery.automationTemplates`. The catalog caches the active snapshot and reports malformed entries locally. Delivery targets use the existing Agent target format. A failed template application preserves the previous rule draft.
