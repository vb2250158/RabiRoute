<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Qt role panel

> Status: current desktop convenience layer. The panel is implemented and used by the Windows launcher, but it does not replace the Manager, RibiWebGUI, or Codex/ChatGPT Desktop.

This PySide6/Qt application provides a tray icon and floating role panel. It reads Manager, Route, plan, and memory state, and can send text or file attachments to the Agent bound to the selected Route through the `rolePanel` message adapter.

The Qt layer is kept portable where practical. See the [Windows launcher and packaging guide](../../docs/windows-launcher-and-packaging_en.md) for the authoritative packaging boundary.

## Current capabilities

- Uses the system tray when available and falls back to a normal window otherwise.
- Enforces one panel instance per project root.
- Reads Routes, runtime status, and role bindings from the Manager.
- Switches between Routes and six views: Chat, Current, Plans, Recent Memory, Archived, and Diagnostics.
- Keeps all six views visible in the primary navigation; Current is grouped into in-progress plans and recent memory, while Diagnostics uses a read-only status/path table.
- Follows RibiWebGUI's `RabiLight` visual language: mist-blue page backgrounds, white surfaces, deep navy text, teal interaction accents, 8px radii, and light borders, while running, warning, and offline states retain distinct semantic colors.
- Collapsed plan and memory cards keep trigger keywords on one responsive line, reveal more as the window widens, and mark hidden items with `……`; expanding the card reveals every keyword.
- Expanded plan cards prioritize Current Step and Next Action in a two-column summary before metadata. When the source plan JSON actually contains a `steps` array, the tray also shows completed/total counts, a progress bar, and completed/current/pending step rows, previewing six rows with an option to reveal all. It does not infer progress when step data is absent.
- Reads role-panel history and sends explicit text or file messages.
- Displays plans and memories without editing their JSON files.
- Opens role, plan, memory, project, and runtime-status directories.
- Runs declared `manual_trigger` or `heartbeat` actions from the selected persona rules.
- Opens RibiWebGUI, refreshes state, and requests a graceful local shutdown.

Sending a message or trigger is an explicit user action. The panel never creates, edits, completes, archives, or deletes plan and memory files directly.

## Out of scope

- Replacing `npm run start:manager` or `node dist/manager.js`.
- Executing real Codex prompts; Desktop IPC still delivers them to a loaded task.
- Sending QQ/NapCat messages or bypassing Route policy.
- Hosting a new MCP server, command port, or fallback task Runtime.
- Making the core project Windows-only.

## Install and run

Python 3 and PySide6 are required:

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

Connect the panel to an existing Manager:

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790
```

The Windows launcher starts the Manager and tray together:

```powershell
Start-RabiRoute-Tray.bat
```

## Data and message boundary

Plans come from `data/roles/<RoleId>/plans`; memories come from `data/roles/<RoleId>/memory`. Those repositories are read-only in the panel.

Role chat uses Manager APIs and passes through the selected Route's `rolePanel` input, template policy, and Agent adapter. It does not write plan or memory facts directly.

## Lifecycle

`Exit RabiRoute` requests `POST /manager/shutdown`. The Manager stops managed Gateways and its HTTP service before the panel exits. If graceful shutdown fails, the UI remains visible instead of hiding a live background service.

## Code layout

- `ManagerClient`: status, chat, manual-trigger, and shutdown APIs.
- `PlanRepository` and `RoleContextRepository`: read-only local data.
- `LifecycleController`: exit decisions.
- `TaskWindow`: Route navigation, six views, composer, and rendering.
- `DesktopAdapter`: portable URL and path opening.
- `tray_app`: tray menu, refresh loop, and application assembly.

Future macOS and Linux launchers should reuse this Manager protocol and Qt panel rather than fork the business behavior.
