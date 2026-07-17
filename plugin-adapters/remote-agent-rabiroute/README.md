<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Remote Agent RabiRoute Bridge

This folder is the standalone unattended Remote Agent bridge for RabiRoute.

The remote machine does not need the full RabiRoute project. It only needs this folder and Node.js. This bridge pins its own `@openai/codex` runtime and uses `codex app-server` over stdio JSONL.

This runtime is owned only by the unattended bridge on that remote device. It does not share a fixed port with, reconfigure, or act as a fallback for Codex/ChatGPT Desktop on the RabiRoute control machine.

## Run

```bash
cd remote-agent-rabiroute
npm install
npm start
```

Then open RabiGUI on the control machine, enable the Remote Agent message adapter, scan the LAN, select the device, and enter the password.

If `REMOTE_AGENT_PASSWORD` is absent, each process start generates a new high-entropy temporary password and prints it only in the remote machine's terminal. There is no public default password.

For a persistent deployment, configure a password of at least 16 UTF-8 bytes:

```bash
REMOTE_AGENT_PASSWORD="replace-with-a-long-random-secret" npm start
```

The control service still listens on the LAN by default, so treat this password as a device credential. Do not reuse an account password. Protocol v3 uses a per-connection, mutually verified HMAC-SHA256 challenge: the manager proves it knows the password, then the bridge returns a role-separated server proof. The password itself is not sent over the WebSocket, and both peers reject missing or non-v3 protocol fields. HMAC authenticates the peers but does not encrypt plain `ws://` traffic; use a trusted LAN/VPN or the `wss://` option below across untrusted networks.

## Ports

The bridge is zero-config for normal use.

- Control service starts from port `8797`.
- LAN discovery starts from UDP port `8798`.
- If a port is occupied, the bridge automatically tries the next available port.
- RabiGUI scans the discovery range and uses the real advertised control port, so users do not need to type a port.
- If the whole discovery range is occupied, the bridge still starts the control service and prints a clear warning. Free the occupied UDP ports, then scan again from RabiGUI.

Useful advanced overrides:

```bash
REMOTE_AGENT_PASSWORD="replace-with-a-long-random-secret"
REMOTE_AGENT_DEVICE_NAME="Builder Device"
REMOTE_AGENT_DEFAULT_CWD="/path/to/project"
REMOTE_AGENT_DEFAULT_THREAD="Remote Agent"
REMOTE_AGENT_CONTROL_PORT=8797
REMOTE_AGENT_DISCOVERY_PORT_START=8798
REMOTE_AGENT_DISCOVERY_PORT_END=8818
REMOTE_AGENT_PUBLIC_HOST=192.168.0.57
REMOTE_AGENT_PUBLIC_CONTROL_URL="wss://agent.example.com/api/remote-agent/control"
REMOTE_AGENT_ALLOWED_CWDS='["/path/to/project","/path/to/another-project"]'
REMOTE_AGENT_ALLOW_NETWORK=0
REMOTE_AGENT_RESUMED_TURN_WAIT_MS=30000
REMOTE_AGENT_TASK_TIMEOUT_MS=1800000
```

`REMOTE_AGENT_PUBLIC_CONTROL_URL` is optional and is intended for a TLS terminator or trusted reverse proxy that forwards to the local control service. It must be an absolute `ws://` or `wss://` URL whose path is exactly `/api/remote-agent/control`; credentials, query strings, and fragments are rejected. When set, LAN discovery advertises this URL unchanged. Without it, discovery advertises the bridge's observed LAN endpoint.

Only `REMOTE_AGENT_DEFAULT_CWD` and descendants are writable by default. Add other roots explicitly through `REMOTE_AGENT_ALLOWED_CWDS`. At startup, every root is required to exist and be a directory. Before each task, the bridge resolves the real filesystem path and checks it against those canonical roots, so a junction or symlink below an allowed directory cannot escape the boundary. Codex uses `workspaceWrite`; full-disk execution is not available.

Network access is off unless `REMOTE_AGENT_ALLOW_NETWORK=1` is explicitly set. Final task completion and failure are derived directly from Codex app-server turn events, and the bridge extracts the final `agentMessage` text from `turn/completed` as the returned summary and `data.replyText` (bounded to 12,000 characters). Normal task results therefore do not need callback network access. Enable network only when the Agent must POST richer progress or artifact paths to the optional local callback and the deployment accepts that broader capability.

Tasks targeting the same canonical `threadName + cwd` are serialized until the prior task reaches a terminal state. After a restart, if `thread/resume` reports an existing `inProgress` turn, the bridge waits up to `REMOTE_AGENT_RESUMED_TURN_WAIT_MS`; if it is still busy, the bridge starts a fresh thread instead of steering or starting a competing turn. Every delivered task has a finite `REMOTE_AGENT_TASK_TIMEOUT_MS`; timeout, interruption, terminal error, and app-server exit all fail the task and release its queue safely.

## Local Callback

The bridge exposes a local-only callback endpoint on its actual control port:

```text
POST http://127.0.0.1:<actual-control-port>/v1/remote-agent/task-events
```

Remote Codex receives this URL in its prompt as an optional channel for richer progress, summaries, and returned files. The bridge already reports terminal completion, interruption, failure, and app-server exit without this callback. When network access is enabled and extra callback data is useful, Codex may POST:

```json
{
  "taskId": "task-id-from-prompt",
  "status": "completed",
  "summary": "Build completed.",
  "artifactPath": "/path/to/artifact",
  "logPath": "/path/to/log",
  "files": [
    { "path": "/path/to/extra-result.zip" }
  ]
}
```

The bridge reads `artifactPath`, `logPath`, and any `files[].path` from the remote machine only after resolving the real file path and confirming it remains inside that task's canonical cwd. A symlink or junction cannot be used to return arbitrary files outside the task workspace. Inline `contentBase64` remains subject to the same size limits. The manager stores accepted returned files under `data/remote-agent-files/<taskId>/` before delivering the result back to the originating local persona thread.

Terminal events are idempotent. If a callback completes or fails a task before the app-server terminal notification arrives, the later notification is ignored; if app-server closes the task first, a late callback receives `duplicate: true` and is not delivered twice.

## File Transfer

Tasks may include files from the Rabi manager side. The manager accepts `filePaths`, `files`, or `attachments` in `POST /api/remote-agent/tasks`, reads local file content, and sends it with the task.

The bridge writes incoming task files to:

```text
<tmp>/rabiroute-remote-agent-files/<deviceId>/inbox/<taskId>/
```

Override the directory with:

```bash
REMOTE_AGENT_FILE_DIR="/path/to/remote-agent-files" npm start
```

File transfer defaults to 10 MiB per file and 25 MiB per task. Override the limits explicitly when needed:

```bash
REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES=10485760
REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES=26214400
```
