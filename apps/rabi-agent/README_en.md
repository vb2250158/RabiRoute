<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">简体中文</a> | English
</div>
<!-- /docs-language-switch -->

# Rabi Agent

Rabi Agent is a headless LAN worker, not a full RabiRoute client. It opens an outbound connection to Rabi Manager, receives work, and delivers to the task selected at bootstrap through Codex Desktop IPC or the DSH local `session.prompt` API.

> Status: experimental. Setup, authorization and upload-to-group-file delivery passed local tests, a full build, and deployment health checks for `0.3.4-4b5d30118b40`. Upload integration used real HTTP and simulated NapCat; real two-computer group delivery remains unverified. This discovery-guidance and content-digest update audit requires separate verification of its final running version. Full Windows ZIP acceptance remains pending.

## First connection

1. In the controlling WebGUI, copy the setup prompt from **Remote Agent** and paste it into a private Codex/DSH task on the target computer. Requires Node.js 22.13+ and a running supported host.
2. The prompt uses a single-use ticket, valid for 30 minutes by default, to download the signed connector. `--bootstrap` exchanges it for an independent `nodeCredential`. The credential stays in current-user private configuration; Manager stores only the secret hash and grants. Login startup entries contain no credentials. The ticket is not a shared WebGUI Token and cannot be reused after a successful exchange.
3. Check your own `nodeId` and `connected` in `/api/lan-agent/self`. For message delivery, select the exact Agent under **RemoteAgent(<IP address>)** in the Route's message adapter and save. For APIs and skills, enable **Allow Manager API and skills** for that Agent in the controlling WebGUI.

The Manager-owned grant defaults to `false`. Changing the checkbox immediately sends a PUT, and access can be disabled while the node is offline without waiting for remote execution settings to save. This grant differs from the execution switch, task, workspace and model; online does not mean API access is granted.

See [Remote Agent setup and updates](../../docs/lan-rabi-agent-bootstrap_en.md) for installation, private directories, credential migration and recovery. Use the single generated prompt instead of maintaining another manual template:

```bash
node rabi-agent.mjs --bootstrap
```

Provide `RABI_MANAGER_URL`, `RABI_AGENT_BOOTSTRAP_TICKET`, `RABI_NODE_ID`, `RABI_AGENT_DEFAULT_CWD`, `RABI_AGENT_ALLOWED_CWDS` and `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` only to the installation child process. Codex uses `RABI_AGENT_TYPE=codex-desktop` and `RABI_AGENT_CODEX_THREAD_ID`; DSH uses `RABI_AGENT_TYPE=dsh`, `RABI_AGENT_DSH_URL` and `RABI_AGENT_DSH_SESSION_ID`. Never put credentials in command arguments, logs or repositories; tickets are for private setup only.

Updates compare the SHA-256 digest of the signed `manifestPayload` JSON, so changed content can update even with the same semver. Releases use immutable digest-named directories, rechecking identity and every file hash before reuse. Shared entrypoints stay unchanged until candidate READY; the connector then installs the pointer-based launcher/Hook shim and atomically switches `current-release`, retaining the old version on failure. Each shim call loads the helper from the current pointer, rather than the old shared helper copy. Older connectors compare only semver: for the first migration, copy the new setup prompt and run the new bootstrap, retaining the existing `nodeCredential`. Reload the DSH plugin or host if it cached an old helper; replacing disk files is not a hot-update guarantee.

## Use Manager from an existing task

On remote computers, prefer the installed connector's `--api` command supplied by the Hook. Local Host discovery applies only on the Manager computer; no Host on the remote computer does not mean Manager is offline. Discovery uses `/api/lan-agent/capabilities` and `/api/lan-agent/resources`. The catalog advertises only readable files and references, including the four public contracts and their English counterparts. Read returned IDs; arbitrary Markdown links do not grant resource access.

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

General syntax: `--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`. Select the exact Agent from private configuration. The CLI reads `nodeCredential` automatically and rejects old shared credentials. Read the current contract before mutations, supply JSON through standard input, and provide the required strong ETag and stable idempotency key. The CLI checks Manager `/meta` before and after calls. On timeout, 503, `uncertain` or a generation change after a write, read authoritative state before acting and never replay automatically. On 412, read again and reconfirm intent.

The current operation catalog contains controlled business entry points and aliases. It is not every Manager API or a guarantee of remote availability. Administrator settings, arbitrary `file` access and host control are denied; business permissions, Action Gate, source identity and existing loopback-only restrictions still apply. Resources are limited to public documents, skills and controlled text directly referenced within the same skill package, not an arbitrary filesystem. Fetch the latest skills and contracts published by Manager on demand. Do not copy plans, memories or message-processing state into a second business-state authority.

The controlling Manager enables access with a PUT body of `{ "enabled": true, "binding": { "provider": "<provider>", "sessionId": "<sessionId>", "managedSessionIds": [] } }`; `managedSessionIds` is optional. The grant explicitly freezes the binding displayed in the UI. Disabling requires only `{ "enabled": false }`. The PUT requires a stable `Idempotency-Key` and a strong `If-Match` obtained from GET instances. Grant receipts persist for 24 hours. The same key and body return the original receipt without rewriting the grant; a different body with that key returns 409. After a timeout, GET instances to inspect the current grant without automatically retrying. After receipt expiry, read again, reconfirm intent, and use a new key and ETag. Nodes cannot grant themselves access.

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

Large uploads use backpressured streaming and incremental SHA-256 with a 30-minute deadline. Manager Settings → Rabi identity accepts `agentUploads.maxFileMiB` (integer `1..2048`, default `2048`), stored in `data/Config.json` and effective after Manager restarts. The existing local-admin `PATCH /api/rabi/identity` also protects this setting; remote Agents cannot raise it. The client hard maximum is 2 GiB, and a lower server setting rejects larger files.

A 734 MiB (769654784-byte) file passed size/SHA-256 integration verification through the real client → loopback Manager → managed storage → simulated NapCat. Generation and reading used small chunks, with guards against Buffer allocations/concatenations above 8 MiB. Set `RABI_TEST_LARGE_UPLOAD=1` to run the opt-in case; routine runs skip it and temporary files are cleaned afterward. Actual QQ size/group-permission limits remain unverified. Existing legacy connectors need the new bootstrap described above, and hosts caching the old Hook must reload before retrying; changing the server quota does not upgrade remote code.

A `fileId` also requires `fileSha256=upload data.sha256` (64 lowercase hexadecimal characters), preventing UUID reuse after 24-hour expiry from replacing the content behind an old reference. The send callback checks the actual hash inside the lease and rejects a mismatch.

Files belong to `nodeId + agentId` and can be shared across that Agent's sessions, but still require a trusted, approved source. `fileId` is for NapCat group files only, mutually exclusive with `path`/`url`/`fileName`, and cannot send images, voice or another channel. The display name comes from upload metadata. `payload.text` is optional; `replyToMessageId` must be an empty string or a concrete source message ID. Manager's internal trusted resolver checks authorization, ownership, integrity and TTL per request, with an inflight lease protecting active files. It does not expand `allowedFileRoots`; the existing local path flow remains unchanged. `onlyPrimary` still checks the exact Route's remote binding and approved session.

Require both Manager and channel send receipts. If the group file uploaded but its caption failed, retain `status=sent` and send only the missing text, not the file again. NapCat on another machine still needs a shared directory making Manager's file path readable; this is not arbitrary cross-machine NapCat support. See the [Agent interface contract](../../docs/rabi-agent-interfaces_en.md#uploading-from-a-remote-agent-before-sending-a-group-file-experimental-contract) for headers, security and readback details. The formal-reply `none` restriction above remains unchanged.

## Older installations and runtime limits

- Old configurations without `nodeCredential` must enroll again with a fresh ticket; `lanLinkToken` cannot be migrated into a node credential. Preserve the instance, Agents, tasks and permitted workspaces. Reconnecting with an independent credential does not exchange another ticket.
- Before opening HTTP/WS listeners, the new source checks for old `lan-agent-tasks.json`. Without a completion marker, it rotates the WebGUI Token even if that registry is empty, writes the marker after success, and aborts startup on failure. Obtain new browser remote links locally when old links stop working. Confirm revocation or rotation for exposed keys outside this detection scope too; an unrotated shared key may still bypass node grants. A successful deployment and healthy Host do not establish older-node migration acceptance. Re-enrollment and invalidation of old keys still require per-node verification; do not describe all existing installations as already automatically secured.
- Bootstrap pins the release public-key SHA-256 fingerprint. Updates compare that fingerprint before checking the Ed25519 signature and each file's SHA-256 and size. On an update request the worker downloads, verifies and switches itself; if the replacement does not reconnect within 30 seconds, the old version remains active.
- Does not include Manager, Gateway, WebGUI, pairing codes, UDP discovery or device passwords. No fallback Runtime is started. An unavailable Codex owner or DSH binding fails without switching to the other host.
- Version 0.2.0 represents computers as instances and maps old single-task configuration to a stable `default` Agent. Each instance can contain multiple Agents. Execution configuration stays on that computer, with unified Manager administration. Install the fixed npm dependencies in the release directory; scans, task operations and Hook installation use the shared management module.
- A connected node, queued task or passing local fixture does not prove a completed reply. Cross-computer continuous delivery, login startup, disconnect/update recovery and advanced plan/memory workflows still require real-device acceptance.
