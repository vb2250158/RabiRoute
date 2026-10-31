<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">简体中文</a> | English
</div>
<!-- /docs-language-switch -->

# Rabi Agent

The connector reads timeout settings from identity-verified `/meta.timeoutOverrides`. Its existing endpoint configuration owner persists `timeoutOverridesCache`. WebGUI settings control ordinary requests, sends, uploads, downloads, discovery, and local delivery-control waits. Ordinary requests adopt the settings after verification; uploads/downloads freeze their budget at operation start. The first operation without a cache uses defaults and the next operation uses the verified cache. Explicit per-call `timeoutMs` and cancellation signals still bound that operation. This cache supports offline startup; it is not a separate configuration source. Restoring defaults removes cached overrides.

Connector 0.2.11 refreshes the stable launcher from the committed successor before reporting update success. Preparation and connection leave the old launcher intact. A post-commit write failure exits abnormally for recovery by the existing owner, retaining identity, credentials and tasks instead of leaving old control code until a manual restart.

Connector 0.2.10 fixes launcher status and recovery commands incorrectly applying the 512-character handshake limit to status receipts. Authenticated responses carry the full bounded status history and preserve chunked Unicode text; owner authentication, instance enablement and configuration remain unchanged.

Connector 0.2.9 reports the OS hostname as the default remote instance label. Existing unnamed nodes acquire it after upgrading and reconnecting. Manual aliases take precedence; clearing an alias restores the hostname. Older nodes without a hostname temporarily show their instance ID.

Connector 0.2.6 makes the copied connection prompt sufficient for enrollment and credential repair; no additional Agent approval or controlling Agent is required. Valid saved credentials are reused. If credentials are missing or rejected, the fresh ticket repairs the original node while preserving backend settings, workspaces and explicit disables. Before exchange, the client saves a private `config.json.enrollment.json` recovery record containing its node identity and a random recovery secret, never the ticket. A lost response is resolved by authenticating the same credential. After interruption, rerun the same `--bootstrap`; an exact completed exchange can also be recovered after Manager restart. Deleted nodes and replaced credentials cannot be restored with a spent ticket. Keep the recovery file private until success, when it is removed. Only an expired or unavailable ticket requires copying a fresh prompt.

Rabi Agent is a remote computer client. Windows provides a tray and status window; macOS/Linux run in the background. It connects outbound to the controller's Rabi Manager and exposes computer APIs. Associated Agents optionally execute tasks through Codex Desktop IPC or the DSH local `session.prompt` API.

The host computer's Rabi service owns persistent management; a separate controlling Agent is not required. Ordinary authenticated Agents can also query plans, recent and consolidated memory, and skills without a primary-persona or Route grant. Computer capabilities depend on the platform and do not require a running Codex/DSH backend. See [host and remote computer clients](../../docs/remote-computer-client_en.md).

## Mac setup and terminals

Codex Desktop IPC tries explicit `CODEX_DESKTOP_IPC_PATH`, `$CODEX_HOME/ipc/ipc.sock` (default `~/.codex/ipc/ipc.sock`), then the older temporary `codex-ipc/ipc-<uid>.sock` path. The older path remains for Desktop versions using that layout and will leave with support for those versions. A connection failure does not change the environment, create socket aliases, or start or restart Desktop.

Select **Mac (macOS)** in the enrollment dialog before copying its platform-specific prompt. Windows and Linux have their own choices. Installation no longer associates the installing Agent or chooses a default task. Mac requires Node.js 22.13+ matching its CPU architecture, installs under `~/Library/Application Support/RabiAgent`, and uses a current-user LaunchAgent without the Windows tray.

Connector 0.2.4 adds interactive Zsh/Bash/sh terminals and advertises only shells present on that computer. Install with `npm install --omit=dev --include=optional`; the pinned node-pty dependency may need Xcode Command Line Tools for native compilation. File transfer and explicitly addressed Agent delivery reuse the shared APIs. Window queries, screenshots, CMD and PowerShell remain Windows capabilities.

POSIX update preparation restores a missing owner execute bit on node-pty's prebuilt `spawn-helper`, then runs the native empty-terminal check. It preserves helper contents and retains the previous connector when verification fails.

Native Mac terminals and Desktop IPC still require online-device acceptance. `401 LAN_AGENT_CREDENTIAL_REQUIRED` is a node credential failure: retain its nodeId and configuration rather than creating a controlling Agent, another node or repeatedly reinstalling.

## Query Agents and specify the delivery target

`GET /api/lan-agent/instances` returns computers and their Agent catalogs. Query an Agent's `/threads` endpoint with `action:list` and explicit `agentAdapter`, then supply `provider`, the full `threadId` and message on every `/tasks` delivery. Delivery no longer uses an implicit `default` or requires rebinding a configured task first. See the [remote target contract](../../docs/rabi-agent-interfaces_en.md#explicit-remote-agent-targets-and-list-queries) for requests, pagination and idempotency.

## Remote terminals (0.2.2, experimental)

In the host WebGUI, expand an online computer under **RabiLink → Remote Agents** and choose **Remote terminal**. Windows supports **CMD** and **PowerShell** by default, without another feature switch.

1. Choose a shell, optionally enter an existing absolute directory on the remote computer, and create a terminal.
2. Type directly into the terminal. Chinese text, paste, Ctrl+C and resizing are supported; directory and environment persist within the session.
3. Query terminals to read actual remote sessions and process state. Closing the window retains sessions; reopen it to attach to an existing terminal.
4. Exit a terminal with its stop button to end that shell and its descendants. Main-program exit, connector shutdown or transport disconnection also ends terminals. Commands are never automatically rerun.

Shells run as the connector's Windows user over the existing authenticated connection, without another management password or per-feature grant. One main program owns the connector, which owns native terminal hosts. Each host uses a Windows Job Object for the shell and its children. ConPTY provides terminal semantics; the browser uses xterm.js. The required OS interface is available on Windows 10 version 1809 and later.

Each node supports up to eight active terminals and 64 hot session records. When capacity is reached, confirmed exited records are archived without loss under `terminal-history/` beside the connector configuration. The original ID remains queryable; opening it again returns the previous terminal state without launching a shell. Active, closing and uncertain sessions are retained. Archive failures affect only new terminal admission; existing query/close operations remain available. Archived records are not automatically deleted, so disk usage is not capped by the hot-record limit. Manager output replay remains temporary: completed streams without viewers may be evicted, and reopened exited terminals report missing output as a gap rather than complete empty history. Replay retains only the latest 256 KiB in memory; browser scrollback is limited to 2000 lines. Commands and output are not written to logs. After lost responses, query the existing session and input sequence instead of recreating it or replaying input. Exit active terminals before restarting or updating the connector.

Local native-shell, HTTP/WebSocket/SSE and input-receipt validation is covered. Installed and real two-computer acceptance are tracked separately.


## Windows tray (0.2.1, experimental)

The tray and status window use the Rabi icon included in the signed release package.

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
- `RABI_MCP_ALLOWED_ROLES`: optional JSON string array, for example `["example"]`. Omission allows every role, explicit `[]` disables every role, and a supplied list restricts access to its entries.
- `RABI_MCP_ALLOW_WRITES`: defaults to `true`. Only explicit `false` disables creation, updates, and recent-memory detail reads that update view timestamps.

Default tools cover knowledge search, plan lists/details/status catalogs, memory lists/details, and plan and recent-memory creation/updates. Explicitly disabling writes hides mutations and recent details that update view timestamps. Updates require the exact strong ETag; mutations require a previously saved stable idempotency key. Recent details follow the current Manager touch receipt contract; a read-only Manager without that receipt is not confirmed successful. No deletion, consolidation execution, archival writes, attachments, task bindings or arbitrary HTTP requests are exposed.

35 isolated module, official SDK in-memory and real stdio subprocess tests pass, including clean exit and protocol-only stdout. Local Host dynamic identity discovery has also been checked against a running Host; no real plans or memories were read or written in these tests. Installation/release, actual Agent tool registration, and phone/glasses acceptance remain pending. The phone's Relay management page is not an MCP host; this entry does not mean the glasses' bound Agent has loaded these tools.

## First connection

1. Choose the target operating system under **Remote Agent** in the host WebGUI, then copy its setup prompt. Install only the computer client with Node.js 22.13+; no running Codex/DSH host or binding to the installing Agent's current task is required.
2. The prompt uses a single-use ticket, valid for 30 minutes by default, to download the signed connector. `--bootstrap` exchanges it for an independent `nodeCredential`. The credential stays in current-user private configuration; Manager stores only the secret hash and grants. Login startup entries contain no credentials. The ticket is not a shared WebGUI Token and cannot be reused after a successful exchange.
3. The connector automatically verifies the enrolled node identity. `/api/lan-agent/self` is diagnostic only; `connected=false` does not invalidate credentials or require manual verification or rebinding. **Enable Agent** (Chinese label: **是否启用Agent**) is checked by default for new enrollments. Enabled remote Agents are used in the same way as local Agents, without a separate API or skills grant. For message delivery, select the exact Agent under **RemoteAgent(<IP address>)** in the Route's message adapter and save.

For a first computer-only installation, omit `RABI_AGENT_TYPE`, Codex task and DSH session variables. `--bootstrap` saves `agents: []`; normal startup, login startup and reconnection require no Agent task. Existing configurations retain their original Agent and node identities. Later calls need no Agent registration; ordinary authenticated Agents use the same plan, memory and skill APIs without a controlling-Agent role.

Manager is the sole owner of remote enablement. Switch changes immediately send a PUT, and disabling works while offline without saving execution parameters. For enrolled nodes, the CLI, Hooks and execution paths no longer use the legacy local `enabled` field as a second gate. On initial enrollment, a legacy explicit disable is migrated only when Manager has no existing decision; existing enable or disable decisions always win across reconnects. Saving tasks, workspaces or models does not change enablement and removes the legacy remote field. Failed reads show an error rather than assuming enabled. Connector updates and actual calls across two computers require separate verification.

See [Remote Agent setup and updates](../../docs/lan-rabi-agent-bootstrap_en.md) for installation, private directories, credential migration and recovery. Use the single generated prompt instead of maintaining another manual template:

```bash
node rabi-agent.mjs --bootstrap
```

Provide `RABI_MANAGER_URL`, `RABI_AGENT_BOOTSTRAP_TICKET`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS` and `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` only to the installation child process. Codex uses `RABI_AGENT_TYPE=codex-desktop` and `RABI_AGENT_CODEX_THREAD_ID`; DSH uses `RABI_AGENT_TYPE=dsh`, `RABI_AGENT_DSH_URL` and `RABI_AGENT_DSH_SESSION_ID`. Never put credentials in command arguments, logs or repositories; tickets are for private setup only.

The connector automatically updates from Manager's signed content digest unless explicitly configured with `autoUpdate=false`, including changed content with the same version. One stable launcher supervises one worker. Candidate handoff follows prepared → drain → old connection closed → activate → pointer commit → release execution; failure retains the old release without cancelling or resending business work. Current-user login startup, bounded recovery, legacy migration and real-device acceptance follow the [canonical bootstrap contract](../../docs/lan-rabi-agent-bootstrap_en.md#installation-and-releases). Valid credentials are not redeemed again or rebound; replacing files does not establish host hot loading.

## Use Manager from an existing task

**New source capability; installed acceptance pending:** `--operation <operationId>` resolves method/path from schema-v2 `GET /api/agent/help`. `--path-params` and `--query` accept JSON objects; body, output, and idempotency options reuse `--api`. For example, `--operation manager.api.help --agent-type <type> --id <fullSessionId>` reads the new catalog. Each operation conditionally verifies its cache on demand. Catalog changes, event reconnects, and identity changes invalidate it; business calls are never automatically replayed. Older deployments use original `--api` calls with known contracts. A missing discovery entry is not remote disablement. See [target architecture](../../docs/api-contract-discovery-target-architecture_en.md) for full-coverage and migration status.

Operation calls accept declared legacy-ID aliases and still reach one canonical handler. SSE requires an explicit output file or module `onChunk` consumer; a module callback selects stream mode automatically. Unsupported transports are rejected before invocation for that operation only, never treated as missing permission. Authenticated isolated HTTP tests cover independently declared plugin JSON and SSE APIs without new client path mappings.

On remote computers, prefer the installed connector's `--api` command supplied by the Hook. Local Host discovery applies only on the Manager computer; no Host on the remote computer does not mean Manager is offline. Discovery uses `/api/lan-agent/capabilities` and `/api/lan-agent/resources`. The catalog advertises only readable files and references, including the four public contracts and their English counterparts. Read returned IDs; arbitrary Markdown links do not grant resource access.

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent-type <type> --id <fullSessionId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent-type <type> --id <fullSessionId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent-type <type> --id <fullSessionId>
```

Reliable Agent sends are durably accepted by the original client and resumed in the background. Local acceptance is distinct from target delivery. The stable launcher supports `--delivery-submit`, `--delivery-query`, and `--delivery-list`; existing `--api POST /api/agent/threads` send calls use the same path. Other mutations do not automatically replay. See [reliable delivery and records](../../docs/reliable-agent-delivery_en.md).

General syntax: `--api METHOD /path --agent-type TYPE --id FULL_SESSION_ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`. Provide the actual Agent type and full session ID on each call; no registration or binding is required. The CLI reads `nodeCredential` automatically and rejects old shared credentials. Read the current contract before mutations, supply JSON through standard input, and provide the required strong ETag and stable idempotency key. The CLI checks Manager `/meta` before and after calls. On timeout, 503, `uncertain` or a generation change after a write, read authoritative state before acting and never replay automatically. On 412, read again and reconfirm intent.

Connector 0.2.12 uses the file-upload waiting budget (30 minutes by default) for `POST /api/agent/send`, including file verification and platform upload. Explicit `--timeout-ms` takes precedence. Cancellation or timeout does not prove failure: query the original deliveryId receipt and never replay automatically. NapCat failures retain the action, HTTP status, retcode or safe transport error code, without raw upstream text, credentials or host paths. Missing diagnostics cannot be reconstructed for historical generic 502 receipts.

Generic HTTP calls support `--raw-stdin` (text), `--body-file FILE` (binary stream), repeated `--header 'Name: value'` (business headers), `--output FILE` (binary/text download), `--stream --output FILE` (bounded stream consumption), `--timeout-ms MS`, and `--no-replay`. Body formats are mutually exclusive. Credentials, internal source proofs, Host and generation headers belong to the transport and cannot be overridden. Outputs use sibling temporary files and non-overwriting commits; failed or generation-changed calls do not commit. Streams never replay automatically. Live stdout is outside this file-output mode. WebSocket operations use the explicit frame mode below. Module callers can explicitly consume stream callbacks. Skill downloads retain the strict ZIP verification operation.

Source resource APIs accept `x-rabilink-resource-owner` through `--header` to select existing data targets; this is not a connection credential. The connector fills generation/instance headers automatically. Resources keys and internal forwarding proofs remain transport-protected. Module binary calls use `bodyBytes`, `responseMode: "bytes"` and response `bodyBytes`; CLI calls use `--body-file` / `--output`. See [resource API contracts](../../docs/rabi-agent-interfaces_en.md#executable-resource-cache-and-recording-archive-contracts-source-connected-installed-acceptance-pending). Installation and real two-computer acceptance remain pending.

The transport treats recent-memory detail GET requests as stateful operations because they update view timestamps: failures or generation changes are not replayed automatically and are reported as `uncertain`. Module callers can also use `replaySafe: false` to disable replay for other stateful queries; this option cannot enable automatic POST/PATCH replay. Both direct and `data`-wrapped `/meta` responses undergo the same identity check. This change has source and isolated-test verification only; it is not deployed yet.

Authenticated remote Agents have access to all public RabiPC APIs unless the user explicitly disables them. The operation catalog is discovery, not a feature allowlist; public management settings are not additionally denied because the caller is remote. The connector automatically handles credentials, current-generation identity and generation headers, without manual identity checks or rebinding by the Agent. Shared parameter, object, Action Gate, file-root, version and idempotency contracts still apply; Host-private control protocols are not public Manager APIs. Resources are limited to public documents, skills and controlled text directly referenced within the same skill package, not an arbitrary filesystem. Fetch the latest skills and contracts published by Manager on demand. Do not copy plans, memories or message-processing state into a second business-state authority.

Remote connector 0.2.6 authenticates the entire computer with its enrollment credential. Enable Agent is one instance-wide switch, enabled by default. An enabled instance can use all public host APIs, including renaming, plans, memory, Skills, files and tasks, without browser login, a primary Agent, session registration, binding or per-feature grants. Every Agent call supplies its actual type and complete session ID; directories and session lists are discovery, not permissions.

Use `PUT /api/lan-agent/instances/:instanceId/enabled` with `{enabled, expectedEnabled}` booleans. Read the current value first and read it back after saving. The retired per-Agent `/authorization` endpoint no longer exists. Switching the instance off and on fences old in-flight requests.

Cross-Agent delivery explicitly supplies source and target types, complete IDs and computer locations, and reconciles the same original delivery and receipt. Do not infer sessions from historical Agent bindings. Hooks use `/api/codex-hook/context` with the actual type and complete session ID.

Channel sends reuse the authenticated instance connection. The sender supplies its actual type and full session ID; Route-primary and saved session bindings do not add permission gates. Preserve the original deliveryId, exact target, channel parameters and both Manager/channel receipts.

The source generic connector supports final multi-segment parameters declared by discovery in `request.pathTails`. `path.assetPath` retains nested directories and encodes each segment independently, for example `lib/manager-client.mjs`. See the four [Agent resource and release contracts](../../docs/rabi-agent-interfaces_en.md#remote-agent-resources-and-release-contracts-source-connected-installed-acceptance-pending). Existing signed-download verification and installation-receipt requirements remain effective.

Source terminal and computer operations now participate in unified API discovery. Retain the original computer and terminal/upload ID without binding an Agent backend. After stream disconnection, query original state; uncertain input or file commits retain their sequence and ID. See [terminal and computer contracts](../../docs/rabi-agent-interfaces_en.md#remote-terminal-and-computer-contracts-source-connected-installed-acceptance-pending) for paths, actions and recovery. Installed and real two-computer acceptance remain pending.

## Upload a remote file, then send it to a QQ group

> Experimental contract: upload passed local real-HTTP and simulated-NapCat integration, a full build and deployment health checks. No test file was sent to a real group; real two-computer group-file acceptance remains pending.

Requires an independent node credential, a controlling-Manager-approved primary Agent, and the exact NapCat Route permitting `file` sends. Upload and send are separate operations: upload success never sends a group file automatically. Run from the verified release directory:

```bash
node rabi-agent.mjs --upload <file> --agent-type <type> --id <fullSessionId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent-type <type> --id <fullSessionId>
node rabi-agent.mjs --api POST /api/agent/send --agent-type <type> --id <fullSessionId> --body-stdin
```

`--upload-id` must be a stable UUID saved beforehand; it is not generated automatically. Supply the following JSON to the third command through standard input. Replace identities and targets with exact values from the current template, use upload `data.id` for `fileId`, and save a separate stable `deliveryId` for sending:

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "<upload-data.id>", "fileSha256": "<upload-data.sha256>" }
}
```

Upload uses `PUT /api/agent/uploads/<UUID>` with raw binary bytes, the same UUID as `Idempotency-Key`, a URI-encoded basename, and the content SHA-256. `GET` on the same path returns `{code:0,data:{id,fileName,size,sha256,expiresAt}}`; `expiresAt` is an ISO timestamp and Manager's `path` is not exposed. Defaults are 2 GiB per file (2048 MiB), at least 16 GiB total with capacity for one maximum-size file, at most 100 files, and a 24-hour TTL. Capacity, record count, TTL and HTTP concurrency are configurable through [Manager environment settings](../../docs/connection-access_en.md). After a timeout, 503, generation change or uncertain result, verify the current Manager and GET the original ID first. Retain the original key and file; never automatically retry or change the ID.

Large uploads use backpressured streaming and incremental SHA-256 with a 30-minute deadline. Manager RabiLink → Configuration accepts `agentUploads.maxFileMiB` (integer `1..8589934591`, default `2048`; the upper bound preserves exact byte counts), stored in `data/Config.json` and effective after Manager restarts. `PATCH /api/rabi/identity` reuses authenticated connection access; remote Agents can modify it under the same strong ETag, idempotency and parameter contracts, without a second feature allowlist. The client has no additional 2 GiB ceiling. It follows `agentUploads.maxFileMiB` when published by the current verified `/meta`; older servers without this field enforce their own limit.

A 734 MiB (769654784-byte) file passed size/SHA-256 integration verification through the real client → loopback Manager → file storage → simulated NapCat. Generation and reading used small chunks, with guards against Buffer allocations/concatenations above 8 MiB. Set `RABI_TEST_LARGE_UPLOAD=1` to run the opt-in case; routine runs skip it and temporary files are cleaned afterward. Actual QQ size/group-permission limits remain unverified. Existing legacy connectors need the new bootstrap described above, and hosts caching the old Hook must reload before retrying; changing the server quota does not upgrade remote code.

A `fileId` also requires `fileSha256=upload data.sha256` (64 lowercase hexadecimal characters), preventing UUID reuse after 24-hour expiry from replacing the content behind an old reference. The send callback checks the actual hash inside the lease and rejects a mismatch.

Uploader identity supports auditing and accounting, not a second access grant. Other authenticated connections can query the original upload ID and reference fileId plus SHA-256. Actual-byte integrity, TTL, concurrency and capacity checks still apply. Retain original IDs after uncertainty; do not replay uploads or sends automatically. See the Agent interface contract for transport and channel receipts.

Require both Manager and channel send receipts. File upload, caption and whole-request completion are separate evidence. A missing caption cannot mark the whole request successful or authorize automatic caption/file resend or a new deliveryId. Verify the original request read-only, then act only under specific user authorization. NapCat on another machine still needs a shared directory making Manager's file path readable; this is not arbitrary cross-machine NapCat support. See the [Agent interface contract](../../docs/rabi-agent-interfaces_en.md#uploading-from-a-remote-agent-before-sending-a-group-file-experimental-contract) for headers, security and readback details. Formal replies follow the current Agent delivery contract and original request receipt.

### WebSocket CLI (source connected; installed acceptance pending)

Use `--operation <operationId> --websocket --output frames.jsonl` to open from active discovery. Existing `--path-params`, `--query`, business `--header` and actual source identity still apply. With `--frames-stdin`, stdin sends JSONL frames incrementally instead of an HTTP body:

```bash
node rabi-agent.mjs --operation <operationId> --websocket --frames-stdin --output frames.jsonl --agent-type <type> --id <fullSessionId> --timeout-ms 30000
```

| Input line | Behavior |
| --- | --- |
| `{"type":"json","data":{"type":"example"}}` | Send under the target JSON contract; native protocol fields remain native |
| `{"type":"text","data":"hello"}` | Send text; JSON mode still validates serialized JSON text |
| `{"type":"binary","data":"AAE="}` | Strictly decode Base64 and send the original bytes |
| `{"type":"close","code":1000,"reason":"done"}` | Explicitly request closure without stdin EOF |

The target contract owns frame types, schemas and first-message requirements. CLI creates no login, hello, task or business receipt and does not register another Agent. Stdin EOF only stops sending; receive continues until remote closure, explicit close or deadline. Omit `--frames-stdin` for receive-only use. HTTP bodies, `--upload` and `--stream` are incompatible with this mode.

Output uses the same json/text/binary JSONL envelope per frame: JSON is decoded and binary data is Base64. Native write callbacks backpressure stdin; disk writes backpressure receiving. Normal remote EOF drains accepted frames. Controlled cancellation and abnormal closure stop later consumption and join accepted writes. JSON/text redact this connection's credential; binary reflection of that credential fails without publishing a file.

`--timeout-ms` covers discovery, handshake and the entire connection, defaulting to 30 seconds. `--ws-max-output-bytes` sets the local JSONL budget, default 256 MiB. `--ws-max-message-bytes` and `--ws-max-buffered-bytes` adjust local opaque-proxy consumer budgets. `--ws-protocols '["protocol.v1"]'` explicitly selects subprotocols. These budgets create no server business limit or feature permission.

Output commits without overwrite only after normal 1000 closure, completed writes and original Manager generation/instance verification; failures remove this invocation's partial file. Stdout contains only the receipt and file digest. `ok`, `framesSent` and `framesReceived` describe transport/capture. `businessOutcome: "not-evaluated"` leaves business completion to its protocol; `inputComplete` reports whether stdin was consumed. Failure never reconnects or replays.

## Older installations and runtime limits

- Old configurations without `nodeCredential` must enroll again with a fresh ticket; `lanLinkToken` cannot be migrated into a node credential. Preserve the instance, Agents, tasks and permitted workspaces. Reconnecting with an independent credential does not exchange another ticket.
- Before opening HTTP/WS listeners, the new source checks for old `lan-agent-tasks.json`. Without a completion marker, it rotates the WebGUI Token even if that registry is empty, writes the marker after success, and aborts startup on failure. Obtain new browser remote links locally when old links stop working. Confirm revocation or rotation for exposed keys outside this detection scope too; an unrotated shared key may still bypass node grants. A successful deployment and healthy Host do not establish older-node migration acceptance. Re-enrollment and invalidation of old keys still require per-node verification; do not describe all existing installations as already automatically secured.
- Bootstrap pins the release public-key SHA-256 fingerprint. Content-digest automatic updates verify this pin, Ed25519 and every file hash. IPC preparation, task draining, connection handoff, pointer commit and rollback follow the [bootstrap contract](../../docs/lan-rabi-agent-bootstrap_en.md).
- Does not include Manager, Gateway, WebGUI, pairing codes or device passwords. Standard DNS-SD dynamically discovers the enrolled Manager without port scanning. No fallback Runtime is started. An unavailable Codex owner or DSH binding fails without switching to the other host.
- Each computer is an instance with multiple Agents. Legacy single-task settings no longer synthesize a `default` Agent. Existing catalog identities are preserved; each delivery explicitly specifies its provider and full session ID. Execution configuration stays on that computer, with unified Manager administration.
- A connected node, queued task or passing local fixture does not prove a completed reply. Cross-computer continuous delivery, login startup, disconnect/update recovery and advanced plan/memory workflows still require real-device acceptance.

## Terminal history for computer uploads

Source capability: after an upload is confirmed committed or aborted, its real file handle is closed, and temporary data is cleaned, the client stores an immutable result under the original ID before acknowledging that operation. The hot map retains 64 recent upload records by default. Explicit `RABI_AGENT_COMPUTER_MAX_UPLOAD_RECORDS` still controls this budget (0 means unlimited). Capacity pressure evicts only closed terminal records that already have cold evidence. In-flight uploads, unconfirmed cleanup, and unconfirmed archival are retained; the existing four upload-resource quota is not increased.

History uses the client's existing local data directory under `runtime/computer-upload-history/<config-file-hash>/v1/`, with direct SHA-256-sharded lookup by upload ID and no startup-wide scan. Sibling configuration files have separate namespaces, reusing the existing delivery queue's stable config-path identity rather than credentials or Manager generations. An explicit config inside the source tree does not move history beside it. If the data root itself is explicitly inside a repository, the history directory must remain Git-ignored and untracked.

The same ID and parameters retain their original begin/status/commit/abort facts; an aborted upload cannot be committed, and conflicting parameters are rejected. Hot compaction never rewrites uploaded content, recommits the destination, or changes IDs. An archive I/O error fails only that operation while preserving the hot fact and user file. If the file may already be committed, query the original ID. A failed metadata temporary whose handle truly closed can be rebuilt in a retry slot from the same fact; the first incomplete slot reserves the ID until final publication. Incomplete or conflicting evidence from an older process remains an error, never a fresh upload.

This count-triggered archival/cache policy explicitly replaces the generic24/72-hour windows: completion within one hour must not permanently exhaust64 entries. Activity time is actual cleanup completion; reads do not refresh it. Cold facts do not expire or get deleted automatically. Disk failures and unconfirmed handle closure remain visible. Connection authentication, user disable settings, and computer permissions are unchanged. Unknown results from older versions are not reconstructed automatically. Installed-client upgrades, live-state migration, and real two-computer acceptance remain separate verification steps.

## Management request isolation

Session listing, session reads and reconciliation of original delivery receipts use independent bounded read lanes. Operations on the same original receipt remain serialized. Creation and mutation use a separate bounded management queue while retaining their relative order. Prepared message dispatch uses a separate bounded lane, with operations on the same original receipt still serialized. These operations no longer wait for legacy task acceptance; the original host and delivery receipt still confirm actual dispatch, and unknown results are never replayed. This change does not prove that all host management timeouts are fixed. Reconcile the original ID after a timeout or unknown result; do not replay automatically.
