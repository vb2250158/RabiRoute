English | [简体中文](role-configuration-api-contracts.md)

# Role configuration and lifecycle API

Status: source migration. The architecture migration owner coordinates Manager/plugin wiring, the full build and installed-runtime acceptance. Isolated HTTP tests use temporary role directories and do not mutate running roles.

`createRoleConfigurationOperations` registers eight executable HTTP contracts. `createRoleConfigurationOwner` owns configuration, revision checks, role locks, native operation receipts and lifecycle orchestration. Roles do not need a message Route. Authenticated remote connections that are not explicitly disabled and local requests use the same owner without additional role bindings, feature grants or management keys.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/roles` | List active roles; `scope=archived` selects archived roles; supports `query`, `cursor` and `limit` |
| POST | `/api/roles` | Create a role and default automation configuration using `roleId` and `title` |
| GET | `/api/roles/:roleId/configuration` | Read configuration, content revision, archive state, work count and Route references |
| PUT | `/api/roles/:roleId/configuration` | Replace role-owned configuration fields using `expectedRevision` |
| GET | `/api/roles/:roleId/references` | Read Route/other-role configuration references and running-work count |
| POST | `/api/roles/:roleId/archive` | Archive the role and stop new work admission |
| POST | `/api/roles/:roleId/restore` | Restore the role |
| POST | `/api/roles/:roleId/delete` | Permanently delete an archived role with no references or work leases |

Role IDs retain native Unicode letters, numbers, underscores and hyphens. A list page returns at most 25 entries and examines at most 200 directories; continue with `nextCursor` when present. Damaged directories produce error entries rather than healthy role records.

Reading `/configuration` for an absent role returns 404 with `ROLE_NOT_FOUND`, without creating a role or recovery record. Unavailable role storage, damaged configuration and damaged metadata retain their existing operational errors rather than becoming role-not-found responses.

Configuration updates, archive, restore and delete require a stable `Idempotency-Key` (1–128 ASCII letters, digits, `:`, `.`, `_`, `-`) and an `expectedRevision` body field. The revision is a SHA-256 of role metadata and the complete configuration, separate from the metadata's incrementing counter. Revision conflicts return 412. Reusing a key for a different role, action or payload returns 409. Deletion requires `confirmationId` to exactly match the role ID.

Only fields in `ROLE_CONFIGURATION_KEYS` are replaced; extension fields remain. Omitted role-owned fields are cleared. Automation retains native default-rule completion and explicit Agent-target validation. Configuration updates and creation retain `assertRoleAcceptsWork`. Admitted work can finish after archiving; new work is rejected.

The native role lock shares `.role-state/locks` with Gateway work admission. Receipts live under `.role-state/operations` in the role root; filenames are SHA-256 hashes of the original operation keys. A pending receipt precedes configuration/metadata writes; committed results follow atomic JSON persistence and catalog publication. The same key and payload reconcile native pending state or read the committed result. Never replay an unknown mutation with a new key.

Deletion also checks disabled Routes, other-role automation, unresolved work leases, role-directory boundaries and recursive links. Tombstones under `.role-state/deleted` prevent silent recreation of the same ID. Deletion is not a cross-file atomic transaction; interrupted operations require the original key and receipt reconciliation.

Creation keeps the native multi-file sequence without a creation receipt or cross-file atomicity. An error after directory/file persistence returns `uncertain: true`. Inspect the original role directory before acting; changing the role ID or repeating creation is not a safe recovery strategy.

Before body consumption, prepare captures the original connection, dynamic role root and Manager generation/instance. The owner rechecks async boundaries, writes, catalog publication and disclosure. Generation/root changes, revocation and read-only transitions stop further work. Once a business write has started, failures retain `mutationOutcome: unknown` and uncertainty without disclosing stale business data. Native atomic file operations and lock cleanup must finish before the request lease is released.

Clients must retain the original key and payload whenever a response has `uncertain: true` or `mutationOutcome: unknown`, including 403/409 responses. A 4xx status alone does not justify clearing recovery state. Reconnect and reconcile the original receipt.

The WebGUI role editor retains the original key and payload for these uncertain responses. A newer draft does not replace the original recovery request. Once that request is confirmed, the draft remains and requires another save. A deterministic 4xx rejection that did not start the mutation can clear its recovery record.

The request owner's assertion reaches the native atomic JSON writer: it checks the original connection, role root and Manager identity after parent-directory creation and temporary-file writing, immediately before the final rename. Rejection removes temporary bytes and preserves the original destination. A rename already dispatched and completed retains its actual commit audit; uncertain outcomes require original-receipt reconciliation. Native background callers that omit the assertion keep their existing behavior.

The shared registry performs parsing, request/response Schema validation, connection checks and async request tracking. A contract digest describes the API version and does not replace native `expectedRevision`. Unregistered methods are handled by the shared route layer. The old boolean handler has been removed and must not remain mounted as a bypass.

See [code architecture](code-architecture_en.md) and [source hot patches](source-hot-patches_en.md). Installed-runtime acceptance separately verifies the current Manager identity, published contracts, actual HTTP behavior and candidate hash.
