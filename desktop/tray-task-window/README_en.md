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
- Selects the only enabled Route on first open. It falls back to the `Rabi` persona or the first row only when enabled selection is ambiguous, so a disabled unrelated persona does not become the accidental default.
- Switches between Routes and six views: Chat, Current, Plans, Recent Memory, Archived, and Diagnostics.
- Keeps all six views visible in the primary navigation; Current is grouped into in-progress plans and recent memory, while Diagnostics uses a read-only status/path table.
- Follows RibiWebGUI's `RabiLight` visual language: mist-blue page backgrounds, white surfaces, deep navy text, teal interaction accents, 8px radii, and light borders. The tray context menu and the panel's More actions menu share this palette. Windows keeps the `setContextMenu` system registration for notification-area compatibility, while `activated(Context)` calls non-blocking `QMenu.popup()` as an immediate fast path when the menu is not visible yet; the top-level menu's style and geometry are precomputed. The current persona and up to five persona-chat entries are shown directly in the tray menu; selecting one opens that Route in the Chat view, while overflow entries are created lazily when More personas opens. Running, warning, and offline states retain distinct semantic colors.
- Uses the same Rabi Manager backend as RibiWebGUI. Route summaries come from `/gateways?summary=1`; plans, memory, role conversation, and avatars come from `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar`. The tray never reads `data/` directly. A Qt-free `DesktopRefreshService` assembles the API snapshot and a generic Qt thread-pool bridge runs it asynchronously; the UI thread only applies read-only DTOs. A hidden panel requests neither conversation nor avatar data and does not rebuild widgets, completed refreshes wait while the tray menu is visible, and unchanged snapshots do not rebuild the menu or panel. Only one refresh runs at a time, while explicit manual refresh remains queued. Transient failures retain and label the last snapshot; a real Manager disconnect still clears live state.
- Collapsed plan cards use three summary rows: title, current step, and trigger keywords. The current-step row prefers the structured `Step N · title` form; plan and memory keywords stay on one responsive line, reveal more as the window widens, and mark hidden items with `……`. Expanding a plan hides the collapsed current-step summary and reveals every keyword plus the full plan details.
- Expanded plan cards list the complete `steps` array first, show completed/total progress, and identify the execution point with both a `Current: step N` callout and a highlighted row. Steps are no longer truncated to a six-row preview, and structured plans do not repeat `nextAction`. When the current step or plan provides `blockedBy`, the status, callout, and current row become blocked states and a dedicated blocker-reason panel appears. Only legacy plans without `steps` keep the old current/next compatibility area.
- When the current step, current progress, or current waiting target clearly indicates QA testing or acceptance, the card derives a purple `Awaiting QA` badge instead of the green running badge. A future QA step that has not started does not change the badge; this read-only presentation marks a stage that may still require rework and does not rewrite the plan status.
- Reads role-panel history and sends explicit text or file messages. The chat view groups messages by date, keeps sender and time inside each bubble, and renders attachments as compact file rows so timestamps and nested cards do not interrupt the conversation. The composer grows within a bounded height, sends with `Enter`, and keeps `Shift+Enter` for line breaks. Delivery waits for Manager and Agent-adapter confirmation on a background thread, so the window remains usable; failed sends keep the draft intact.
- Labels panel input as `Local user` instead of the selected persona, and reports success only after a matched Route and Agent adapter return `delivered`. Disabled Routes, rule misses, and missing handlers surface as failures.
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

Manager remains the owner of plan and memory files under `data/roles/<RoleId>/`. The tray, like RibiWebGUI, consumes only Manager HTTP DTOs and never opens or parses those files; paths are used only for directory actions and diagnostics.

Role chat uses Manager APIs and passes through the selected Route's `rolePanel` input, template policy, and Agent adapter. It does not write plan or memory facts directly.

## Lifecycle

`Exit RabiRoute` requests `POST /manager/shutdown`. The Manager stops managed Gateways and its HTTP service before the panel exits. If graceful shutdown fails, the UI remains visible instead of hiding a live background service.

## Code layout

- `ManagerClient`: the shared Manager HTTP backend client for Routes, plans, memory, conversation, avatars, actions, and shutdown.
- `DesktopRefreshService`: Qt-free API snapshot orchestration with no local role-file access.
- `desktop_models` / `desktop_read_model`: Manager DTO conversion and rebuildable presentation caches.
- `qt_async`: generic Qt thread-pool bridge with no Manager or role business logic.
- `LifecycleController`: exit decisions.
- `TaskWindow`: Route navigation, six views, composer, and rendering.
- `DesktopAdapter`: portable URL and path opening.
- `tray_app`: presentation-only composition root for menus, windows, cached DTO application, and user events.

Future macOS and Linux launchers should reuse this Manager protocol and Qt panel rather than fork the business behavior.
