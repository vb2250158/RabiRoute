English | [简体中文](persona-identity-api-contracts.md)

# Executable contracts for role identity relations

This group registers native identity relations, candidate observations and voice identities for HTTP dispatch and remote discovery. Original `identityRelations` and `personaVoiceIdentities` owners retain events, conflict branches, file locks and replay behavior.

| Operation ID suffix | Method | Role path |
| --- | --- | --- |
| `relations.read` | GET | `/:roleId/identity-relations` |
| `relations.patch` | PUT | `/:roleId/identity-relations` |
| `observations.append` | POST | `/:roleId/identity-relations/observations` |
| `voice.read` | GET | `/:roleId/voice-identities` |
| `voice.patch` | PUT | `/:roleId/voice-identities` |

Each operation retains `/api/roles` and `/roles`, giving ten concrete routes. Full IDs start with `manager.personas.identities.`; `/roles` IDs add `.alias`. Original derived `knowledge` and `knowledge-alias` IDs remain aliases. Authenticated empty remote nodes can invoke every public operation without another role, context or feature grant. Confirming identity does not expand business authority.

## Original records and observation rules

Relation reads retain the full catalog and account-context lookup using platform, endpointIdentityNamespace and senderStableId together. conversationKey/projectId only filter native context. Conflict states and candidate branches remain explicit instead of being flattened into one confirmed identity.

Updates retain native endpoint_account, participant and relation_card patches, normalization, list limits, statuses, reference checks and event-head conflict resolution. Unchanged stable records return 200; appended events return 201. Creation without explicit participantId/relationId can generate a new ID and must not be treated as automatically idempotent.

Candidate observations require an existing endpoint with one linked candidate, an unconflicted participant still in candidate status and traceable source messageId evidence. They cannot overwrite confirmed accounts, participants or relations, or treat a display name as confirmation.

## Voice association and recovery

Voice reads retain list and sourceHostId+voiceprintId lookup. Explicit participantId must reference an unconflicted confirmed/corrected participant in the same role, preserving object consistency. Omission retains the binding; explicit null detaches it and retires previous account links. Deletion and replay retain native voice-event semantics.

Association still writes the native relation ledger before the voice ledger, then publishes the original two Manager event types. No cross-ledger transaction or deletion of committed history is introduced. Failures after a native mutator starts, partial commits, or failed post-commit event/generation fences retain uncertainty. Callers should read both original APIs and reconcile stable IDs/current fields instead of blindly creating another record or rolling back history.

Each request captures the current role directory, connection and Manager identity before consuming its body, then rechecks before native mutations and before/after event publication. Directory changes or cancellation before a write prevent native mutation; later changes cannot disclose stale business results. Native production `maxBytes=0`, empty `{}` and ignored-field semantics remain intact.

## Validation and scope

Isolated HTTP regressions cover all ten routes with actual empty-node authentication, observations/replay, same-role voice associations, omission/null/delete replay, native conflict branches, partial dual-ledger commits and uncertainty, post-commit generation changes, and pre-write directory changes/cancellation. Tests use temporary native ledgers and change no real identity or voice data.

This group changes no role lifecycle, role configuration, business-task authority or other owner. Focused source verification does not establish installed-runtime or physical-device acceptance. Remaining legacy prefix entries are removed only after their owners migrate.
