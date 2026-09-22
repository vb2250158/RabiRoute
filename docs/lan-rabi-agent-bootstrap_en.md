<!-- docs-language-switch -->
<div align="center"><a href="./lan-rabi-agent-bootstrap.md">简体中文</a> | English</div>
<!-- /docs-language-switch -->

# Remote Agent setup and updates

> Status: experimental. Independent credentials, Manager grants, restricted APIs, resource reads, and upload-to-group-file delivery have passed local tests, a full build and deployment. Host/Manager health and runtime artifacts were verified for `0.3.4-4b5d30118b40`. Upload integration used real HTTP and simulated NapCat; this does not establish real two-computer, real-group or older-node migration acceptance. Subsequent discovery-guidance and update-mechanism audit fixes require separate verification of their final deployed version.

Remote Agents connect as execution targets only: select an enrolled instance and Agent in the Agent section. The old message-endpoint menu, quick setup choice, and password-based device scanning panel are removed. The legacy `remoteAgent` message-endpoint key remains only for saved configuration compatibility; remove it after instance/Agent bindings migrate and old task receipts are archived. Do not use it for new connections.

## Three user steps

1. Open **RabiLink → Remote Agent** (远端智能体 in Chinese) (`#/rabilink?tab=agents`; the old `#/lan-agents` redirects here) and select **Copy setup prompt**. One click issues and copies the complete setup instructions together with a single-use ticket, valid for 30 minutes after issuance and invalid immediately after one successful exchange. No manual WebGUI key is needed. The prompt uses the current Manager LAN address and pinned release public-key fingerprint. A loopback page selects a current LAN address. Enable LAN access first. Copy a new prompt after expiry or a Manager restart.
2. Start Codex or DSH on the target computer and paste the prompt into the task that should receive messages. That Agent checks Node.js 22.13+, discovers its current task and workspace, downloads and verifies the worker, writes private configuration, registers login startup and starts the background connection. Full RabiRoute installation and manual task IDs are unnecessary.
3. In the Route, open **Message adapters → Add AGENT**, choose **RemoteAgent(<IP address>)**, and save. With no nodes, the menu links to setup. The displayed IP is observed by Manager; the persisted identity is instanceId + agentId.

Local and remote computers are represented as instances in a two-level **instance → Agent** view. The local instance appears automatically. Remote instances display **RemoteAgent(<IP address>)** and contain multiple Agents. Codex and DSH describe execution capabilities rather than separate remote-instance types. Address changes do not change route identity.

The shared instance editor provides names, enablement, workspace, task names and IDs, model, reasoning effort, explicit environment scans, opening tasks and Hook installation. Hook policies remain in the current Manager's persona automation settings.

The prompt contains a short-lived enrollment ticket, not the shared WebGUI administrator Token. Paste it only into a private task on the target computer; never put it in a repository, group chat, logs, screenshots or command history. Clipboard fallback supports LAN HTTP pages; HTTP does not encrypt transport, so use it only on a trusted network.

After enrollment, use the node credential with `GET /api/lan-agent/self` to check your own `nodeId` and `connected` status. Newly enrolled Agents are enabled by default. **Enable Agent** (Chinese label: **是否启用Agent**) is checked by default and uses the same label as the local switch. Enabled remote Agents are used in the same way as local Agents, without a separate API or skills grant. Manager owns the remote switch; changes immediately send a PUT and disabling works while offline, independently of Save to instance. Disabling rejects subsequent tasks and restricted API/resource requests. Saving the workspace, task or model does not re-enable the Agent. The UI only displays Manager-returned state and never assumes enabled when a read fails. Existing disabled states with saved bindings remain in effect across reconnections. If an older never-authorized state cannot be distinguished from an intentional disable, it also stays disabled until an administrator confirms and enables it.

An explicit connector-local `enabled=false` still rejects execution; enrollment does not bypass it. Manager disablement and revocation also remain authoritative. Exact `GET /meta` with a valid node credential and no Agent identity permits connection diagnostics only, not business or management access. Business requests require liveness and required dependencies to be ready; exact metadata diagnostics check identity only.

The default-enabled and UI changes have passed a source build but have not been deployed or verified across two computers. Historical deployment records below do not establish that this change is live.

### Connected node with an empty resource catalog

A `200` response with `data: []` from `GET /api/lan-agent/resources` does not mean authorization was denied; authorization failures return `401/403`. Manager reads public resources from the current installation's `packageRoot/skills` and allowlisted `packageRoot/docs`, not the writable `stateRoot`. The old wiring incorrectly returned an empty catalog when an installed deployment separated these roots. After fixing or upgrading the host Manager, use the existing node credential to list resources and read `docs/rabi-agent-interfaces.md`; do not re-enroll, repeatedly grant access, or copy documents into the state directory as a workaround. Verify connectivity, resource readability and macOS login startup separately.

### Older nodes must enroll again

An old configuration without `nodeCredential` cannot reuse `lanLinkToken` as a node credential. Enroll with a new ticket while preserving `nodeId`, Agents, task bindings and permitted workspaces. Reconnecting with an existing independent credential does not exchange another ticket. The new source implements a safety migration before any HTTP/WS listener opens: when old `lan-agent-tasks.json` exists without a completion marker, it rotates the WebGUI Token even if that registry is empty, then writes the completion marker only after success. A migration failure aborts startup. Old browser remote links become invalid; obtain new links locally and update trusted management clients. Confirm revocation or rotation separately for exposed shared keys outside this detection scope. **An unrotated shared key may still bypass node grants through administrator access; disabling an Agent grant does not revoke that key.** A successful deployment and healthy Host do not establish older-node migration acceptance. Re-enrollment and invalidation of old keys still require per-node verification; do not describe all existing installations as already automatically secured. If enrollment times out or its receipt is uncertain, inspect Manager node state and local private configuration before acting; never replay enrollment automatically.

Rollback warning: the new authority state adds `disabledAgentIds` under `schemaVersion: 1`. Older programs strictly reject unknown fields; this is not directly backward-compatible. Rollback requires an authority recovery point matching the pre-upgrade version and reconciliation of subsequent disable changes, so restoring older state cannot re-enable disabled Agents. Do not delete fields to bypass the older validator.

## Ownership and execution

| Object | Owner | Behavior and acceptance |
| --- | --- | --- |
| Nodes, IP, connections and task states | Manager node registry | Both HTTP management and WebSocket connections require explicit authentication; offline delivery fails. |
| Route binding | Route `agentAdapters`, `remoteAgentTargets`, and `primaryAgentTarget` | Local providers and remote targets are stored separately. Remote entries reference `instanceId + agentId` without copying credentials or task configuration. The primary selects a specific target, not just a Codex/DSH provider. Gateway receives its endpoint and credential from the current Manager generation. |
| Task, model, tools and permissions | Existing remote Codex/DSH host | Each Agent retains its task binding. No fallback Runtime or host startup modification. The host remains independent when Manager stops. |
| Background connection | Current-user Rabi Agent | Owns outbound connection, downloads, verification, login startup and updates. |
| Message path | Route → Agent adapter → Manager registry → remote worker → bound task | Codex uses Desktop IPC; DSH uses local `session.prompt` with `mode=queue`. Each host has one execution path. |

An unavailable Codex owner fails without `codex app-server`. An unavailable DSH endpoint or binding fails without switching to Codex. A busy Codex task rejects new work rather than overwriting its task association. Accepted duplicate tasks are not submitted again.

Online means the worker is connected. Task records distinguish delivery, acknowledgement, progress, completion and failure. DSH currently reports queue acceptance; read its actual reply in the bound session. Codex completion comes from Desktop broadcasts; read replies in the corresponding task. Local image paths are not sent directly to another computer. Full plan-assistant and message-processing-pool parity and remote persona-file synchronization still need verification; do not claim that all advanced local features have migrated.

## Installation and releases

| Platform | Private directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%/RabiAgent/` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

WebGUI owns the single prompt template; this document does not duplicate it. The prompt contains the full Manager URL, single-use ticket and pinned SHA-256 public-key fingerprint. The ticket permits release downloads and is consumed by a successful enrollment. The resulting independent `nodeCredential` is stored only in the node's private configuration; Manager stores only the secret hash and grants. Login startup entries contain no credentials. Verify the Ed25519 manifest signature and every file's SHA-256 and size. Reject escaping paths and cross-origin downloads. Preserve Manager's private signing key across upgrades; rotation requires trusted redistribution of the fingerprint.

Process variables: `RABI_MANAGER_URL`, `RABI_AGENT_BOOTSTRAP_TICKET`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS`, `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`. Codex uses `RABI_AGENT_TYPE=codex-desktop` and `RABI_AGENT_CODEX_THREAD_ID`; DSH uses `RABI_AGENT_TYPE=dsh`, `RABI_AGENT_DSH_URL`, `RABI_AGENT_DSH_SESSION_ID`. The remote Agent discovers and privately stores these values without asking the user to type IDs.

`node rabi-agent.mjs --bootstrap` stays running; launch it hidden and detached from the installation terminal. Refresh the node page after setup. Online nodes can request updates; the worker downloads, verifies and switches itself, retaining the old version if the new one does not reconnect within 30 seconds. If Manager's address changes, copy a fresh prompt to update the connection; do not guess ports.

Updates identify releases by the SHA-256 digest of the signed manifest's `manifestPayload` JSON, not package semver alone, so changed content with the same version number can update. Downloads use immutable digest-named directories; an existing directory is reused only after release identity and every file hash are checked again. Shared launchers and Hooks stay unchanged until the candidate reports READY. Only then does the connector install the pointer-based launcher and stable Hook shim, followed by an atomic switch of the `current-release` pointer; failures retain the previous release. Each shim invocation reads the pointer and dynamically imports that release's Hook helper.

An older connector whose `update()` compares only semver cannot install this fix merely by receiving a new manifest. For the first migration, copy the new setup prompt and run the new bootstrap once; retain the existing `nodeCredential` rather than deleting the node. Subsequent updates use content digests. An existing DSH process may also have cached the old helper: reload its plugin or host once. Replacing files on disk is not proof of a hot update. These contracts do not establish migration of every remote node; verify its actual release digest and Hook behavior.

## Instance ownership and management

The local instance ID is persisted in private `agent-instance-id.json`; remote instances retain their private nodeId. Existing single-task configuration is projected as agentId=default; new Agents receive UUIDs. Each executing computer owns its configuration. Manager keeps a catalog projection, while local Agents keep their existing route configuration as the source of truth, with the existing concurrent-version guard on saves.

Both transports use `instanceManagement.ts` for scans, tasks and Hook installation. WebSocket RPC responses must belong to the requesting connection. Disconnection fails immediately; refresh after an ambiguous timeout before retrying a change. Hooks validate the registered session and associate an isolated instance identity with the current Manager persona.

Each instance links to its bound route's shared complete Agent settings, including message processing, dedicated memory consolidation and plan assistants. Worker state is scoped by instanceId, agentId and primary task ID. Moving computers or rebinding the primary never reuses workers from the previous owner. Resolved or created assistant tasks register under their owning Agent; Manager followups dispatch by that ownership and fail on offline or ambiguous identities without local fallback.

Installed Manager reads connector assets, the shared management runtime and Hook packages from its immutable release, while signing keys remain in private data. Reconnecting preserves instance identity, the Agent catalog and permitted workspaces. Disabled local task bindings remain visible and can be enabled again. A Route can retain local Codex and multiple remote Codex targets, with independent cards, removal, and selection. Adding a remote target neither replaces the local card nor changes the primary. Removing the primary requires an explicit new selection; an offline remote target never falls back to local.

Legacy `agentInstanceBindings[provider]` is migrated only at the configuration read boundary: local configuration fields are retained and remote bindings become independent targets. An existing remote primary continues to select the same instance and Agent. Saving removes the legacy field so deleted targets cannot reappear. Migration does not create sessions or change node grants; local cards without a bound session still require configuration.

## Calling APIs and skills from a remote task

On a remote computer, prefer the installed connector command supplied by the Hook and its `--api` entry. The examples show arguments, not a requirement to find another source checkout. Local `RabiRouteHost.exe` discovery instructions apply only on the Manager computer; absence of Host on the remote computer does not mean Manager is offline. The connector uses its configured address and verifies `/meta`, without a second Runtime or credentials in command arguments:

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

Use the exact `agentId` from private configuration; never guess an identity. The general syntax is `--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`. Supply mutation JSON through standard input. Read the current contract and object version first, then supply the required strong ETag and stable idempotency key. The CLI reads private `nodeCredential`, sends Bearer and `x-rabiroute-agent-id`, and checks `/meta` health, generation and instance identity before and after the request. On a timeout, 503, `uncertain` receipt or generation change after a write, retain the original key and body and read authoritative state before acting; never retry automatically. On 412, refresh the version and reconfirm intent. Rediscover and verify changed addresses; never scan or guess ports.

- `capabilities` returns the reviewed operation catalog: controlled business entry points and aliases. It is neither every Manager API nor a guarantee that every listed operation works remotely. Use the running instance's catalog and each entry's `limitations`. Object permissions, Action Gate, source identity, file roots, idempotency and version checks still apply.
- `resources` lists only public skills and explicitly published documents. `resources/read?id=...` permits those documents, `SKILL.md` and controlled text directly referenced by that same skill. It does not provide arbitrary `file` access, path traversal, link escapes, private data or host files. Reading a script does not authorize executing it.
- The catalog advertises only published files and references that can actually be read; arbitrary Markdown links do not grant access. Public contracts cover interfaces, plans and memory, context injection, and remote setup, with corresponding English documents. Use the actual IDs returned by `resources`. Discovery endpoints are `/api/lan-agent/capabilities` and `/api/lan-agent/resources`, not `/api/agent/capabilities` or `/api/agent/resources`.
- Persona Skills use `GET /api/roles/:roleId/skills` (summaries) and `GET /api/roles/:roleId/skills/:skillId` (detail); the `/roles/...` aliases have the same boundary. An Agent with Manager API access whose exact `instanceId + agentId` is configured on that persona's Route can read the persona's effective Skill directory, without additional per-Skill grants. An unconfigured persona returns `403 LAN_AGENT_PERSONA_NOT_CONFIGURED`; same-named Agents or other nodes cannot borrow the binding. Local management retains its existing authentication. This does not merge host-global or private Skill directories, or publish private Skills, credentials or synchronization configuration through public `resources`.
- Both persona Skill listing and detail use the bounded interactive reader pool, not the bulk catalog queue. Disconnects cancel reads; busy queues, task deadlines and unconfirmed worker termination return `503`, not a successful empty list. A missing Skill within an authorized persona returns `404`; a genuinely empty directory returns `200` with an empty list. Verify these persona authorization and scheduling changes against the deployed version: source tests do not mean all running nodes are updated.
- Fetch the latest skills and contracts currently published by Manager on demand, then read references available in that catalog. Do not keep a copied skill tree as another authority. Plans, memories and message-processing state remain Manager-owned; do not create a second remote business-state store.
- Administrator settings, grant changes, arbitrary files and host control are denied to node API callers. Existing loopback-only handlers still reject remote calls; do not proxy through localhost to bypass them.
- Formal sends to message channels retain Manager's message contract and require both Manager and channel receipts. Final task text is not proof of delivery. Remote calls still obey Route send permissions: `onlyPrimary` requires all of the trusted `provider`, Route `instanceId`/`nodeId` and `agentId`, approved session, and `primary_persona` identity to match; a matching bare session ID does not inherit local permissions.
- For cross-Agent delivery, the remote primary-session source is recorded in an instance namespace. Only one-way delivery with `responsePolicy: "none"` is supported. Without a trusted return route, `responsePolicy: "required"`, formal replies using `inReplyToRequestId`, and remote-to-remote delivery are explicitly rejected; this is not full formal-reply support. Remote context uses only its own dedicated `context` endpoint, not the generic `codex-hook` APIs.

The Windows release process will copy public `skills/` through a controlled Git-tracked file selection, excluding private or untracked workspace content. ZIP acceptance has not been run for this packaging chain; do not claim that the installed package already contains a complete usable skill catalog.

### Download one Skill and its support files

When the Skill body is readable but `scripts/` or `references/` files are missing locally, download that Skill's complete directory. Do not copy the whole persona or guess host filesystem paths. An Agent configured for the persona reuses its existing node credential and persona permission. This endpoint does not execute scripts.

The installed launcher uses the current immutable release directory as its working directory; `./` does not refer to your shell or project directory. Explicitly choose an existing parent directory on this computer outside the Rabi Agent installation and pass an absolute file path to `--output`; the final file must not exist. Use the Bash example below only if you have chosen and confirmed that `$HOME/Downloads` exists and is outside the installation; otherwise substitute your chosen existing directory. Do not create directories automatically. The shell expands `$HOME` to an absolute path.

```bash
node rabi-agent.mjs --api GET "/api/roles/<roleId>/skills/<skillId>/download" --agent "<agentId>" --output "$HOME/Downloads/selected-skill.zip"
```

Use the installed connector path supplied by the Hook. Manager and remote connector versions require separate acceptance: a new Manager does not prove that the Mac already has a CLI supporting `--output`. Upgrade old connectors through the installation/signed-update flow above, then verify the Hook and CLI option; do not install a second updater. The HTTP endpoint can also be used independently by an authenticated binary client. The destination parent must exist and existing files are not overwritten. The client validates ZIP length, SHA-256 and Manager identity before/after transfer before reporting success; it never extracts or executes content. The ZIP root is `<skillId>/`, containing all regular support files in that Skill directory. A flat Markdown Skill contains only `<skillId>/SKILL.md`. Download another Skill separately; external references are not followed. Links, escapes, unsafe names and exceeded limits fail the entire package rather than silently omitting scripts. Consult the deployed [download contract, limits and errors](rabi-agent-interfaces_en.md#download-one-complete-skill-folder).

Downloading `.ps1` on macOS does not prove that `pwsh` exists, paths are suitable or execution is authorized. This covers registered Rabi Agent downloads from their configured Manager; public RabiLink large-binary forwarding and real cross-machine acceptance are separate.

## Upload a file and send it to a QQ group

> Upload integration, the full build and deployment were verified locally in `0.3.4-4b5d30118b40`. Tests used real HTTP and simulated NapCat without sending files to a real group. Real two-computer group-file delivery remains unverified.

Requires an independent node credential and a primary Agent approved by the controlling Manager. Upload only transfers a file to Manager; it never automatically sends to a group. See the [upload example in the interface contract](./rabi-agent-interfaces_en.md#uploading-from-a-remote-agent-before-sending-a-group-file-experimental-contract) for the complete send JSON:

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` is a required stable UUID saved beforehand, never generated automatically. Upload uses `PUT /api/agent/uploads/<UUID>`, `application/octet-stream`, the same UUID as `Idempotency-Key`, `x-rabiroute-file-name` containing a URI-encoded basename, and `x-rabiroute-content-sha256` containing the content digest. GET on the same path returns `{code:0,data:{id,fileName,size,sha256,expiresAt}}`, with ISO expiry and no local path. Defaults are 2 GiB per file (2048 MiB, the hard maximum), 4 GiB total, at most 100 files, and a 24-hour TTL. HTTP uploads have a total concurrency limit of 4 across owners. After timeout, 503, a generation change or an uncertain receipt, rediscover and verify Manager, then GET the original UUID; never automatically retry or change IDs.

Large uploads use binary streaming, streamed disk writes and incremental SHA-256 verification with a 30-minute deadline, not whole-file JSON or memory buffers. In RabiLink → Configuration, save `agentUploads.maxFileMiB` (integer `1..2048`, default `2048`), persisted in `data/Config.json` and effective after Manager restarts. Local administrators may also use the existing protected `PATCH /api/rabi/identity`; remote Agents cannot raise this setting.

A controlled 734 MiB (769654784-byte) file passed size/SHA-256 integration verification through the real client, loopback Manager, managed disk and simulated NapCat. Generation and sink reads used 64 KiB chunks, with test guards rejecting Buffer allocations/concatenations above 8 MiB. The large case requires `RABI_TEST_LARGE_UPLOAD=1` and automatically cleans temporary files. **Actual QQ-platform acceptance of this file size remains unverified**; check NapCat/QQ limits and group permissions. Legacy connectors require the new bootstrap (preserving their node credential), and hosts caching an old Hook must reload. Updating Manager alone does not add large-file support to an old client.

Sending still uses `/api/agent/send` with a stable `deliveryId`, `sender`, exact `routeId`, `channel=napcat`, and `params.target=group`, `groupId`, `instanceId`, and `replyToMessageId`. The reply ID must be a concrete message ID or an empty string. The file portion of the standard-input JSON is `payload:{type:'file',fileId:<upload-data.id>,fileSha256:<upload-data.sha256>,text?}`. `fileId` is mutually exclusive with `path`, `url`, and `fileName`; the display name comes from upload metadata. It is limited to group files, not images, voice, or other channels. Existing reference-review and tracking requirements remain in force.

`fileSha256` is required with `fileId` and must contain upload `data.sha256` (64 lowercase hexadecimal characters), preventing UUID reuse after 24-hour expiry from replacing the content behind an old reference. The send callback checks the actual hash inside the lease and rejects a mismatch.

Ownership is `nodeId + agentId`: sessions of one Agent can share files, but each request still needs a trusted, approved source. Manager's internal trusted resolver checks authorization, ownership, integrity and TTL per request; an active inflight lease prevents cleanup. It does not expand `allowedFileRoots`, and existing local path sends remain unchanged. The channel must permit sending and `file`; `onlyPrimary` still checks the exact Route's remote binding and approved session.

Only Manager and channel receipts prove group delivery. If NapCat accepted the file but the caption failed, retain `sent` and send only the missing text, never the file again. NapCat currently reads Manager's supplied path, so NapCat on another machine requires a readable shared directory. This does not solve arbitrary cross-machine NapCat access. The `responsePolicy: "none"` restriction remains unchanged. See the complete [Agent interface contract](./rabi-agent-interfaces_en.md#uploading-from-a-remote-agent-before-sending-a-group-file-experimental-contract).

## API

Management and node endpoints are distinct. Listing an endpoint here does not grant node credentials access to every management operation.

- `POST /api/lan-agent/enrollments`: trusted management issues a single-use ticket.
- `POST /api/lan-agent/enroll`: exchange a ticket for an independent node credential.
- `GET /api/lan-agent/self`: read the caller's own identity and connection state, not other nodes.
- `GET /api/lan-agent/capabilities`, `GET /api/lan-agent/resources`, `GET /api/lan-agent/resources/read?id=<resourceId>`: authorized Agents discover operations and read restricted resources.
- `PUT /api/lan-agent/instances/<instanceId>/agents/<agentId>/authorization`: compatible management-only Agent enable/disable endpoint. Snapshots continue to project enabled state through `authorization.nodes[].enabledAgentIds`, without a separate API permission switch. Use `{ "enabled": true, "binding": { "provider": "<provider>", "sessionId": "<sessionId>", "managedSessionIds": [] } }` to enable access. `managedSessionIds` is optional; the grant explicitly freezes the binding displayed in the UI. Disabling requires only `{ "enabled": false }`. GET instances first. The PUT requires a stable `Idempotency-Key` and its strong ETag as `If-Match`. Grant receipts persist for 24 hours. The same key and body return the original receipt without rewriting the grant; a different body with that key returns 409. A missing version returns 428; a conflict returns 412. After a timeout, GET instances to inspect the current grant without automatically retrying. After receipt expiry, read again, reconfirm intent, and use a new key and ETag. Nodes cannot grant themselves access.
- `GET /api/lan-agent/releases/manifest` and `GET /api/lan-agent/releases/<version>/node/<assetPath>`: manifest and files.
- `GET /api/lan-agent/nodes`: nodes, release information and recent tasks.
- `GET /api/lan-agent/instances`: local and remote instances with their Agents.
- `POST /api/lan-agent/instances/<instanceId>/agents`: add an Agent.
- `POST /api/lan-agent/instances/<instanceId>/agents/<agentId>/<operation>`: configure, scan, threads, hooks, context and tasks.
- `POST /api/lan-agent/nodes/<nodeId>/tasks`: delivery, defaulting to the node's declared host when `targetAgent` is omitted; deduplicate with `idempotencyKey`.
- `POST /api/lan-agent/nodes/<nodeId>/update`: update request.
- `WS /api/lan-agent/connect`: `authenticate → authenticated → hello → connected → heartbeat`.

The existing `lan-agent` connection and release API paths remain available for installed connectors to update. The unreleased `lanAgent` provider and `lanAgentNodeId` setting have been removed; routes use instance bindings and the user-facing feature is Remote Agent. Old Remote Agent v3 is a separate experimental protocol, not a delivery path or installation dependency of this adapter. Migrating it is outside this change.

## Route targets and delivery-test contract

`agentAdapters` stores local provider types; `remoteAgentTargets` stores `{ id, provider, instanceId, agentId }`. The remote key is `remote:<URI-encoded instanceId>:<URI-encoded agentId>`; a local key is `local:<provider>`. `primaryAgentTarget` selects the full target key, with an empty string indicating no selection. `primaryAgentAdapter` is only a derived provider and cannot distinguish computers. Remote workspace, session, and model settings remain owned by the instance.

Existing managed Route saves persist these fields. PATCH/POST `/api/rabi/instances/:guid/routes/:routeId/agent-binding` also accepts `remoteAgentTargets` and `primaryAgentTarget`, retaining its existing administrator authorization, configuration-version, and idempotency contract. The legacy `agentAdapter` parameter explicitly selects a local target without removing other targets.

`POST /gateways/:id/agent-delivery-test` performs **real delivery**, not a preview. Its body may specify `agentTargetId`; an accompanying `agentAdapterType` must match that target. A legacy provider-only request selects local; omitting both uses the saved primary. Successful responses include `data.agentTargetId` alongside the existing result. Missing, mismatched, or offline targets fail without substitution. After an uncertain result, inspect the original task before any retry. Administrator authorization and Route enablement requirements remain unchanged.

Local `POST /api/agent/threads` operations may explicitly provide `agentTargetId: "local:<agentAdapter>"`. It must match `agentAdapter` and cannot accompany a remote `instanceBinding`. This disables remote-owner inference from a colliding session ID. Remote operations retain explicit instance bindings or instance paths. Legacy callers without the marker retain their existing resolution contract; authentication and task permissions remain unchanged.

Secretary sessions and bindings persist `agentTargetId`, isolating identical session IDs on different computers. Legacy ownership is attributed only during legacy configuration migration; a record missing target identity in an already migrated configuration is not automatically assigned to a subsequently selected primary.

## Remaining device acceptance

- Final runtime verification of this discovery-guidance and content-digest update audit, and Windows ZIP public-skill manifest acceptance.
- Two-computer installation, ticket expiry and replay rejection, grant enablement/disablement and offline revocation, older-node re-enrollment and old WebGUI key rotation, disconnect recovery and login startup.
- Repeated messages in existing Codex/DSH tasks, absent hosts and visible actual replies.
- Startup and failed-update recovery on Windows, macOS and Linux.

## Capability boundary

The implementation unifies instance identity, catalogs, Agent management and remote transport. Instances link to their bound routes' shared complete settings. Advanced task dispatch, state isolation and Hook ownership have implementation and local contract coverage; plan responses, the message-processing board and full workflows still require acceptance with real remote hosts. A connected node or passing local fixture does not prove two-computer or complete advanced-feature parity.
