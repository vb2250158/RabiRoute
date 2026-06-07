# RabiRoute Qt Task Panel

Minimal PySide6/Qt MVP for the RabiRoute desktop task panel.

This is an extra desktop convenience entry. Qt/PySide6 is cross-platform, so the floating task panel and most tray code should be reusable on Windows, macOS, and Linux. RabiRoute itself, its manager client, task repository, path resolution, lifecycle rules, and role task reads must stay portable. Platform launchers and packaging are the adapter layer.

## Purpose

This app is a desktop entry for RabiRoute tasks, not a replacement for RibiWebGUI or the external control console.

MVP scope:

- Stay resident in the desktop system tray when the current platform and desktop environment support `QSystemTrayIcon`.
- Fall back to a normal floating panel when a desktop environment does not expose a system tray.
- Right-click tray menu opens RibiWebGUI.
- Right-click tray menu shows or hides the current task floating window.
- Right-click tray menu refreshes task and manager status.
- Right-click tray menu opens the role task directory, role directory, current project directory, and runtime state directory.
- Read manager status from `http://127.0.0.1:8790`.
- Read Rabi task files from `data/roles/Rabi/tasks` under the project root, or from the role directory reported by manager.
- Show an empty state when the task directory exists but no official task JSON has been confirmed yet.
- Open folders through Qt desktop services, which gives Windows Explorer, macOS Finder, or Linux file-manager behavior depending on platform support.
- Provide a usable floating window with switchable read-only views: current plan/task, short-term plan, long-term plan, short-term memory, long-term memory, tasks, and status/route status.

Out of scope for this MVP:

- Replacing `npm run start:manager`, `npm run manager`, or `node dist/manager.js`.
- Making RabiRoute Windows-only.
- Treating a bat file as the only startup method.
- Writing task facts.
- Adding Windows startup registration or exe packaging.
- Sending QQ / NapCat messages.
- Adding an MCP server, local port server, or heavyweight command protocol. Keep only extension points for later.

## Startup Model

RabiRoute itself remains cross-platform.

Windows PowerShell:

```powershell
npm run start:manager
npm run manager
node dist\manager.js
```

macOS / Linux:

```bash
npm run start:manager
npm run manager
node dist/manager.js
```

The Qt panel is a convenience layer. Windows currently has the first launcher; macOS/Linux can add launchers later while reusing the same Qt panel, manager client, task repository, role context repository, path resolver, and lifecycle controller.

## Dependency

Requires Python 3 and PySide6. Do not install dependencies automatically from this MVP.

Suggested manual install when ready:

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

If PySide6 is missing, the entry script exits with an install hint instead of a Python traceback.

## Run

```powershell
py desktop\tray-task-window\main.py
```

Standalone mode only connects to an existing manager. Closing the tray in standalone mode does not stop the manager.

The Qt panel is single-instance per project. If another copy is already running for the same project root, a new launch exits with a clear message instead of creating another tray icon/window.

The Windows launcher can start it as part of the "1+1" lifecycle:

```powershell
Start-RabiRoute-Tray.bat
```

Direct equivalent command:

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790 --owns-manager
```

Use `--owns-manager` only when the same launcher started the manager process. In that mode, tray `Exit RabiRoute` calls the manager's local graceful shutdown endpoint before closing the tray.

## Floating Window Views

The floating window is intentionally plain for the MVP: a status header, view buttons, a read-only text area, and a refresh button.

Current views:

- `当前`: official current task JSON when available, plus read-only runtime `todoNotes` as a clearly marked supplement.
- `短期计划`: official short-term task JSON.
- `长期计划`: official long-term task JSON.
- `短期记忆`: recent role JSONL summaries from message, voice, and heartbeat logs.
- `长期记忆`: `longTermContextNotes` from route state, falling back to role markdown summaries.
- `任务`: all official task JSON found under known task locations.
- `状态`: manager reachability plus route status files such as gateway adapters, NapCat, heartbeat, and role voice/audience mode.

No view writes task or memory data.

## Data Boundary

Task facts must live under the active role directory:

```text
data/roles/<RoleId>/tasks
```

The MVP currently understands:

```text
tasks/current.json
tasks/short-term.json
tasks/long-term.json
tasks/current/*.json
tasks/short-term/*.json
tasks/long-term/*.json
tasks/items/current/*.json
tasks/items/short-term/*.json
tasks/items/long-term/*.json
```

It still treats the folder as read-only. It does not create, complete, delete, normalize, or migrate tasks.

This tray app must not store task facts in Qt resources, app resources, installer data, or temporary caches. Internally the manager client and task repository use HTTP, JSON, and `pathlib` so the non-tray logic stays portable. Windows-specific packaging, startup registration, or tray behavior differences belong in a later platform layer.

## Later Extension Point

MCP/server/port integration is deliberately paused for this MVP. If RabiRoute later needs to control the floating window externally, add a small cross-platform command adapter around the existing snapshots and view keys instead of coupling UI widgets directly to MCP.

## Lifecycle Boundary

The tray never starts or kills RabiRoute core by itself. A platform launcher is the supervisor:

- If the launcher starts manager, it starts tray with `--owns-manager`; tray exit stops that manager.
- If manager was already running, the launcher starts tray without ownership; tray exit closes only the tray.
- The manager remains independently runnable on Windows/macOS/Linux via `npm run start:manager`.
- If duplicate tray processes already exist from older builds, close the extra panel from its tray/window UI. Non-owned tray processes close only themselves.

The ownership rule is implemented in `rabiroute_tray.lifecycle_controller`, which is platform-neutral. Windows currently supplies the first launcher through `scripts/start-rabiroute-windows.ps1`. A future macOS/Linux launcher should reuse the same flags and manager HTTP lifecycle protocol instead of forking tray behavior.

## Code Layout

Portable layers:

- `ManagerClient`: HTTP API adapter for manager status and graceful shutdown.
- `TaskRepository`: read-only task files under `data/roles/<RoleId>/tasks`.
- `RoleContextRepository`: read-only role memory/status summaries.
- `LifecycleController`: ownership and shutdown decision rules.
- `app_paths`: manager/gateway payload to local path resolution.
- `TaskWindow`: PySide6 view state and rendering.
- `DesktopAdapter`: Qt desktop services for opening URLs, files, folders, and app icon lookup.
- `tray_app`: Qt application wiring, tray menu, refresh loop, and floating panel startup.

Platform-specific layers:

- Windows `.bat` / PowerShell launcher.
- Future macOS `.command` / LaunchAgent / app bundle launcher.
- Future Linux `.desktop` / systemd user unit / shell launcher.
- Packaging, autostart registration, and OS-specific tray availability handling.
