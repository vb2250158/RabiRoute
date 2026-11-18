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

Adding automation offers Create from template and Create manually. Preview the rule, then choose Create to add it to the list. Under **Type**, choose **Notify Agent**, **Run script**, a built-in or plugin template, or a custom template for the current role. The template fills an ordinary rule. You can edit its schedule, target Agent, busy policy and message, and the existing automation scheduler executes it.

**Save as custom template** copies the current trigger type, message text and extra instructions. Save the role configuration to use it in other rules for that role. Updating or deleting a template changes the template list.

Defaults cover memory consolidation and Skill maintenance, work review and memory capture, plan progress, message summaries, runtime status and blank delivery. The memory task reads related memories and existing Skills, updates an existing method or creates a reusable Skill, then saves, reads back and summarizes actual results.

`GET /api/automation/templates?limit=20&query=...&cursor=...` returns paged summaries. `GET /api/automation/templates/:templateId` reads one complete editable action. Plugins declare templates in the existing operation's `discovery.automationTemplates`. The catalog caches the active snapshot and reports malformed entries locally. Delivery targets use the existing Agent target format. A failed template application preserves the previous rule draft.

## Message history performance

Opening history, switching tasks and automatic updates read saved message summaries, task names and original peer relationships directly. Pagination retains the native index and cursors. Manual refresh also queries task owners for current names and links. The first event connection reuses the initial page read, while reconnects still catch up.

`chat-history` and `chat-history/tasks` accept `metadata=recorded`, retaining the original connection and persona-directory checks while using only ledger and saved delivery metadata. Omitting this parameter retains live task-name lookup.
