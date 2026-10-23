<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">简体中文</a> | English
</div>
<!-- /docs-language-switch -->

# Rabi Agent

Connector 0.2.5 makes the copied connection prompt sufficient for enrollment and credential repair; no additional Agent approval or controlling Agent is required. Valid saved credentials are reused. If credentials are missing or rejected, the fresh ticket repairs the original node while preserving Agent bindings, workspaces and explicit disables. Before exchange, the client saves a private `config.json.enrollment.json` recovery record containing its node identity and a random recovery secret, never the ticket. A lost response is resolved by authenticating the same credential. After interruption, rerun the same `--bootstrap`; an exact completed exchange can also be recovered after Manager restart. Deleted nodes and replaced credentials cannot be restored with a spent ticket. Keep the recovery file private until success, when it is removed. Only an expired or unavailable ticket requires copying a fresh prompt.

Rabi Agent is a remote computer client. Windows provides a tray and status window; macOS/Linux run in the background. It connects outbound to the controller's Rabi Manager and exposes computer APIs. Associated Agents optionally execute tasks through Codex Desktop IPC or the DSH local `session.prompt` API.

The host computer's Rabi service owns persistent management; a separate controlling Agent is not required. Ordinary authenticated Agents can also query plans, recent and consolidated memory, and skills without a primary-persona or Route grant. Computer capabilities depend on the platform and do not require a running Codex/DSH backend. See [host and remote computer clients](../../docs/remote-computer-client_en.md).

## Mac setup and terminals

Codex Desktop IPC tries explicit `CODEX_DESKTOP_IPC_PATH`, `$CODEX_HOME/ipc/ipc.sock` (default `~/.codex/ipc/ipc.sock`), then the older temporary `codex-ipc/ipc-<uid>.sock` path. The older path remains for Desktop versions using that layout and will leave with support for those versions. A connection failure does not change the environment, create socket aliases, or start or restart Desktop.

Select **Mac (macOS)** in the enrollment dialog before copying its platform-specific prompt. Windows and Linux have their own choices. Installation no longer associates the installing Agent or chooses a default task. Mac requires Node.js 22.13+ matching its CPU architecture, installs under `~/Library/Application Support/RabiAgent`, and uses a current-user LaunchAgent without the Windows tray.

Connector 0.2.4 adds interactive Zsh/Bash/sh terminals and advertises only shells present on that computer. Install with `npm install --omit=dev --include=optional`; the pinned node-pty dependency may need Xcode Command Line Tools for native compilation. File transfer and explicitly addressed Agent delivery reuse the shared APIs. Window queries, screenshots, CMD and PowerShell remain Windows capabilities.

POSIX update preparation restores a missing owner execute bit on node-pty's prebuilt `spawn-helper`, then runs the native empty-terminal check. It preserves helper contents and retains the previous connector when verification fails.

Default Desktop IPC initialization, a native empty terminal and targeted signed-snapshot updates have been verified on macOS arm64. Actual business delivery still requires acceptance on each computer. `401 LAN_AGENT_CREDENTIAL_REQUIRED` is a node credential failure: retain its nodeId and configuration rather than creating a controlling Agent, another node or repeatedly reinstalling.

## Query Agents and specify the delivery target

`GET /api/lan-agent/instances` returns computers and their Agent catalogs. Query an Agent's `/threads` endpoint with `action:list` and explicit `agentAdapter`, then supply `provider`, the full `threadId` and message on every `/tasks` delivery. Delivery no longer uses an implicit `default` or requires rebinding a configured task first. See the [remote target contract](../../docs/rabi-agent-interfaces_en.md#explicit-remote-agent-targets-and-list-queries) for requests, pagination and idempotency.

## Remote terminals (0.2.2, experimental)

In the host WebGUI, expand an online computer under **RabiLink → Remote Agents** and choose **Remote terminal**. Windows supports **CMD** and **PowerShell** by default, without another feature switch.

1. Choose a shell, optionally enter an existing absolute directory on the remote computer, and create a terminal.
2. Type directly into the terminal. Chinese text, paste, Ctrl+C and resizing are supported; directory and environment persist within the session.
3. Query terminals to read actual remote sessions and process state. Closing the window retains sessions; reopen it to attach to an existing terminal.
4. Exit a terminal with its stop button to end that shell and its descendants. Main-program exit, connector shutdown or transport disconnection also ends terminals. Commands are never automatically rerun.

Shells run as the connector's Windows user over the existing authenticated connection, without another management password or per-feature grant. One main program owns the connector, which owns native terminal hosts. Each host uses a Windows Job Object for the shell and its children. ConPTY provides terminal semantics; the browser uses xterm.js. The required OS interface is available on Windows 10 version 1809 and later.

Each node supports up to eight active terminals and 64 session records per connector lifetime. Replay retains only the latest 256 KiB in memory; browser scrollback is limited to 2000 lines. Commands and output are not written to logs. After lost responses, query the existing session and input sequence instead of recreating it or replaying input. Exit active terminals before restarting or updating the connector.

Local native-shell, HTTP/WebSocket/SSE and input-receipt validation is covered. Installed and real two-computer acceptance are tracked separately.


## Windows tray (0.2.1, experimental)

Login startup and manual launch enter the same main program. The stable launcher is the sole lifecycle owner; the connector and tray are its children. The status window belongs to the tray child. Duplicate launches do not create another connector; normal exit or abrupt main-program death releases the children.

- Double-click the icon for connection status, version, bound tasks, recent delivery results and up to 120 process-local state records. Agent runtime state remains unverified until real delivery; no recurring host/session scans occur.
- The menu starts/stops/restarts the connector, reconnects to the host, opens host management, changes login startup and exits. Stopping the connector retains the tray; exit ends the application's children. Codex/DSH keep their own lifecycle. Connector controls are temporarily unavailable during updates or known active tasks.
- The main program writes and reads back startup changes, retains the previous file and refuses to overwrite another installation's entry. Management navigation carries no credentials; the browser handles login.
- The tray consumes sanitized snapshots and submits commands through parent-child pipes. It does not read private configuration, contact Manager or start an Agent Runtime.

Windows native tray, menu, singleton, process-exit and isolated release-asset tests are covered. Real two-computer upgrades and login startup remain pending. After upgrading an older signed release, exit the original main program normally and launch once through the existing launcher to adopt the new owner and tray; keep enrollment and task bindings.

CLI control uses the same owner: `node rabi-agent-launcher.mjs --config <private-config> --command status|start|pause|restart|reconnect|enable-startup|disable-startup`. `--stop` exits the whole application. CLI clients perform one request only.

> Status: experimental. Setup, authorization and upload-to-group-file delivery passed local tests, a full build, and deployment health checks for `0.3.4-4b5d30118b40`. Upload integration used real HTTP and simulated NapCat; real two-computer group delivery remains unverified. This discovery-guidance and content-digest update audit requires separate verification of its final running version. Full Windows ZIP acceptance remains pending.

## Local plan and memory MCP (experimental)

Knowledge MCP now lives in the separate [`../rabi-mcp`](../rabi-mcp/README_en.md) application and is excluded from remote Agent update dependencies. The environment settings below apply to that separate application, not this worker's startup.

Configure the MCP host environment:

- `RABIROUTE_HOST_EXE`: optional local Host executable; defaults to the current user's standard installation.
- `RABI_MCP_ALLOWED_ROLES`: required JSON string array, for example `["example"]`. Tool arguments cannot expand this allowlist.
- `RABI_MCP_ALLOW_WRITES`: defaults to `false`. Only explicit `true` enables creation, updates, and recent-memory detail reads that update view timestamps.

Tools cover knowledge search, plan lists/details/status catalogs, memory lists and consolidated details. Writes add plan and recent-memory creation/updates. Updates require the exact strong ETag; mutations require a previously saved stable idempotency key. Recent details follow the current Manager touch receipt contract; a read-only Manager without that receipt is not confirmed successful. No deletion, consolidation execution, archival writes, attachments, task bindings or arbitrary HTTP requests are exposed.

35 isolated module, official SDK in-memory and real stdio subprocess tests pass, including clean exit and protocol-only stdout. Local Host dynamic identity discovery has also been checked against a running Host; no real plans or memories were read or written in these tests. Installation/release, actual Agent tool registration, and phone/glasses acceptance remain pending. The phone's Relay management page is not an MCP host; this entry does not mean the glasses' bound Agent has loaded these tools.

## First connection

1. Choose the target operating system under **Remote Agent** in the host WebGUI, then copy its setup prompt. Install only the computer client with Node.js 22.13+; no running Codex/DSH host or binding to the installing Agent's current task is required.
2. The prompt uses a single-use ticket, valid for 30 minutes by default, to download the signed connector. `--bootstrap` exchanges it for an independent `nodeCredential`. The credential stays in current-user private configuration; Manager stores only the secret hash and grants. Login startup entries contain no credentials. The ticket is not a shared WebGUI Token and cannot be reused after a successful exchange.
3. The connector automatically verifies the enrolled node identity. `/api/lan-agent/self` is diagnostic only; `connected=false` does not invalidate credentials or require manual verification or rebinding. **Enable Agent** (Chinese label: **是否启用Agent**) is checked by default for new enrollments. Enabled remote Agents are used in the same way as local Agents, without a separate API or skills grant. For message delivery, select the exact Agent under **RemoteAgent(<IP address>)** in the Route's message adapter and save.

For a first computer-only installation, omit `RABI_AGENT_TYPE`, Codex task and DSH session variables. `--bootstrap` saves `agents: []`; normal startup, login startup and reconnection require no Agent task. Existing configurations retain their original Agent and node identities. Register Agents through the supported entry point later; ordinary authenticated Agents use the same plan, memory and skill APIs without a controlling-Agent role.

Manager is the sole owner of remote enablement. Switch changes immediately send a PUT, and disabling works while offline without saving execution parameters. For enrolled nodes, the CLI, Hooks and execution paths no longer use the legacy local `enabled` field as a second gate. On initial enrollment, a legacy explicit disable is migrated only when Manager has no existing decision; existing enable or disable decisions always win across reconnects. Saving tasks, workspaces or models does not change enablement and removes the legacy remote field. Failed reads show an error rather than assuming enabled. Connector updates and actual calls across two computers require separate verification.

See [Remote Agent setup and updates](../../docs/lan-rabi-agent-bootstrap_en.md) for installation, private directories, credential migration and recovery. Use the single generated prompt instead of maintaining another manual template:

```bash
node rabi-agent.mjs --bootstrap
```

Provide `RABI_MANAGER_URL`, `RABI_AGENT_BOOTSTRAP_TICKET`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS` and `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` only to the installation child process. Codex uses `RABI_AGENT_TYPE=codex-desktop` and `RABI_AGENT_CODEX_THREAD_ID`; DSH uses `RABI_AGENT_TYPE=dsh`, `RABI_AGENT_DSH_URL` and `RABI_AGENT_DSH_SESSION_ID`. Never put credentials in command arguments, logs or repositories; tickets are for private setup only.

The connector automatically updates from Manager's signed content digest unless explicitly configured with `autoUpdate=false`, including changed content with the same version. One stable launcher supervises one worker. Candidate handoff follows prepared → drain → old connection closed → activate → pointer commit → release execution; failure retains the old release without cancelling or resending business work. Current-user login startup, bounded recovery, legacy migration and real-device acceptance follow the [canonical bootstrap contract](../../docs/lan-rabi-agent-bootstrap_en.md#setup-and-update-prompt). Valid credentials are not redeemed again or rebound; replacing files does not establish host hot loading.

## Use Manager from an existing task

On remote computers, prefer the installed connector's `--api` command supplied by the Hook. Local Host discovery applies only on the Manager computer; no Host on the remote computer does not mean Manager is offline. Discovery uses `/api/lan-agent/capabilities` and `/api/lan-agent/resources`. The catalog advertises only readable files and references, including the four public contracts and their English counterparts. Read returned IDs; arbitrary Markdown links do not grant resource access.

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

General syntax: `--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`. Select the exact Agent from private configuration. The CLI reads `nodeCredential` automatically and rejects old shared credentials. Read the current contract before mutations, supply JSON through standard input, and provide the required strong ETag and stable idempotency key. The CLI checks Manager `/meta` before and after calls. On timeout, 503, `uncertain` or a generation change after a write, read authoritative state before acting and never replay automatically. On 412, read again and reconfirm intent.

Generic HTTP calls support `--raw-stdin` (text), `--body-file FILE` (binary stream), repeated `--header 'Name: value'` (business headers), `--output FILE` (binary/text download), `--stream --output FILE` (bounded stream consumption), `--timeout-ms MS`, and `--no-replay`. Body formats are mutually exclusive. Credentials, internal source proofs, Host and generation headers belong to the transport and cannot be overridden. Outputs use sibling temporary files and non-overwriting commits; failed or generation-changed calls do not commit. Streams never replay automatically. Unlimited live stdout and WebSocket are outside this HTTP CLI's transport capabilities, not permission denials. Module callers can explicitly consume stream callbacks. Skill downloads retain the strict ZIP verification operation.

The transport treats recent-memory detail GET requests as stateful operations because they update view timestamps: failures or generation changes are not replayed automatically and are reported as `uncertain`. Module callers can also use `replaySafe: false` to disable replay for other stateful queries; this option cannot enable automatic POST/PATCH replay. Both direct and `data`-wrapped `/meta` responses undergo the same identity check. This change has source and isolated-test verification only; it is not deployed yet.

Authenticated remote Agents have access to all public RabiPC APIs unless the user explicitly disables them. The operation catalog is discovery, not a feature allowlist; public management settings are not additionally denied because the caller is remote. The connector automatically handles credentials, current-generation identity and generation headers, without manual identity checks or rebinding by the Agent. Shared parameter, object, Action Gate, file-root, version and idempotency contracts still apply; Host-private control protocols are not public Manager APIs. Resources are limited to public documents, skills and controlled text directly referenced within the same skill package, not an arbitrary filesystem. Fetch the latest skills and contracts published by Manager on demand. Do not copy plans, memories or message-processing state into a second business-state authority.

Management enable/disable operations retain the compatible `authorization` endpoint and `enabledAgentIds` state projection, not a second API permission switch. See the [setup API contract](../../docs/lan-rabi-agent-bootstrap_en.md#api) for concurrency, idempotency and uncertain-result readback.

For cross-Agent delivery, the remote primary-session source is recorded in an instance namespace. Only one-way delivery with `responsePolicy: "none"` is supported. Without a trusted return route, `responsePolicy: "required"`, formal replies using `inReplyToRequestId`, and remote-to-remote delivery are explicitly rejected; this is not full formal-reply support. Remote context uses only its own dedicated `context` endpoint, not the generic `codex-hook` APIs.

Remote channel sends still obey Route send permissions: `onlyPrimary` requires all of the trusted `provider`, Route `instanceId`/`nodeId` and `agentId`, approved session, and `primary_persona` identity to match; a matching bare session ID does not inherit local permissions.

## Upload a remote file, then send it to a QQ group

> Experimental contract: upload passed local real-HTTP and simulated-NapCat integration, a full build and deployment health checks. No test file was sent to a real group; real two-computer group-file acceptance remains pending.

Requires an independent node credential, a controlling-Manager-approved primary Agent, and the exact NapCat Route permitting `file` sends. Upload and send are separate operations: upload success never sends a group file automatically. Run from the verified release directory:

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` must be a stable UUID saved beforehand; it is not generated automatically. Supply the following JSON to the third command through standard input. Replace identities and targets with exact values from the current template, use upload `data.id` for `fileId`, and save a separate stable `deliveryId` for sending:

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<approved-complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "<upload-data.id>", "fileSha256": "<upload-data.sha256>" }
}
```

Upload uses `PUT /api/agent/uploads/<UUID>` with raw binary bytes, the same UUID as `Idempotency-Key`, a URI-encoded basename, and the content SHA-256. `GET` on the same path returns `{code:0,data:{id,fileName,size,sha256,expiresAt}}`; `expiresAt` is an ISO timestamp and Manager's `path` is not exposed. Defaults are 2 GiB per file (2048 MiB, the hard maximum), 4 GiB total, at most 100 files, and a 24-hour TTL; HTTP uploads have a total concurrency limit of 4 across owners. After a timeout, 503, generation change or uncertain result, verify the current Manager and GET the original ID first. Retain the original key and file; never automatically retry or change the ID.

Large uploads use backpressured streaming and incremental SHA-256 with a 30-minute deadline. Manager RabiLink → Configuration accepts `agentUploads.maxFileMiB` (integer `1..2048`, default `2048`), stored in `data/Config.json` and effective after Manager restarts. `PATCH /api/rabi/identity` reuses authenticated connection access; remote Agents can modify it under the same strong ETag, idempotency and parameter contracts, without a second feature allowlist. The client hard maximum is 2 GiB, and a lower server setting rejects larger files.

A 734 MiB (769654784-byte) file passed size/SHA-256 integration verification through the real client → loopback Manager → file storage → simulated NapCat. Generation and reading used small chunks, with guards against Buffer allocations/concatenations above 8 MiB. Set `RABI_TEST_LARGE_UPLOAD=1` to run the opt-in case; routine runs skip it and temporary files are cleaned afterward. Actual QQ size/group-permission limits remain unverified. Existing legacy connectors need the new bootstrap described above, and hosts caching the old Hook must reload before retrying; changing the server quota does not upgrade remote code.

A `fileId` also requires `fileSha256=upload data.sha256` (64 lowercase hexadecimal characters), preventing UUID reuse after 24-hour expiry from replacing the content behind an old reference. The send callback checks the actual hash inside the lease and rejects a mismatch.

Files belong to `nodeId + agentId` and can be shared across that Agent's sessions, but still require a trusted, approved source. `fileId` is for NapCat group files only, mutually exclusive with `path`/`url`/`fileName`, and cannot send images, voice or another channel. The display name comes from upload metadata. `payload.text` is optional; `replyToMessageId` must be an empty string or a concrete source message ID. Manager's internal trusted resolver checks authorization, ownership, integrity and TTL per request, with an inflight lease protecting active files. It does not expand `allowedFileRoots`; the existing local path flow remains unchanged. `onlyPrimary` still checks the exact Route's remote binding and approved session.

Require both Manager and channel send receipts. File upload, caption and whole-request completion are separate evidence. A missing caption cannot mark the whole request successful or authorize automatic caption/file resend or a new deliveryId. Verify the original request read-only, then act only under specific user authorization. NapCat on another machine still needs a shared directory making Manager's file path readable; this is not arbitrary cross-machine NapCat support. See the [Agent interface contract](../../docs/rabi-agent-interfaces_en.md#uploading-from-a-remote-agent-before-sending-a-group-file-experimental-contract) for headers, security and readback details. The formal-reply `none` restriction above remains unchanged.

## Older installations and runtime limits

- Old configurations without `nodeCredential` must enroll again with a fresh ticket; `lanLinkToken` cannot be migrated into a node credential. Preserve the instance, Agents, tasks and permitted workspaces. Reconnecting with an independent credential does not exchange another ticket.
- Before opening HTTP/WS listeners, the new source checks for old `lan-agent-tasks.json`. Without a completion marker, it rotates the WebGUI Token even if that registry is empty, writes the marker after success, and aborts startup on failure. Obtain new browser remote links locally when old links stop working. Confirm revocation or rotation for exposed keys outside this detection scope too; an unrotated shared key may still bypass node grants. A successful deployment and healthy Host do not establish older-node migration acceptance. Re-enrollment and invalidation of old keys still require per-node verification; do not describe all existing installations as already automatically secured.
- Bootstrap pins the release public-key SHA-256 fingerprint. Content-digest automatic updates verify this pin, Ed25519 and every file hash. IPC preparation, task draining, connection handoff, pointer commit and rollback follow the [bootstrap contract](../../docs/lan-rabi-agent-bootstrap_en.md).
- Does not include Manager, Gateway, WebGUI, pairing codes or device passwords. Standard DNS-SD dynamically discovers the enrolled Manager without port scanning. No fallback Runtime is started. An unavailable Codex owner or DSH binding fails without switching to the other host.
- Each computer is an instance with multiple Agents. Legacy single-task settings no longer synthesize a `default` Agent. Existing catalog identities are preserved; each delivery explicitly specifies its provider and full session ID. Execution configuration stays on that computer, with unified Manager administration.
- A connected node, queued task or passing local fixture does not prove a completed reply. Cross-computer continuous delivery, login startup, disconnect/update recovery and advanced plan/memory workflows still require real-device acceptance.
