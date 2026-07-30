<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Remote Agent Bridge

This is RabiRoute's standalone unattended Remote Agent bridge. The remote machine does not need the full RabiRoute project. The Windows release package includes Node.js, the pinned `@openai/codex` runtime, and all production dependencies.

Its maturity remains `experimental`. Protocol, authentication, task serialization, timeout handling, file transfer, and packaging smoke tests are automated, but every real remote device still needs Codex login, project-permission, and two-way task acceptance before that device can be treated as ready.

## Ready-to-run Windows package

Download these assets from [GitHub Releases](https://github.com/vb2250158/RabiRoute/releases):

- `RabiRoute-Remote-Agent-<version>-windows-x64-setup.exe`: per-user installer with Start menu entries.
- `RabiRoute-Remote-Agent-<version>-windows-x64-portable.zip`: extract it, then double-click `RabiRoute-Remote-Agent.exe`.
- `SHA256SUMS.txt`: checksums for the release assets.

First launch:

1. Double-click `RabiRoute-Remote-Agent.exe`.
2. Enter the project directory where the remote Agent may work. It becomes the default and only writable root.
3. The launcher generates a high-entropy device password and checks the bundled Codex login. If needed, it starts the official login flow.
4. Keep the window open. On the control PC, open RabiGUI, enable the Remote Agent message endpoint, scan for the device, and enter the displayed password.

Private local configuration is stored at:

```text
%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json
```

That file is never part of the release payload. Installer upgrades preserve it, and the portable package does not write the password into its extracted directory.

Useful commands:

```powershell
RabiRoute-Remote-Agent.exe --configure
RabiRoute-Remote-Agent.exe --show-config
RabiRoute-Remote-Agent.exe --print-password
RabiRoute-Remote-Agent.exe --check
```

The binaries are currently unsigned, so Windows SmartScreen may report an unknown publisher. Verify the downloaded asset against `SHA256SUMS.txt` before running it.

## Ownership and observable contract

| Object | Owner | Lifecycle and source of truth | What RabiRoute may do | Forbidden substitute |
| --- | --- | --- | --- | --- |
| Remote host | Remote Windows user | User starts/stops the EXE; terminal shows status | Packaged launcher validates setup and login | Control PC replacing the remote Runtime |
| Runtime | Remote bridge's pinned Codex | Bridge starts its own stdio app-server on demand | Send an exact task and read its terminal state | Taking over the control PC Desktop |
| Transport | Bridge and Manager | Protocol-v3 password challenge over WebSocket | Discovery, authentication, tasks, and events | Falling back to another same-name device |
| Session | Remote Codex Runtime | `deviceId + canonical cwd + threadName` | Same-key serialization and idempotent return | Crossing devices or workspaces |
| Tools/approval | Remote Codex Runtime | `workspaceWrite`, approvals fail closed | Use only capabilities registered by that Runtime | Expanding permission through a prompt |

The only real-message path is:

```text
RabiRoute event -> Remote Agent Manager -> authenticated WebSocket
  -> exact remote device bridge -> pinned Codex app-server
  -> canonical project/session -> terminal event -> originating local persona
```

This is an unattended remote Runtime, not the local Codex/ChatGPT Desktop adapter. It does not share a fixed port, modify Desktop environment variables, or act as a fallback when Desktop is absent.

## Secure defaults

- There is no public default password. The Windows launcher generates and persists a dedicated device password during initial setup. A source launch without an explicit password generates a process-local temporary password.
- Protocol v3 uses a role-separated mutual HMAC-SHA256 challenge. The password is not sent over the WebSocket.
- HMAC authenticates but does not encrypt `ws://` traffic. Use a trusted LAN/VPN, or terminate `wss://` at a trusted reverse proxy on untrusted networks.
- Only the default project and explicit `REMOTE_AGENT_ALLOWED_CWDS` roots are writable. Every task re-resolves real paths so a junction or symlink cannot escape.
- Codex uses `workspaceWrite`; full-disk execution is unavailable.
- Network access is off by default and requires explicit `REMOTE_AGENT_ALLOW_NETWORK=1`.
- The bridge device password and private launcher-config path are removed from the child environment before Codex app-server starts.
- Limits default to 10 MiB per file and 25 MiB per task.

## Ports and discovery

- The control service starts at TCP `8797`.
- LAN discovery starts at UDP `8798`.
- Occupied ports cause bounded automatic incrementing. RabiGUI uses the actual control URL advertised by discovery.
- If the entire discovery range is occupied, the control service still starts and prints an actionable warning.

Advanced environment overrides:

```powershell
$env:REMOTE_AGENT_PASSWORD="replace-with-a-long-random-secret"
$env:REMOTE_AGENT_DEVICE_NAME="Builder Device"
$env:REMOTE_AGENT_DEFAULT_CWD="C:\path\to\project"
$env:REMOTE_AGENT_DEFAULT_THREAD="Remote Agent"
$env:REMOTE_AGENT_CONTROL_PORT="8797"
$env:REMOTE_AGENT_DISCOVERY_PORT_START="8798"
$env:REMOTE_AGENT_DISCOVERY_PORT_END="8818"
$env:REMOTE_AGENT_PUBLIC_HOST="192.168.0.57"
$env:REMOTE_AGENT_PUBLIC_CONTROL_URL="wss://agent.example.com/api/remote-agent/control"
$env:REMOTE_AGENT_ALLOWED_CWDS='["C:\\path\\to\\project"]'
$env:REMOTE_AGENT_ALLOW_NETWORK="0"
$env:REMOTE_AGENT_RESUMED_TURN_WAIT_MS="30000"
$env:REMOTE_AGENT_TASK_TIMEOUT_MS="1800000"
```

`REMOTE_AGENT_PUBLIC_CONTROL_URL` must be an absolute `ws://` or `wss://` URL whose path is exactly `/api/remote-agent/control`. Credentials, query strings, and fragments are rejected.

## Tasks and files

Tasks with the same canonical `threadName + cwd` are serialized. A resumed `inProgress` turn gets a bounded wait; if it remains busy, the bridge creates a fresh remote thread instead of starting or steering concurrently. Timeout, interruption, terminal errors, and app-server exit explicitly fail the task and release its queue.

The Manager may attach `filePaths`, `files`, or `attachments` to `POST /api/remote-agent/tasks`. The bridge writes accepted input files under:

```text
<temp>\rabiroute-remote-agent-files\<deviceId>\inbox\<taskId>\
```

The bridge's optional callback is loopback-only:

```text
POST http://127.0.0.1:<actual-control-port>/v1/remote-agent/task-events
```

Returned `artifactPath`, `logPath`, and `files[].path` values must remain inside the task's canonical cwd. The Manager stores accepted files before returning the result to the originating local persona. A remote Agent never replies directly to QQ or another external system.

## Source launch and release build

The source path remains supported:

```powershell
cd plugin-adapters\remote-agent-rabiroute
npm ci
npm start
```

Build the installer, portable ZIP, and checksum manifest with:

```powershell
.\scripts\build-remote-agent-windows-release.ps1
```

The build requires Windows x64, Node.js, the stable Rust MSVC toolchain, and Inno Setup 6. A `remote-agent-v*` tag makes GitHub Actions repeat the tests, clean build, packaging smoke test, and GitHub Release publication on a clean Windows runner.
