<!-- docs-language-switch -->
<div align="center">
English | <a href="./windows-launcher-and-packaging.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Windows Desktop Launch and Packaging

> Status: current guide. Checked against the launcher, Manager shutdown endpoint, Qt tray code, and packaging scripts.

This is the source of truth for Windows desktop startup and packaging. A complete desktop runtime is not a single executable. It is a coordinated set of artifacts:

```text
RabiRoute-Tray.exe          tray/task-panel entry and startup supervisor
dist/manager.js             Node Manager entry
dist/**/*.js                gateway, adapter, routing, and backend output
ribiwebgui/dist/            RibiWebGUI static build
data/                       writable private runtime configuration and logs
node.exe or system Node.js  Node runtime
node_modules/               runtime dependencies, or an equivalent bundle
```

`RabiRoute-Tray.exe` is the desktop entry inside that bundle. It does not contain the Manager, WebGUI, Node.js, dependencies, or runtime data by itself.

The portable Node Manager remains the product baseline. The Windows launcher detects an existing Manager, starts one only when required, writes logs outside bundled resources, opens RibiWebGUI, and optionally starts the PySide6/Qt plan-and-memory panel.

```text
Start-RabiRoute-Tray.bat or RabiRoute-Tray.exe
  -> verify/build dist/manager.js and ribiwebgui/dist
  -> node dist/manager.js
     -> static WebGUI and HTTP API
     -> managed gateway subprocesses
  -> Qt tray/task panel connects to http://127.0.0.1:8790
```

Choosing **Exit RabiRoute** asks the local Manager to shut down. The Manager stops managed gateways, closes its HTTP server, and exits before the tray process exits.

## Double-click startup

From the repository root:

```text
Start-RabiRoute-Tray.bat
```

The batch/PowerShell hybrid launcher:

- Uses the repository root as its working directory.
- Checks `http://127.0.0.1:8790/meta`.
- Reuses an existing RabiRoute Manager.
- Refuses to start a duplicate when port 8790 belongs to another process.
- Runs `npm.cmd run build` when the backend or WebGUI build is missing/stale, unless `-NoBuild` is passed.
- If the Manager already runs, repairs only the WebGUI with `npm.cmd run webgui:build` when needed.
- Starts `node dist\manager.js` in the background when no Manager is running.
- Opens RibiWebGUI unless `-NoOpen` is passed.
- Starts the Qt panel unless `-NoTray` is passed.
- Reuses an existing Qt panel instead of creating a duplicate.

Logs are written under:

```text
data/route/default-main/logs/
```

Typical files:

```text
launcher-YYYYMMDD-HHMMSS.log
manager-YYYYMMDD-HHMMSS.stdout.log
manager-YYYYMMDD-HHMMSS.stderr.log
tray-YYYYMMDD-HHMMSS.stdout.log
tray-YYYYMMDD-HHMMSS.stderr.log
```

Useful commands:

```powershell
.\Start-RabiRoute-Tray.bat
.\Start-RabiRoute-Tray.bat -NoOpen
.\Start-RabiRoute-Tray.bat -NoBuild
.\Start-RabiRoute-Tray.bat -NoTray
.\Start-RabiRoute-Tray.bat -ManagerUrl http://127.0.0.1:8790
```

The launcher does not start or stop QQ, NapCat, or unrelated processes. NapCat lifecycle remains an explicit action in RibiWebGUI.

## Manager shutdown endpoint

```http
POST http://127.0.0.1:8790/manager/shutdown
```

The endpoint is loopback-only because the Manager binds to `127.0.0.1`. It stops managed gateways, closes the server, and exits. `SIGINT` and `SIGTERM` use the same shutdown path.

The tray does not kill an arbitrary PID or become the Manager's permanent parent process. The portable Node core remains independently runnable.

## macOS and Linux baseline

```bash
npm install
npm run build
npm run start:manager
```

Then open:

```text
http://127.0.0.1:8790/
```

Manager APIs, gateways, WebGUI, storage layout, and shutdown semantics are cross-platform. Only `Start-RabiRoute-Tray.bat` is Windows-specific. A future macOS/Linux convenience launcher should follow the same contract: probe `/meta`, avoid duplicate Managers, pass `--manager-url` to the Qt panel, and use `POST /manager/shutdown` for exit.

## Qt plan and memory panel

The optional panel lives under `desktop/tray-task-window`. It is part of the Windows desktop experience but is not required for the portable Manager/WebGUI path.

Recommended local setup:

```powershell
py -m venv .venv-tray
.\.venv-tray\Scripts\python.exe -m pip install -r desktop\tray-task-window\requirements.txt
.\.venv-tray\Scripts\python.exe desktop\tray-task-window\main.py
```

Python discovery order:

1. `desktop\tray-task-window\.venv\Scripts\python.exe`
2. `.venv-tray\Scripts\python.exe`
3. `py.exe -3`
4. `python.exe`

If Python or PySide6 is unavailable, the tray process exits with a clear stderr message while the Manager and WebGUI remain usable. The panel uses a project-root single-instance lock and can fall back to a normal floating window when a system tray is unavailable.

## Building the Windows desktop bundle

```powershell
.\scripts\build-tray-exe.ps1
```

The wrapper runs `npm run build`, verifies the backend and WebGUI output, invokes PyInstaller with `RabiRoute-Tray.spec`, and copies `dist\RabiRoute-Tray.exe` to the repository root for local testing. The executable is ignored by Git.

Packaging boundaries:

- The executable bundles the PySide6 tray entry and Python tray code only.
- It does not bundle Node.js, `dist/manager.js`, `ribiwebgui/dist`, `node_modules`, or `data`.
- Frozen mode resolves the project root from `Path(sys.executable).parent`.
- It reuses a running Manager and may rebuild a stale WebGUI.
- If no Manager is running, it verifies/builds backend and frontend output before starting `node dist/manager.js`.

Before publishing a Windows package, verify that the backend and WebGUI are built, Node and dependencies are available, runtime data remains writable and external, and the binary has passed a separate privacy review for embedded build-machine paths. The desktop entry must never become the only supported startup path.

## Installer and GitHub Release assets

Build the complete Windows release locally with:

```powershell
.\scripts\build-windows-release.ps1
```

The command requires Node.js, Python 3.10+, PyInstaller, and Inno Setup 6. It copies only Git-tracked public runtime resources plus generated backend/WebGUI/tray outputs, embeds a pinned Windows x64 Node.js runtime, installs production-only npm dependencies, scans for private files and build-machine paths, smoke-tests the packaged Manager through `/meta`, and produces:

- `RabiRoute-<version>-windows-x64-setup.exe`
- `RabiRoute-<version>-windows-x64-portable.zip`
- `SHA256SUMS.txt`

The Inno Setup installer is per-user and defaults to `%LOCALAPPDATA%\Programs\RabiRoute`. Before replacing files, and again before uninstall removes program files, it asks the loopback Manager shutdown API to stop the current runtime gracefully. The payload contains no top-level `data/`; first launch initializes from sanitized `examples/data/`, while upgrades and uninstall do not proactively remove user routes, personas, or logs.

A `v*` tag triggers `.github/workflows/release-windows.yml`, which repeats tests, configuration validation, the clean Windows build, privacy checks, and the packaged Manager smoke test before uploading the three assets to GitHub Releases. Current binaries are unsigned, so release documentation must retain the SmartScreen unknown-publisher warning and checksum guidance. Code signing, stable/nightly channels, and in-app updates remain later decisions based on actual release cadence.
