English | [简体中文](persona-resource-api-contracts.md)

# Executable contracts for persona resources

These contracts own avatars, Markdown documents and verifiable references in the original persona directory. Executable definitions drive HTTP dispatch and remote discovery. Native owners retain file selection, avatar mutations, reference revisions and language-style validation.

| Operation ID suffix | Method | Path |
| --- | --- | --- |
| `avatar.read` | GET | `/api/roles/:roleId/avatar` |
| `avatar.save` | PUT | `/api/roles/:roleId/avatar` |
| `avatar.remove` | DELETE | `/api/roles/:roleId/avatar` |
| `document.read` | GET | `/api/roles/:roleId/persona-document` |
| `reference.read` | GET | `/api/roles/:roleId/persona-reference` |
| `reference.language-style.validate` | POST | `/api/roles/:roleId/persona-reference/language-style` |

Full operation IDs start with `manager.personas.resources.`. Document and reference operations retain their original `persona:METHOD:PATH` policy aliases. Authenticated remote connections can invoke these public operations. Persona selection, style bindings and Manager identity select the original owner and prevent cross-routing; they are not feature grants.

## Native behavior and resource lifetime

- Avatar uploads retain PNG, JPEG, WebP and GIF signature checks and the 5 MiB limit. Identical content uses the original content-addressed file. Save/delete preserve native configuration updates, auditing and change events, including unrelated configuration fields.
- Avatar GET streams the configured original file with its MIME, Content-Length and private cache policy. Existing images larger than the upload limit remain readable. Frames are bounded to 64 KiB. EOF, disconnect and cancellation close and join the original file stream, including a stream whose iterator has never started.
- Documents accept one Markdown basename inside the selected persona directory, defaulting to `persona.md`. The resolved real path must remain within that directory. `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES` configures the document budget; its default 0 means no application-level quota. Success returns the original bytes and Markdown MIME, while errors remain text responses.
- References retain SHA-256 revisions. `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES`, `RABIROUTE_PERSONA_CONFIG_MAX_BYTES` and `RABIROUTE_PERSONA_RESPONSE_MAX_BYTES` configure document, configuration and remote-response budgets respectively; all default to 0. Explicit quotas count actual original bytes. Invalid values return 503 `READ_SETTING_INVALID` only for operations that depend on that field. See [remote persona references](remote-persona-reference_en.md). Reference style validation requires the current revision and uses the owner-configured rule location. It reuses the global language-style validator and response schema. A final reference read rejects results produced against a changed configuration or revision.
- Every new request uses the current persona root. Owners capture the original directory, connection and Manager identity before body consumption, then recheck after awaited work and between stream frames. Upload limits, cancellation and identity changes prevent subsequent native writes. Failures after a native mutation retain uncertainty; callers should read the current avatar to reconcile.

## Validation and migration boundary

Focused tests cover all six registrations, successful authenticated empty-node access, avatar bytes and configuration preservation, declared and actual upload limits, existing large-image downloads, document limits, reference/style revision checks, identity changes and file-stream closure. They use isolated temporary persona directories and controlled validators, and do not establish installed-runtime or physical-device acceptance.

This page covers only these six resource operations. Plan, memory, Skill, knowledge and recording interfaces still need their own owner migrations. Their legacy prefix dispatch must remain until coverage is complete; completion of this group does not mean that all persona APIs have migrated.
