# Remote Agent RabiRoute Bridge

This folder is the standalone remote Agent bridge for RabiRoute.

The remote machine does not need the full RabiRoute project. It only needs this folder, Node.js, and the target Agent runtime. The default bridge implementation uses Codex via `codex app-server`, but the center protocol is generic: the device registers with `agentType`.

## Run

```bash
cd remote-agent-rabiroute
npm install
RABIROUTE_MANAGER_WS="ws://<rabi-host>:8790/api/remote-agent/connect" \
REMOTE_AGENT_TOKEN="<same token as REMOTE_AGENT_TOKEN on the RabiRoute manager>" \
REMOTE_AGENT_DEVICE_ID="builder-device" \
REMOTE_AGENT_DEVICE_NAME="Builder Device" \
REMOTE_AGENT_TYPE="codex" \
REMOTE_AGENT_DEFAULT_CWD="/path/to/project" \
REMOTE_AGENT_DEFAULT_THREAD="远端构建小助手" \
npm start
```

`RABIROUTE_MANAGER_WS` is optional when LAN discovery is available. The bridge now keeps scanning in the background and reconnects automatically, so it can be started before the RabiRoute manager is up. When a manager is selected by env, discovery, or the local bridge UI, the selection is saved to:

```text
~/.rabiroute/remote-agent-bridge.json
```

If the RabiRoute manager runs on another machine, set `GATEWAY_MANAGER_HOST=0.0.0.0` on the manager side. If the machine has multiple network adapters, also set `REMOTE_AGENT_PUBLIC_HOST` or `GATEWAY_MANAGER_PUBLIC_HOST` to the address remote devices should use, for example:

```bash
GATEWAY_MANAGER_HOST=0.0.0.0 \
REMOTE_AGENT_PUBLIC_HOST=192.168.0.57 \
npm run start:manager
```

You can also expose the manager through Tailscale / ZeroTier / a trusted HTTPS reverse proxy and set `RABIROUTE_MANAGER_WS` to that reachable WebSocket URL.

For non-local connections, set `REMOTE_AGENT_TOKEN` on the manager and use the same value on the bridge. The manager rejects non-local Remote Agent HTTP requests without this token, and task events must come from the device that owns the task.

Useful bridge options:

```bash
REMOTE_AGENT_AUTO_DISCOVER=1          # default; set 0 to disable LAN discovery
REMOTE_AGENT_DISCOVERY_INTERVAL_MS=10000
REMOTE_AGENT_CONFIG_PATH="$HOME/.rabiroute/remote-agent-bridge.json"
```

## Local Callback

The bridge starts a local callback server:

```text
POST http://127.0.0.1:8797/v1/remote-agent/task-events
```

Remote Codex receives this URL in its prompt. When it finishes a task, it should POST:

```json
{
  "taskId": "task-id-from-prompt",
  "status": "completed",
  "summary": "Build completed.",
  "artifactPath": "/path/to/artifact",
  "logPath": "/path/to/log"
}
```

The bridge forwards the event to the RabiRoute manager, and the manager delivers the result back to the originating local persona thread.
