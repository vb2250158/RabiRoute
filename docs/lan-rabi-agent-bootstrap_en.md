<!-- docs-language-switch -->
<div align="center">
<a href="./lan-rabi-agent-bootstrap.md">简体中文</a> | English
</div>
<!-- /docs-language-switch -->

# LAN Rabi Agent bootstrap and updates

> Status: **Experimental integration**. Manager APIs, Rabi Web, signed releases, node connections, and update requests are implemented. The current worker only delivers to a configured Codex Desktop task owner and has not passed a real multi-computer acceptance run.
>
> Audience: maintainers, LAN operators, and the existing Agent that bootstraps Rabi Agent.

## What this provides

RabiRoute remains on the Manager computer. Other computers do not install full RabiRoute or run a Gateway, and they do not use a pairing code or device password. An execution computer keeps only headless Rabi Agent. It opens an outbound connection to Manager, receives work, delivers it to an already-open Codex Desktop task on that computer, and returns acceptance, completion, or failure state.

The Rabi Web **LAN Agents** page shows nodes, recent tasks, and the published version. It can request an update for an online node. Manager never overwrites remote files: the node downloads, verifies, and switches itself. If the replacement does not reconnect within 30 seconds, the old version remains active.

## Implemented scope

| Item | Current behavior |
| --- | --- |
| Authentication | Reuses `webguiLan.accessToken`. Node listing, task assignment, and update requests require the explicit Token even from loopback; no pairing code, UDP discovery, device password, or second Token is added. |
| Release publishing | `GET /api/lan-agent/releases/manifest` returns an Ed25519-signed Node release manifest with a SHA-256 for every file. |
| Downloads | Agent uses `Authorization: Bearer <LAN connection Token>` for manifests and files. |
| Persistent connection | Agent connects to `/api/lan-agent/connect`, sends `authenticate`, waits for `authenticated`, then sends `hello`. Browser WebSocket clients cannot reliably supply an Authorization Header, so connection authentication is the first message; HTTP download still uses the Bearer Header. |
| Nodes and tasks | Manager persists the latest 500 node states and tasks. Reconnects do not execute the same `taskId` twice. |
| Local handler | Only `codex-desktop`. Work is delivered through Codex Desktop IPC to the configured task owner. If Desktop or the owner is unavailable, the task fails closed; Rabi Agent never starts `codex app-server` or another fallback runtime. |
| Restart | `--bootstrap` creates a current-user startup entry. It contains no Token and restores the headless worker after login. |

Rabi Agent requires Node.js 22 or newer. It does not request administrator rights or write system-wide environment variables.

## Rabi Web operation

1. Enable LAN Web access in Manager and generate the LAN connection Token.
2. Open Rabi Web from the full access URL that contains that Token.
3. Open **LAN Agents** and copy the displayed release public-key SHA-256. A connected node reports its version, platform, Codex Desktop capability, and last-seen time.
4. Supply that fingerprint to the new computer as `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` during first bootstrap.
5. Select **Update to current version** on an online node. The node receives `updateAvailable`, downloads and verifies the release, and reports `requested`, `updated`, or `failed`.

An offline node cannot be updated until it reconnects.

## First connection

The new computer needs Node.js 22+, Codex/ChatGPT Desktop, and an already-open target task owner. Its existing Agent follows the prompt below to download, verify, install, and launch Rabi Agent. The person using the computer does not manually install RabiRoute or enter a pairing code.

The current-user data directory is:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\RabiAgent\` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

The private configuration contains the Manager URL, LAN connection Token, stable `nodeId`, release public-key SHA-256 fingerprint, allowed workspaces, and Codex Desktop task ID. Do not place the Token in a repository, logs, command history, task body, or screenshots.

## Bootstrap prompt

Replace the placeholders and send this prompt privately to the existing Agent on the new computer.

```text
Connect this computer to the LAN Rabi Manager by installing and starting the current headless Rabi Agent. Do not install full RabiRoute, do not use a pairing code, and do not start a fallback Codex runtime.

Rabi Manager URL: <RABI_MANAGER_URL>
LAN connection Token: <RABI_LAN_LINK_TOKEN>
Stable node ID: <RABI_NODE_ID>
Allowed workspace: <RABI_AGENT_DEFAULT_CWD>
Existing Codex Desktop task owner ID: <RABI_AGENT_CODEX_THREAD_ID>
Release public key SHA-256: <RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256>

1. Require Node.js 22 or newer and an already-open Codex/ChatGPT Desktop task owner with the ID above. Stop with the failed prerequisite if either is unavailable.
2. Request GET <RABI_MANAGER_URL>/api/lan-agent/releases/manifest with Authorization: Bearer <RABI_LAN_LINK_TOKEN>.
3. Derive SHA-256 from the manifest Ed25519 public key in canonical SPKI DER form and require it to equal <RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256> and manifest.publicKeySha256. Then verify the signature over exactly { version, platform, minNodeVersion, files }; verify every downloaded file's SHA-256 and byte size. Reject paths containing ., .., empty segments, or absolute paths.
4. Download every file in the manifest into the current user's RabiAgent releases/<version> directory. Do not put the Token in the package, logs, repository, screenshots, command history, or task text.
5. Set only this process environment for bootstrap: RABI_MANAGER_URL, RABI_LAN_LINK_TOKEN, RABI_NODE_ID, RABI_AGENT_DEFAULT_CWD, RABI_AGENT_ALLOWED_CWDS, RABI_AGENT_CODEX_THREAD_ID, and RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256.
6. From the verified release directory, run: node rabi-agent.mjs --bootstrap. This writes current-user-only configuration, registers the current-user startup entry, and starts the Rabi Agent.
7. Wait for Manager to return connected. Report only: Rabi Agent connected: <RABI_NODE_ID>, version: <version>.
8. On failure, report only the failed step and error. Do not retry indefinitely, skip verification, create another token, use UDP discovery, use a device password, or launch codex app-server.
```

The signing key lives in Manager private runtime data. Replacing or losing it changes the fingerprint, and existing nodes reject subsequent updates. A rotation must redistribute the new fingerprint through a trusted channel and update `releasePublicKeySha256` in each node private configuration. Explicit key provisioning, permission verification, and a controlled rotation procedure remain required before real two-host acceptance.

## Protocol

```text
GET  /api/lan-agent/releases/manifest
GET  /api/lan-agent/releases/<version>/node/<assetPath>
GET  /api/lan-agent/nodes
POST /api/lan-agent/nodes/<nodeId>/update
POST /api/lan-agent/nodes/<nodeId>/tasks
WS   /api/lan-agent/connect
```

```text
authenticate -> authenticated -> hello -> connected -> heartbeat
assignTask  -> ackTask -> progress -> taskResult
updateAvailable -> updateResult
```

Every task has `taskId` and `idempotencyKey`. Manager deduplicates per node. Rabi Agent accepts only `codex-desktop` and verifies that the requested workspace is inside the allowed workspace list declared during bootstrap. After Codex Desktop accepts a task, Rabi Agent waits for the Desktop task-state broadcast; a completion result means the owner completed, while the actual response remains in that Desktop task.

## Remaining acceptance

- First bootstrap, Token revocation, network loss, and login restore on two real computers.
- Correlation between Codex Desktop task-state broadcasts and the actual response.
- Startup entry behavior on Windows, macOS, and Linux.
- Remote Agent v3 remains a separate experimental path and is not removed before migration and acceptance.
