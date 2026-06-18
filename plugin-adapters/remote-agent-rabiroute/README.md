# Remote Agent RabiRoute Bridge

This folder is the standalone unattended Remote Agent bridge for RabiRoute.

The remote machine does not need the full RabiRoute project. It only needs this folder, Node.js, and the target Agent runtime. The default implementation uses Codex via `codex app-server`.

## Run

```bash
cd remote-agent-rabiroute
npm install
npm start
```

Then open RabiGUI on the control machine, enable the Remote Agent message adapter, scan the LAN, select the device, and enter the password.

Default password:

```text
123456
```

The password can be changed with:

```bash
REMOTE_AGENT_PASSWORD="your-password" npm start
```

## Ports

The bridge is zero-config for normal use.

- Control service starts from port `8797`.
- LAN discovery starts from UDP port `8798`.
- If a port is occupied, the bridge automatically tries the next available port.
- RabiGUI scans the discovery range and uses the real advertised control port, so users do not need to type a port.
- If the whole discovery range is occupied, the bridge still starts the control service and prints a clear warning. Free the occupied UDP ports, then scan again from RabiGUI.

Useful advanced overrides:

```bash
REMOTE_AGENT_PASSWORD="your-password"
REMOTE_AGENT_DEVICE_NAME="Builder Device"
REMOTE_AGENT_DEFAULT_CWD="/path/to/project"
REMOTE_AGENT_DEFAULT_THREAD="Remote Agent"
REMOTE_AGENT_CONTROL_PORT=8797
REMOTE_AGENT_DISCOVERY_PORT_START=8798
REMOTE_AGENT_DISCOVERY_PORT_END=8818
REMOTE_AGENT_PUBLIC_HOST=192.168.0.57
```

## Local Callback

The bridge exposes a local-only callback endpoint on its actual control port:

```text
POST http://127.0.0.1:<actual-control-port>/v1/remote-agent/task-events
```

Remote Codex receives this URL in its prompt. When it finishes a task, it should POST:

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

The bridge reads `artifactPath`, `logPath`, and any `files[].path` from the remote machine, sends their content over the authenticated Rabi control connection, and the manager stores returned files under `data/remote-agent-files/<taskId>/` before delivering the result back to the originating local persona thread.

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

File transfer is unlimited by default. To add optional protection for a deployment, set byte limits explicitly:

```bash
REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES=10485760
REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES=26214400
```
