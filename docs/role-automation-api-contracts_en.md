English | [简体中文](role-automation-api-contracts.md)

# Manage role automations through requests

Agents and the role editor use the same rules. Authenticated connections can query, create, edit, enable, disable and delete automations through requests without editing role files. Saving a rule does not immediately execute its Agent or script action; later events use the existing runtime.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/roles/:roleId/automation-rules` | List; filter by `query` (name/ID) and `enabled=true\|false` |
| GET | `/api/roles/:roleId/automation-rules/:ruleId` | Read one rule |
| POST | `/api/roles/:roleId/automation-rules` | Create a rule |
| PATCH | `/api/roles/:roleId/automation-rules/:ruleId` | Partially edit, including `enabled` |
| DELETE | `/api/roles/:roleId/automation-rules/:ruleId` | Delete a rule |

Operation IDs are `manager.roles.automations.list/read/create/update/delete`. Discover executable contracts using the current `GET /api/agent/help` and URL-encode path parameters. Generic Agent clients need no per-endpoint mapping. Manage Agent Hooks through `codexHooks` in the [role configuration PATCH](role-configuration-api-contracts_en.md).

Reads return `data.roleId`, `data.revision` and `data.rules` or `data.rule`. Malformed stored items produce `data.warnings` containing their original `index`, `ruleId` when available, and a message; healthy items remain readable and editable. A known malformed item returns 409 and a missing item 404. Unchanged malformed items are preserved. Repair a targeted item with valid contents; use configuration PATCH for records without a stable ID. Reads and unrelated edits never invent replacement rules or delete original records.

All writes require a stable `Idempotency-Key` and `expectedRevision`. Take the revision from an automation response or `GET /api/roles/:roleId/configuration`, rather than the document API's combined revision. Lock contention returns 409 and stale revisions 412.

Create request body:

```json
{
  "expectedRevision": "<configuration revision>",
  "rule": {
    "id": "daily-review",
    "name": "Daily review",
    "enabled": true,
    "trigger": {
      "type": "schedule",
      "schedule": { "id": "daily", "type": "daily_time", "timeOfDays": ["09:00", "14:00"] }
    },
    "action": {
      "type": "deliver_agent",
      "target": { "kind": "recipient", "recipientId": "primary" },
      "message": "Review current plans and act on executable items."
    }
  }
}
```

`timeOfDays` accepts one or more daily times in `HH:mm` or `HH:mm:ss` form and takes precedence over legacy `timeOfDay` when present. Saving a rule does not advance the stored schedule schema version.

Omitting `rule.id` derives a stable ID from the role and operation key. Explicit IDs use the native trimming behavior and must not be empty. An existing ID returns 409. Message triggers use `trigger.type=message`; script actions use `action.type=run_script` and an explicit `scriptPath`. The active contract and native owner define supported fields and Agent target rules.

Patch with `{ "expectedRevision": "...", "patch": { "enabled": false } }`. Omitted fields are retained; same-type trigger/action objects and schedules support partial merges. Type changes require the new type's mandatory fields. PATCH cannot rename an ID. DELETE takes `{ "expectedRevision": "..." }`, retains other rules and does not recreate deleted defaults.

Successful writes return `code=0`, `state=committed`, the original `operationId` and the new configuration revision. This confirms backend configuration submission. Actual delivery, script execution and cross-computer synchronization have separate receipts. On timeout, `uncertain=true` or `mutationOutcome=unknown`, keep the original key and payload to reconcile the same request. Do not rebuild retries from newer configuration. Committed retries return the original result without replacing later edits.

This page describes the current source contract; installed support and real triggering require separate verification. Discovery alone proves neither a write nor an executed action.
