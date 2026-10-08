<!-- docs-language-switch -->
<div align="center">
English | <a href="./getting-started.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Getting Started

> Status: current guide. Checked against the current Manager, RibiWebGUI, Codex Desktop owner, and NapCat setup flow. See [Current Capabilities](current-capabilities_en.md) before enabling experimental integrations.

## Requirements

- Node.js 20 or newer.
- A NapCat/OneBot environment for QQ. You can skip QQ if you only want to inspect RibiWebGUI or test heartbeat/manual events.
- Optional but recommended: Codex, the verified handler integration.

## Install and start

The Windows installer launches RabiRoute Host from the Start menu. Host creates same-generation Manager and tray children and passes the operating-system-assigned Manager URL to the tray; open RibiWebGUI from the tray. Repeated launch activates the existing Host.

For a full Windows source build, double-click `Start-RabiRoute-FromSource.bat` in the repository root. Requires an existing Windows RabiRoute installation, Node.js/npm, and the .NET 9 SDK. It builds Manager, WebGUI, plugins, Host, and the tray, then activates the source build through Host while retaining installed settings and data. The first build downloads Python/Qt dependencies. Closing the command window does not stop Host; quit from the tray. Failure logs are in `logs/source-start/`. If the dependency lock differs from the installed package, update the full installation first.

### Linux Host

Linux requires Node.js 20+, npm, and util-linux `flock`. To start the existing WebGUI:

1. Enter the checkout and run the initial build/start script:

   ```bash
   cd /path/to/RabiRoute
   bash Start-RabiRoute-FromSource.sh
   ```

2. After `npm ci` and the full build, Host runs in the background. Query status and open the returned `managerBaseUrl`:

   ```bash
   npm run status:linux -- --json
   node scripts/linux-host.mjs --command open
   ```

3. To inspect pages without automatic integrations, quit any existing Host, then run `npm run start:linux -- --foreground --read-only`. Normal writable startup creates local device identity; read-only mode does not create a persistent tunnel key but still writes runtime logs and leases.
4. For an existing build, use `npm run start:linux`; request shutdown with `npm run stop:linux`. Logs are at `<stateRoot>/logs/linux-host/host.log`; the repository is the default state root. An alternate state root must be an absolute path.

This Linux path does not include Windows/Qt tray features, screenshots, or global hotkeys, and installs no service. Configure RabiLink through its existing page with a manually supplied verified Relay URL and reusable application token. Saving persists the connection; authenticated devices in the same application can use all services actually provided by this computer. See [Linux Host](linux-host_en.md) for full commands, security, and process-cleanup boundaries. Real Relay, two-device, and endurance acceptance remains pending.

### Backend-only development

The following entry points are for Windows/macOS backend-only development without the tray. Use Host above for everyday Linux operation.

Windows PowerShell:

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

macOS:

```bash
cd /path/to/RabiRoute
npm install
npm run build
npm run start:manager
```

Manager prints its actual address to stdout, for example:

```text
RabiRoute manager listening at <managerBaseUrl>
```

Use that run's `<managerBaseUrl>` instead of preserving one port as a permanent default. Other integrations retain their own configured endpoints:

- NapCat reverse WebSocket: `ws://127.0.0.1:8789`
- NapCat OneBot HTTP: `http://127.0.0.1:3000`

## First route

On a normal writable clean start, the Manager prefers copying the complete public `examples/data` package into `data/`. Only the `main` route is enabled by default; experimental examples remain disabled until credentials, ports, and workspaces are configured. If examples are unavailable, the Manager can still create a minimal QQ/NapCat-to-Codex setup.

In RibiWebGUI, check:

- **Message adapters**: NapCat/OneBot and heartbeat are the normal starting choices.
- **Handler**: choose Codex, a fixed thread name, and the project workspace.
- **Route**: verify WebSocket/HTTP ports, webhook settings, handler cwd, and role binding.
- **Role**: select or create a role such as the public `Rabi` example.
- **Persona automation**: use **When a message arrives / Scheduled tasks** to choose the trigger, then notify the Agent or run a persona script.

For manual `personaConfig.json` edits, see [Routing Configuration](routing-configuration_en.md).

To copy the examples manually:

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

For a QQ-free smoke test, enable Scheduled Tasks. Configured script actions run files in the owning persona's scripts directory.

## Codex setup

Codex is the verified handler path. Configure:

- `agentAdapters: ["codex"]`.
- `codexThreadId`: the opaque Desktop task ID saved by RibiWebGUI.
- `codexThreadName`: the visible task name, such as `QQ message listener`.
- `codexCwd`: the project directory in which Codex should work.

A valid saved Codex ID is the stable task identity, while the configured working directory controls the next turn. A different saved default cwd, Desktop rename, stale SQLite title, or completed goal does not create a duplicate. Typing a new name explicitly clears the old ID; only then may RabiRoute search by name and workspace or create an empty task.

Codex/ChatGPT Desktop must be running for real delivery. RabiRoute uses Desktop IPC and may deeplink an unloaded task before retrying. The project-pinned app-server is used only to create and name an empty task; it never executes a routed prompt.

## NapCat setup

In NapCat WebUI configure:

- WebSocket Client: `ws://127.0.0.1:8789`
- HTTP Server: host `127.0.0.1`, port `3000`

The WebSocket carries inbound QQ events. OneBot HTTP is used for replies and proactive sends. Restart or reload NapCat networking after changing its plugin/network settings when required.

For startup and quick-login behavior, see [Unattended NapCat](napcat-unattended_en.md). QQ credentials and verification never belong in a RabiRoute gateway definition.

## Chinese text on Windows

Avoid hand-building Chinese JSON with PowerShell `Invoke-WebRequest`; request encoding can be inconsistent. Use the project script:

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "Unicode test\nSecond line"
```

Validate route/role JSON with:

```powershell
npm run check:config
```

Use real line breaks in WebUI text areas. Let JSON serialization escape them once when saving.

## Verify the path

1. Start Windows Host or Linux Host and obtain the current `managerBaseUrl` from Host. For backend-only development, record the current Manager startup output.
2. Open RibiWebGUI from the tray or `<managerBaseUrl>` and confirm the route is running.
3. Confirm NapCat is connected to port 8789.
4. Mention the bot in a QQ group, send a private message, or run a heartbeat/manual trigger.
5. Inspect `data/route/<configName>/` for message and `agent-packets.jsonl` records.
6. For Codex, confirm the configured thread receives the packet.

## Development commands and entry points

```powershell
npm run build
npm run start:manager
npm run manager
```

- `src/manager.ts`: configuration, route-process lifecycle, and RibiWebGUI API.
- `src/index.ts`: one gateway subprocess.
- `src/adapters/`: message protocol adapters.
- `src/forwarding.ts`: rule evaluation, packet construction, and handler delivery.
- `src/history.ts`: JSONL records.
