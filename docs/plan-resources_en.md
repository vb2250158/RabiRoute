English | [简体中文](plan-resources.md)

# Plan attachments and step file records

Plan attachments use `attachments` on `PATCH /api/roles/:roleId/plans/:planId`. Read the latest plan and strong ETag, retain existing attachment IDs, then add new content. A request may upload at most 8 new files, 10 MiB each and 25 MiB of new content in total. Retained attachments do not consume that batch budget. Use `If-Match` and a stable `Idempotency-Key`, then read back attachment IDs and SHA-256 digests. Omitting `attachments` preserves the list; an explicit empty array still clears it.

Steps retain changes in `steps[].resourceRecords`, independently of the length-limited description. Each record has a unique `id`, source `sessionId`, ISO `time` and `resources`. Each resource contains `path`, `change` (`added`, `modified`, `deleted`), `summary`, optional `sha256` and `attribution` (`tool-observed` or `agent-reported`). Existing record IDs are immutable. Updating a step without records preserves previous records. Rabi Web displays them under File changes. These records describe provenance, not review or acceptance.

Hosts collect only accepted user attachments. A single bound plan may receive them automatically. Multiple plans require explicit Agent attribution, full session-binding verification and a step selection for file changes. Do not infer bindings from titles or attribute all existing workspace differences to the current step.

The DSH tool `rabiroute_plan_resources` provides `list`, `select` and `record_changes`. It derives session identity from the executing Agent instead of accepting another session ID. Recoverable pending records retain attachments and step changes. Unknown write outcomes retain their original request instead of being replayed with a new key. User messages remain unchanged and model instructions use logged session context.
