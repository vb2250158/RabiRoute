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
scripts/watch-rabiroute-desktop-lifecycle.ps1  Manager/tray process-pair supervisor
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
  -> data/runtime/desktop-lifecycle-intent.json = running
  -> watch-rabiroute-desktop-lifecycle.ps1
     -> repairs the Manager + tray pair through the same launcher
```

Choosing **Exit RabiRoute** first makes Manager atomically persist `desiredState=stopped`, then stops managed gateways, closes HTTP, and exits before the tray exits. The supervisor observes `stopped` and terminates without resurrecting an intentional exit. An ordinary Manager reload does not change that intent.

## Double-click startup

From the repository root:

```text
Start-RabiRoute-Tray.bat
```

The batch/PowerShell hybrid launcher:

- Uses the repository root as its working directory.
- Checks `http://127.0.0.1:8790/meta` repeatedly and reuses only a stably healthy Manager.
- If a healthy Manager predates the current `dist/manager.js`, performs a controlled shutdown and loads the current build.
- If an unresponsive process owns port 8790, takes over only when its command line precisely identifies this project's absolute `dist/manager.js` or the relative `dist/manager.js` form used by packaged and older launchers: graceful `/manager/shutdown` first, then the verified process tree only if shutdown times out. The Node-process, port-owner, and Manager-health gates must still hold together.
- If port 8790 belongs to another or unverifiable process, leaves it untouched and refuses to start a duplicate Manager.
- Before loading the control plane, Manager also acquires `data/.runtime/manager-instance.lock`. Concurrent starts of the same workspace through a mapped drive, UNC path, the launcher, or direct `node dist/manager.js` are rejected with exit code `17`; a stale lock is reclaimed only after its recorded PID no longer exists.
- Runs `npm.cmd run build` when the backend or WebGUI build is missing/stale, unless `-NoBuild` is passed.
- If the Manager already runs, repairs only the WebGUI with `npm.cmd run webgui:build` when needed.
- Starts `node dist\manager.js` in the background when no Manager is running.
- Opens RibiWebGUI unless `-NoOpen` is passed.
- Starts the Qt panel unless `-NoTray` is passed.
- Reuses an existing Qt panel instead of creating a duplicate.
- Persists a `running` desktop intent and starts one lightweight supervisor per workspace. It checks only Manager `/meta` and this project's tray process every five seconds, requires two consecutive misses, and then reuses the launcher's PID, port-ownership, and single-instance gates to restore the pair. It does not scan or repair QQ, NapCat, Routes, or adapters.
- Keeps the tray alive and visibly offline during a transient Manager outage. A genuinely missing Manager or tray is repaired by the supervisor instead of one process silently outliving the other.

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
desktop-lifecycle-supervisor.log
desktop-lifecycle-supervisor.jsonl
```

Useful commands:

```powershell
.\Start-RabiRoute-Tray.bat
.\Start-RabiRoute-Tray.bat -NoOpen
.\Start-RabiRoute-Tray.bat -NoBuild
.\Start-RabiRoute-Tray.bat -NoTray
.\Start-RabiRoute-Tray.bat -ManagerUrl http://127.0.0.1:8790
```

The launcher does not start or stop QQ, NapCat, or unrelated processes. An unknown port owner remains untouched. Only a precisely verified stale Manager from the same project may be shut down; forced process-tree termination is a bounded fallback after graceful shutdown times out. NapCat lifecycle remains an explicit action in RibiWebGUI.

## Manager shutdown endpoint

```http
POST http://127.0.0.1:8790/manager/shutdown
```

The endpoint is loopback-only. A tray request includes `{ "desktopExit": true }`; Manager persists `stopped` before acknowledging it, and a persistence failure leaves both the Manager and tray running. Installer, upgrade, and controlled-reload calls use an empty body, shutting down only Manager without changing the desktop intent. Both eventually use the same shutdown path as `SIGINT` and `SIGTERM`.

Full desktop startup records its intent through another loopback-only endpoint:

```http
POST http://127.0.0.1:8790/manager/desktop-lifecycle/start
```

The private `data/runtime/desktop-lifecycle-intent.json` file is the single runtime source of truth and is never committed. Missing, malformed, or non-`running` state makes the supervisor fail closed.

The tray does not kill an arbitrary PID or become the Manager's permanent parent. A separate Windows supervisor owns only process pairing; the portable Node core remains independently runnable.

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

The optional panel lives under `desktop/tray-task-window`. It is part of the Windows desktop experience but is not required for the portable Manager/WebGUI path. It is a frontend of the same Manager backend as RibiWebGUI: `DesktopRefreshService` calls Manager APIs asynchronously and the packaged tray does not load local plan/memory repositories.

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
- Once Manager is healthy, it records a `packaged-tray` running intent and starts the same lifecycle supervisor. Package recovery relaunches the packaged executable and does not depend on system Python.

Before publishing a Windows package, verify that the backend and WebGUI are built, Node and dependencies are available, runtime data remains writable and external, and the binary has passed a separate privacy review for embedded build-machine paths. The desktop entry must never become the only supported startup path.

## Installer and GitHub Release assets

Build the complete Windows release locally with:

```powershell
.\scripts\build-windows-release.ps1
```

The command requires Node.js, Python 3.10+, PyInstaller, and Inno Setup 6. It builds both the tray executable and `plugin-adapters/rabi-speech/runtime/RabiSpeech.exe` with RabiSpeech product, icon, and version resources, then includes that generated host in the payload. Windows 11 Volume Mixer uses the real process image for application identity, so changing only the Core Audio session label would still show `Python`. The script copies only Git-tracked public runtime resources plus generated backend/WebGUI/tray/speech-host outputs, embeds a pinned Windows x64 Node.js runtime, installs production-only npm dependencies, scans for private files and build-machine paths, smoke-tests the packaged Manager through `/meta`, and produces:

- `RabiRoute-<version>-windows-x64-setup.exe`
- `RabiRoute-<version>-windows-x64-portable.zip`
- `SHA256SUMS.txt`

The Inno Setup installer is per-user and defaults to `%LOCALAPPDATA%\Programs\RabiRoute`. Before replacing files, and again before uninstall removes program files, it asks the loopback Manager shutdown API to stop the current runtime gracefully. The payload contains no top-level `data/`; first launch initializes from sanitized `examples/data/`, while upgrades and uninstall do not proactively remove user routes, personas, or logs.

A `v*` tag triggers `.github/workflows/release-windows.yml`, which repeats tests, configuration validation, the clean Windows build, privacy checks, and the packaged Manager smoke test before uploading the three assets to GitHub Releases. Current binaries are unsigned, so release documentation must retain the SmartScreen unknown-publisher warning and checksum guidance. Code signing, stable/nightly channels, and in-app updates remain later decisions based on actual release cadence.
