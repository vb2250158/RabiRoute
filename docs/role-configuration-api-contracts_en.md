English | [简体中文](role-configuration-api-contracts.md)

# Role configuration and lifecycle API

This page describes the current source contract. Check the active Manager API catalog and runtime acceptance for installed-version support.

`createRoleConfigurationOperations` registers executable HTTP contracts for role configuration, documents, automation and lifecycle. `createRoleConfigurationOwner` owns configuration, revision checks, role locks, native operation receipts and lifecycle orchestration. Roles do not need a message Route. Authenticated remote connections that are not explicitly disabled and local requests use the same owner without additional role bindings, feature grants or management keys.

The role page stores the last successfully loaded role ID and source PC as `lastRoleSelection` in host desktop settings. An entry without an explicit role restores that reference first; an unavailable source or archived role keeps the reference and shows its actual state.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/roles` | List active roles; `scope=archived` selects archived roles; supports `query`, `cursor` and `limit` |
| POST | `/api/roles` | Create using `roleId`, `title`, optional `document` and full `config`; complete default automation |
| GET | `/api/roles/:roleId/configuration` | Read configuration, configuration revision, archive state, work count and Route references |
| PUT | `/api/roles/:roleId/configuration` | Replace role-owned configuration fields using `expectedRevision` |
| PATCH | `/api/roles/:roleId/configuration` | Patch full `personaConfig.json` top-level fields using the configuration revision; omitted keys remain and `null` deletes |
| GET | `/api/roles/:roleId/document` | Read `document`, full `personaConfig`, package `revision` and `configurationRevision` |
| PUT | `/api/roles/:roleId/document` | Save `document` using the package `expectedRevision` |
| GET | `/api/roles/:roleId/references` | Read Route/other-role configuration references and running-work count |
| POST | `/api/roles/:roleId/archive` | Archive the role and stop new work admission |
| POST | `/api/roles/:roleId/restore` | Restore the role |
| POST | `/api/roles/:roleId/delete` | Permanently delete an archived role with no references or work leases |

Role IDs retain native Unicode letters, numbers, underscores and hyphens. A list page returns at most 25 entries and examines at most 200 directories; continue with `nextCursor` when present. Damaged directories produce error entries rather than healthy role records. Up to four directories are read concurrently per batch; results remain ordered by role ID and the interface displays each page as it arrives.

Reading `/configuration` for an absent role returns 404 with `ROLE_NOT_FOUND`, without creating a role or recovery record. Unavailable role storage, damaged configuration and damaged metadata retain their existing operational errors rather than becoming role-not-found responses.

Configuration updates, archive, restore and delete require a stable `Idempotency-Key` (1–128 ASCII letters, digits, `:`, `.`, `_`, `-`) and an `expectedRevision` body field. The revision is a SHA-256 of role metadata and the complete configuration, separate from the metadata's incrementing counter. Revision conflicts return 412. Reusing a key for a different role, action or payload returns 409. Deletion requires `confirmationId` to exactly match the role ID.

The original PUT replaces only fields in `ROLE_CONFIGURATION_KEYS`; extension fields remain and omitted role-owned fields are cleared. PATCH accepts `{ expectedRevision, config: { ...topLevelChanges } }`, including full-role settings such as `contextInjection`; nested objects are replaced as a single field. GET `/configuration` retains its original `config` projection and adds full `personaConfig`. When PATCH changes the automation array, only added or changed rules are validated and normalized. Unchanged malformed historical entries remain intact without blocking unrelated configuration or healthy-rule edits; newly added malformed entries return 400. Configuration updates and creation retain `assertRoleAcceptsWork`. Admitted work can finish after archiving; new work is rejected.

The document response's `revision` covers metadata, full configuration and `persona.md`; use it for PUT `/document`. Its `configurationRevision` matches the original GET `/configuration` revision and is used for configuration PUT/PATCH and automation commands. A text edit does not change the configuration revision; a configuration edit invalidates an older document revision. Document operations address canonical `persona.md`, never arbitrary paths. Documents and configuration reuse `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES` and `RABIROUTE_PERSONA_CONFIG_MAX_BYTES`; the default 0 removes the application quota while actual runtime capacity still applies. Configuration quotas count actual persisted UTF-8 bytes. JSON requests and operation receipts add no separate fixed quotas. Explicit quota overruns return 413; invalid settings return 503 `READ_SETTING_INVALID` with the actual field and adjustment instructions.

An operation-key lock is acquired before the role lock; concurrent use returns 409 `ROLE_BUSY`. The native role lock shares `.role-state/locks` with Gateway work admission. Receipts live under `.role-state/operations` in the role root; filenames are SHA-256 hashes of the original operation keys. A pending receipt precedes configuration, document or metadata writes; committed results follow atomic JSON persistence and catalog publication. The same key and payload reconcile native pending state or read the committed result. Never replay an unknown mutation with a new key.

Deletion also checks disabled Routes, other-role automation, unresolved work leases, role-directory boundaries and recursive links. Tombstones under `.role-state/deleted` prevent silent recreation of the same ID. Deletion is not a cross-file atomic transaction; interrupted operations require the original key and receipt reconciliation.

Supply a stable `Idempotency-Key` for creation. The owner stages the complete document and configuration under `.role-state/creating`, then atomically renames the completed directory into the role catalog. Ordinary directory listings never expose an incomplete creation. Receipts use the same `.role-state/operations` directory. The same key and payload finish original staging, reconcile published contents or return the original committed result; a changed payload returns 409. Never switch keys after uncertainty. If another writer changed the published role, recovery remains uncertain rather than overwriting newer contents. Legacy creation without a key remains available; inspect the original role after a lost response. Directory publication and catalog refresh are not one transaction; failures preserve the original receipt and return `uncertain: true`.

Before body consumption, prepare captures the original connection, dynamic role root and Manager generation/instance. The owner rechecks async boundaries, writes, catalog publication and disclosure. Generation/root changes, revocation and read-only transitions stop further work. Once a business write has started, failures retain `mutationOutcome: unknown` and uncertainty without disclosing stale business data. Native atomic file operations and lock cleanup must finish before the request lease is released.

Clients must retain the original key and payload whenever a response has `uncertain: true` or `mutationOutcome: unknown`, including 403/409 responses. A 4xx status alone does not justify clearing recovery state. Reconnect and reconcile the original receipt.

The request owner's assertion reaches the native atomic JSON writer: it checks the original connection, role root and Manager identity after parent-directory creation and temporary-file writing, immediately before the final rename. Rejection removes temporary bytes and preserves the original destination. A rename already dispatched and completed retains its actual commit audit; uncertain outcomes require original-receipt reconciliation. Native background callers that omit the assertion keep their existing behavior.

The shared registry performs parsing, request/response Schema validation, connection checks and async request tracking. A contract digest describes the API version and does not replace native `expectedRevision`. Unregistered methods are handled by the shared route layer. The old boolean handler has been removed and must not remain mounted as a bypass.

See [code architecture](code-architecture_en.md) and [source hot patches](source-hot-patches_en.md). Installed-runtime acceptance separately verifies the current Manager identity, published contracts, actual HTTP behavior and candidate hash.

For daily schedules, `timeOfDays` specifies multiple times on one rule and takes precedence over the legacy `timeOfDay` when supplied. Saving unrelated settings does not migrate the stored schedule version.

Automation-rule listing, creation, patching and deletion share this role owner; see [automation rule API](role-automation-api-contracts_en.md). Agents manage roles through public HTTP requests without editing role business files directly.
