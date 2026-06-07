# Windows double-click launcher and packaging

RabiRoute still starts from the portable Node manager. The Windows launcher is a desktop convenience entry: it detects an existing manager, starts one only when needed, writes logs under the route data directory, opens RibiWebGUI, and starts the PySide6/Qt task panel when Python/PySide6 are available.

The Windows launcher is the supervisor for the "1+1" desktop experience:

```text
Start-RabiRoute-Tray.bat
  -> embedded PowerShell launcher
     -> node dist/manager.js
        -> managed gateway child processes
     -> desktop/tray-task-window/main.py --owns-manager
```

When the launcher starts the manager itself, the tray receives `--owns-manager`. In that mode, right-clicking the tray and choosing `Exit RabiRoute` calls the local manager shutdown API, then exits the tray. The manager stops its gateway child processes and closes its HTTP server.

If the launcher finds an already-running manager, it still starts the tray, but without `--owns-manager`. In that mode, `Exit tray` closes only the tray so it does not accidentally stop a manager started by `npm run start:manager`, another terminal, or another tool.

## Double-click startup

From the project root, double-click:

```text
Start-RabiRoute-Tray.bat
```

`Start-RabiRoute-Tray.bat` is a polyglot batch/PowerShell launcher. The old split launcher files were removed so there is only one Windows source entry to maintain.

Default behavior:

- Uses project root as the working directory.
- Checks `http://127.0.0.1:8790/meta`.
- If RabiRoute manager is already running, reuses it and opens `http://127.0.0.1:8790/`.
- If port `8790` is occupied by something that is not RabiRoute manager, exits without starting a duplicate process.
- If `dist/manager.js` is missing or older than source files, runs `npm.cmd run build` unless `-NoBuild` is passed.
- Starts `node dist\manager.js` in the background when no manager is running.
- Opens RibiWebGUI after the manager answers.
- Starts the PySide6/Qt task panel unless `-NoTray` is passed.
- Starts the tray with `--owns-manager` only when this launcher started the manager.
- Reuses an already-running Qt task panel instead of launching duplicate tray windows.

Logs go to:

```text
data/route/default-main/logs/
```

Each launcher run creates timestamped files such as:

```text
launcher-YYYYMMDD-HHMMSS.log
manager-YYYYMMDD-HHMMSS.stdout.log
manager-YYYYMMDD-HHMMSS.stderr.log
tray-YYYYMMDD-HHMMSS.stdout.log
tray-YYYYMMDD-HHMMSS.stderr.log
```

Useful direct commands:

```powershell
.\Start-RabiRoute-Tray.bat
.\Start-RabiRoute-Tray.bat -NoOpen
.\Start-RabiRoute-Tray.bat -NoBuild
.\Start-RabiRoute-Tray.bat -NoTray
.\Start-RabiRoute-Tray.bat -ManagerUrl http://127.0.0.1:8790
```

## What the launcher does not do

The launcher does not start or stop NapCat, QQ, or any non-RabiRoute process. It also does not kill an existing RabiRoute manager or gateway that it did not start. If a port conflict exists, it reports the conflict and leaves processes alone.

## Manager shutdown API

The portable Node manager exposes a local-only graceful shutdown endpoint:

```text
POST http://127.0.0.1:8790/manager/shutdown
```

This endpoint exists so the Windows tray can stop the manager it owns without using Windows-only process killing. The manager is already bound to `127.0.0.1`; the endpoint should not be exposed to the network. It stops managed gateway child processes, closes the HTTP server, and exits. The same shutdown path is used for `SIGINT` and `SIGTERM`.

Alternatives considered:

- Killing the manager PID from the tray: rejected for MVP because it is Windows-specific and more likely to leave child processes or logs in a rough state.
- Signal files: possible later, but slower to observe and less direct than a local HTTP API already served by manager.
- Making the tray the long-running parent process: avoided for now so the Node manager remains the portable core and the Windows tray stays a convenience layer.

## macOS and Linux

The portable startup path is already supported and remains the baseline:

```bash
npm install
npm run build
npm run start:manager
```

Then open:

```text
http://127.0.0.1:8790/
```

That means the server, WebUI, manager API, gateway runtime, task repository layout, and graceful shutdown protocol are not Windows-only.

What is Windows-only today is the convenience launcher:

```text
Start-RabiRoute-Tray.bat
```

A future macOS/Linux desktop entry should be another platform launcher, not another RabiRoute core. It should follow the same contract:

1. Detect `http://127.0.0.1:8790/meta`.
2. Start `node dist/manager.js` only when no manager is running.
3. Start the tray/floating panel with `--manager-url`.
4. Pass `--owns-manager` only if that launcher started the manager.
5. Let tray exit call `POST /manager/shutdown` only when it owns the manager.

Possible platform launchers:

- macOS: `.command` script first, then a small `.app` wrapper or LaunchAgent later.
- Linux: `.desktop` file plus shell script first, systemd user unit only if long-running autostart is needed.
- Both: reuse the same PySide6/Qt panel code where the desktop environment supports system tray; otherwise run the floating window as a normal desktop panel without relying on tray-only behavior.

The code boundary to preserve is:

```text
Portable: manager HTTP API, shutdown API, ManagerClient, TaskRepository, RoleContextRepository, LifecycleController, app_paths, Qt TaskWindow.
Platform adapter: launch script, packaging, autostart, OS-specific tray availability and startup behavior.
```

## Qt task panel

The PySide6/Qt task panel under `desktop/tray-task-window` is optional for cross-platform Node manager startup, but it is part of the Windows "1+1" desktop entry. Qt is cross-platform, so the panel code should stay reusable on Windows, macOS, and Linux.

Recommended local setup when the tray entry is needed:

```powershell
py -m venv .venv-tray
.\.venv-tray\Scripts\python.exe -m pip install -r desktop\tray-task-window\requirements.txt
.\.venv-tray\Scripts\python.exe desktop\tray-task-window\main.py
```

Do not install PySide6 globally unless that is explicitly desired for the machine.

The launcher looks for Python in this order:

1. `desktop\tray-task-window\.venv\Scripts\python.exe`
2. `.venv-tray\Scripts\python.exe`
3. `py.exe -3`
4. `python.exe`

If Python or PySide6 is missing, the tray process exits with a clear message in the tray stderr log while manager/WebGUI remain available.

On desktop environments without a system tray, the Qt app should still show the floating panel as a normal window. The platform launcher is responsible for choosing whether that is acceptable UX for that OS/package.

The Qt panel also has a cross-platform single-instance lock per project root. This protects macOS/Linux launchers too, not only the Windows PowerShell launcher.

## Tray exe packaging

The repository includes the packaging spec and build wrapper, but generated exe files are local artifacts, not source files.

Build locally:

```powershell
.\scripts\build-tray-exe.ps1
```

The script runs `npm run build`, invokes PyInstaller with `RabiRoute-Tray.spec`, and copies `dist\RabiRoute-Tray.exe` to the repository root for local testing. `RabiRoute-Tray.exe` is ignored by Git. Do not publish the generated exe until the binary has a separate release sanitation pass, because PyInstaller outputs may contain build-machine paths.

Runtime boundary:

- The exe packages the PySide6 tray entry only.
- The exe does not bundle Node.js, `dist/manager.js`, `ribiwebgui/dist`, or runtime `data`.
- In frozen mode, `desktop/tray-task-window/main.py` resolves the project root from `Path(sys.executable).parent`.
- If manager is not running, the exe starts `node dist/manager.js` and owns that process for shutdown.

Before shipping a real exe, verify:

- `dist/manager.js` and `dist/index.js` are built.
- `ribiwebgui/dist/index.html` exists.
- `data/route/<configName>/adapterConfig.json` and `data/roles/<RoleId>/personaConfig.json` remain writable runtime files.
- Logs are written outside bundled resources.
- The desktop entry never becomes the only supported startup path.

Potential future packaging:

- GitHub Releases: use only after a separate binary sanitation and smoke-test pass.
- Small installer: can lay down Node/runtime prerequisites and a checked-out project folder later.
- Electron shell: only worth considering if the WebGUI truly needs desktop-window features.
