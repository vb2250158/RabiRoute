English | [简体中文](persona-plan-api-contracts.md)

# Executable contracts for persona plan support APIs

These contracts cover bound-Agent status/navigation, workspace advancement policy and attachment reads. Native plan storage, status services, advancement stores and attachment resolvers continue to own business state. Executable definitions provide HTTP dispatch and remote discovery.

| Operation ID suffix | Method | Path under `/api/roles/:roleId/` |
| --- | --- | --- |
| `agents.status` | GET | `plan-agents/status` |
| `agents.open` | POST | `plan-agents/:planId/open` |
| `advance.settings.read` | GET | `plan-advance/settings` |
| `advance.settings.save` | PUT | `plan-advance/settings` |
| `advance.check` | POST | `plan-advance/check` |
| `advance.run` | POST | `plan-advance/run` |
| `attachment.read` | GET | `plans/:planId/attachments/:attachmentId` |
| `attachment.head` | HEAD | `plans/:planId/attachments/:attachmentId` |

Full operation IDs start with `manager.personas.plans.`. Status reads and attachment GET retain their original `persona:GET:PATH` aliases. Authenticated remote connections can invoke all public operations without another persona or feature grant.

## Original objects and execution boundaries

Status reads preserve repeated `planId` selectors, missing IDs, full session names and full IDs. Navigation selects the original plan binding or a server-owned history actor by `historyId`; a caller-supplied actor cannot replace it. Navigation does not execute a real prompt or start a substitute Runtime.

Advancement settings retain workspace ownership, revision CAS and policy history. Checks retain pages of 20, at most 20 explicit plans and 20000 session IDs, plus native status, approval, feedback, step, cooldown and run-count rules. Runs require checked fingerprints, reread plans and original session status, and combine plans for one session into one delivery to the original bound DSH session.

Native durable reservations and receipts remain authoritative. Reservations are restored when no delivery has been attempted. Attempted but unconfirmed delivery retains an uncertain receipt, preventing a repeat send as though nothing happened. Disconnect/cancellation waits for native work and cleanup. A regression cancels after a partial reservation and verifies that no session remains occupied. HTTP success establishes only the corresponding read, navigation or advancement result, not completion of the Agent’s work.

Attachments retain native plan metadata, managed roots, relocation content-hash checks, MIME, download names, private caching, GET/HEAD and a single byte range with 206/416. Downloads keep native finite byte reads without applying upload limits to existing files.

Each request resolves the current persona directory and captures the original directory, connection and Manager identity. Owners recheck after awaits and before disclosure, navigation or mutation. New requests use a changed directory; an older request cannot keep using an invalidated directory for later actions.

## Validation and remaining scope

Isolated tests cover all eight definitions, successful authenticated empty-node access, original session navigation, CAS, check-to-run delivery, repeated fingerprints, uncertain receipts, cancellation after partial reservation, attachment bytes/HEAD/ranges, and health responsiveness while native storage is waiting. Tests use temporary native plan/advancement storage and controlled hosts without sending a real Agent prompt. They do not establish installed-runtime or physical-device acceptance.

These operations exclude plan CRUD, workflow, memory, feedback, Skill, health and recording APIs. Legacy prefix dispatch remains until those owners have migrated.
