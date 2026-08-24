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
- Desktop enables tray commands, panel actions, system selection, system-capture and clipboard-pin hotkeys, and the `system` / `light` / `dark` themes from the Manager plugin catalog. Built-in contracts and explicitly allowed trusted extensions use the same Registry; only contracts declared by active plugins and registered on this host take effect. Deactivating a plugin removes its tray entries and panel actions and stops its system listeners. A catalog outage or refresh failure immediately withdraws stale contributions and system listeners and restores the fixed **Open RabiRoute WebGUI** recovery entry; after a valid catalog loads, only active plugin contributions can expose that entry. Active shortcuts still use values saved in **Settings**. Missing or unsupported declarations leave their hotkeys unregistered and fall back to the system theme.
- Follows RibiWebGUI's `RabiLight` visual language: mist-blue page backgrounds, white surfaces, deep navy text, teal interaction accents, 8px radii, and light borders. The tray menu and the panel's More actions menu share this palette. Windows no longer registers Qt's implicit `setContextMenu`; presentation-only `TrayMenuController` handles both left-click `Trigger` and right-click `Context` and directly calls non-blocking `QMenu.popup()`, so either click immediately opens the same prewarmed menu. The role panel also completes an invisible QWidget/native-layout warmup before the tray icon becomes clickable, keeping the first persona click from paying several hundred milliseconds of construction cost. Persona actions first show, raise, and request activation synchronously inside the user-click callback, preserving Windows foreground-user permission, then apply cached DTOs and rebuild content on the next event-loop turn. Menu rebuilding likewise waits until the menu closes. The current persona and up to five persona-chat entries are shown directly, while overflow entries are created lazily when More personas opens. Running, warning, and offline states retain distinct semantic colors.
- Uses the same Rabi Manager backend as RibiWebGUI. Route summaries and persona display information come from `/gateways?summary=1`; plans, memory, role conversation, and avatars come from `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar`, while plan approval feedback uses `/api/roles/:roleId/plans/:planId/feedback`. The tray never reads `data/` or persona files directly. A Qt-free `DesktopRefreshService` assembles API snapshots and a generic Qt thread-pool bridge runs them asynchronously; refreshes, role-chat sends, approval submissions, manual triggers, and shutdown requests keep Manager I/O off the UI thread. A hidden panel requests only the lightweight Manager/Route summary—not plans, memory, conversation, or avatars—and does not rebuild widgets, so the 10-second tray refresh cannot repeatedly trigger large role-data reads. Completed refreshes wait while the tray menu is visible, and Manager fields outside the presentation signature do not rebuild the menu or panel. Only one refresh runs at a time, while explicit manual refresh remains queued. Transient failures retain and label the last snapshot; a real Manager disconnect still clears live state.
- `/gateways?summary=1` contains only persona identity, path, avatar, a lightweight title extracted from the file prefix, and other presentation metadata. It neither reads nor transfers full persona Markdown bodies, avoiding repeated large persona transfers during the 10-second refresh.
- Collapsed plan cards use three summary rows: title, current step, and trigger keywords. The current-step row prefers the structured `Step N · title` form; plan and memory keywords stay on one responsive line, reveal more as the window widens, and mark hidden items with `……`. Expanding a plan hides the collapsed current-step summary and reveals every keyword plus the full plan details.
- Expanded plan cards list the complete `steps` array first, show completed/total progress, and identify the execution point with both a `Current: step N` callout and a highlighted row. Steps are no longer truncated to a six-row preview, and structured plans do not repeat `nextAction`. The status, callout, and current row become blocked only when Manager returns `presentation.tone=blocked`; raw `blockedBy` text does not let the tray invent a second blocked-state rule. Only legacy plans without `steps` keep the old current/next compatibility area.
- The card shows a purple `Awaiting QA` badge only when Manager identifies the structured current step as an in-progress `qa-* / verify-*` step. A future QA step, or prose such as “QA gate” and “QA not notified” inside an implementation step, does not change the badge; the tray never scans free-text phase keywords. This implementation/package/QA lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real workflows.
- Plan categories, stage counts, order, status colors, and approval contracts come from Rabi Manager. `presentation.views` supplies `current / plans / archived` membership, `status / tone / statusLevel / sortBucket / palette` supplies the label, colors, and ordering bucket, and `counts.stages` summarizes the presentation stages. Complete approval contracts sort first, followed by `Awaiting approval → Awaiting QA → Awaiting manual verification → In progress → Awaiting package → Completed → Archived → Paused` and newest `updatedAt`. External waiting reasons remain internal fields. Paused plans appear only under Plans and always sort last. The tray renders the API DTO without maintaining a second stage classifier, category, sorting, status-color, or contract-completeness rule.
- When Manager marks the current plan/step as requiring approval, the expanded card shows Manager's approval contract and missing fields. `incomplete/enabled=false` is labeled `Approval information incomplete / approval disabled` and disables input and submission; only `ready/enabled=true` can submit. Submission waits only for Manager persistence with a five-second request boundary; a `pending` response ends loading immediately while Agent notification continues in the background. Feedback remains linked to `planId` and `stepId`, and a failed record can retry with the same `feedbackId`. This entry never advances a step or changes plan status directly.
- Reads role-panel history and sends explicit text or file messages. The chat view groups messages by date, keeps sender and time inside each bubble, and renders attachments as compact file rows so timestamps and nested cards do not interrupt the conversation. The composer grows within a bounded height, sends with `Enter`, and keeps `Shift+Enter` for line breaks. Delivery waits for Manager and Agent-adapter confirmation on a background thread, so the window remains usable; failed sends keep the draft intact.
- Labels panel input as `Local user` instead of the selected persona, and reports success only after a matched Route and Agent adapter return `delivered`. Disabled Routes, rule misses, and missing handlers surface as failures.
- After an active plugin provides `desktop.system-selection`, turning on **Enable selected-text menu** in WebGUI **Settings** allows text selection with a mouse drag or with `Shift` plus an arrow key, `Home`, `End`, `PageUp`, or `PageDown`. The floating bar is horizontally centered on the selection bounds: an upward mouse drag prefers the top side, while a downward or same-line drag prefers the bottom side. Keyboard selection first combines the system caret bounds before and after expansion; when Unity has no system caret, the most recent click in the same window keeps the bar near the text instead of a window corner. Hovering over **Send to** opens the currently enabled and running persona list; clicking one item reuses role-panel delivery for that Route. Selection alone performs no action. Normal applications use UI Automation for both text and geometry. Only when the Unity Editor does not expose the selection does the desktop send a guarded temporary `Ctrl+C`, wait for the editor to update the clipboard, read the text, and restore the original clipboard. Password controls and still-unreadable selections are ignored. **Selected-text reading** is a sub-feature: when it is on, the left button is **Read aloud** and a click enters the RabiSpeech host FIFO; when it is off, the bar keeps only **Send to**. The TTS model selector appears only when both **Selected-text reading** and **Advanced options** are on.
- Under **Settings**, enabling system screenshots and configuring a shortcut makes region capture available from any Windows application. The capture window opens first without dimming the screen so you can select immediately. Hovering over a window shows its selectable bounds and size; once the image is ready, the area outside that window is dimmed while the window keeps its original brightness. That window is immediately the active operation area: press `Enter` / `Ctrl+C` to copy it, `F2` to send it, or the pin shortcut to pin it. A left click can still keep the whole window as a selection awaiting confirmation. After dragging, everything outside the selection is dimmed while the selected area remains at its original brightness; drag inside the selection to reposition it, or drag a corner or edge-midpoint handle to resize it. After a selection is confirmed, the toolbar uses icon buttons for selection adjustment, rectangle, arrow, text, copy, pin, and send; hover shows the text label, the active tool uses a teal background and bright border, and the active color uses a visible border. After selecting an area, use the toolbar to add a rectangle, arrow, or text in red, yellow, green, or blue; Text annotations accept unlimited multiline input; type directly on the screenshot; the input range grows with the longest line and line count, then click outside the text area to commit, click the annotation again to select it, drag it to move, drag its handles to resize the text box, double-click to edit, and use the separate text-properties bar to change the font size. `Ctrl+Z` removes the last mark. Copying, pinning, and sending bake the marks into the image. Copy, pin, or send waits until the image is ready. Dragging only creates a selection awaiting confirmation: `Enter` or `Ctrl+C` copies it, `F2` sends it, and the pin shortcut confirms and pins it. By default, confirming a pin or send also copies the selection to the clipboard; turn that off in Settings and use `Ctrl+C` or **Copy** when needed. `Ctrl+A` selects the full screen. Before a region is selected, a cursor-following tip shows a 10x pixel-sampling preview, the current color swatch, and the static-image HTML color code `#RRGGBB`. Press `C` to copy it directly without confirming a region, adding screenshot history, or showing a notification. Right-clicking, pressing `Esc`, or closing the capture window cancels that capture without adding it to history; copying, pinning, or sending commits the screen capture and selected area. In the capture window, `<` / `>` switches to the previous / next saved screen capture. The default **Pin shortcut** is `F3`: while a selected capture is open, it pins that selected area; otherwise it pins an image already on the clipboard. A pinned selection keeps its original screen position and size. Its drag position, zoomed size, and opacity are restored after RabiRoute Desktop restarts; closing that individual pin removes it. Switching capture history restores the last area used to copy, pin, or send that screen capture. **Send** continues to use the role-panel entry, and Codex/DSH receive real image input. Screenshots are kept in the private project `.rabiroute-message-images/` directory, while pin and area records are kept in private `data/desktop/`; neither is part of public examples.
- **Settings → Windows login startup** synchronizes a per-user Startup shortcut. Turning it off removes that shortcut. The tray watches the settings file, so changing the screenshot toggle, screenshot shortcut, auto-copy setting, pin shortcut, or login-startup option does not require restarting the tray.
- Keeps plan content and memory read-only; only Manager-declared approval steps accept appended feedback.
- Opens role, plan, memory, project, and runtime-status directories only while the corresponding panel commands are active.
- Shows and runs declared `manual_trigger` or `heartbeat` actions only while the `manager:gateway-runtime` manual-trigger command is active.
- Withdraws stale contributions and uses the fixed RibiWebGUI recovery entry whenever the plugin catalog is unavailable or refresh fails; after the catalog loads, an active plugin must contribute that entry. Refresh and graceful Manager shutdown remain fixed Desktop controls.

Sending a message, submitting approval feedback, or triggering a rule is an explicit user action. The panel never creates, edits, completes, archives, or deletes plan and memory files directly; Manager writes approval feedback to its audit record and the Agent decides whether to update the plan.

## Out of scope

- Replacing `npm run start:manager` or `node dist/manager.js`.
- Executing real Codex prompts; Desktop IPC still delivers them to a loaded task.
- Sending QQ/NapCat messages or bypassing Route policy.
- Hosting a new MCP server, command port, or fallback task Runtime.
- Making the core project Windows-only.

## Install and run

Python 3, PySide6, and the Windows UI Automation Python adapter are required:

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

Connect the panel to an existing Manager:

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790
```

### Trusted Desktop extensions

A trusted Python package exposes a registrar through the `rabiroute.desktop_extensions` entry-point group. Installing a package does not enable it. Add every allowed entry point explicitly when starting Desktop:

```powershell
py desktop\tray-task-window\main.py `
  --trusted-desktop-extension example-extension `
  --trusted-desktop-extension another-extension
```

Each allowed entry point receives the same `DesktopExtensionRegistry` during startup and may register command handlers, panel-action providers, lifecycle capabilities, hotkeys, themes, status cards, and settings-section contracts. Desktop freezes the Registry after all registrars return; runtime additions, replacements, and duplicate registrations are rejected. Installed packages omitted from `--trusted-desktop-extension` are never imported.

These entry points are trusted in-process code and can access the current Python process. A future Extension Host will provide process isolation for untrusted code.

The Manager plugin catalog decides when those contracts are active. Panel directory commands use `desktop.open-role-directory`, `desktop.open-plan-directory`, `desktop.open-memory-directory`, `desktop.open-project-directory`, and `desktop.open-runtime-directory`; manual triggers use `desktop.manual-trigger`, and system selection uses `desktop.system-selection`. Removing those active commands or capabilities removes the UI entries and stops the corresponding listener.

The Windows launcher starts the Manager and tray together:

```powershell
Start-RabiRoute-Desktop.bat
```

## Tray latency acceptance check

With the packaged tray running, measure the complete Windows tray-callback-to-visible-Qt-menu latency:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\measure-tray-menu-latency.ps1 -Samples 100
```

The script does not move the cursor and is unaffected by DPI coordinate virtualization. It simulates ordinary left-click and right-click tray notifications separately, then timestamps the menu's Windows `EVENT_OBJECT_SHOW` event. The check fails when either path has a p95 or maximum above 100ms.

## Data and message boundary

Manager remains the owner of plan and memory files under `data/roles/<RoleId>/`. The tray, like RibiWebGUI, consumes only Manager HTTP DTOs and never opens or parses those files; paths are used only for directory actions and diagnostics.

Role chat uses Manager APIs and passes through the selected Route's `rolePanel` input, template policy, and Agent adapter. It does not write plan or memory facts directly.

## Lifecycle

`Exit RabiRoute` from the RabiRoute Desktop menu requests `POST /manager/shutdown` with an explicit desktop-exit marker. Manager atomically persists private runtime intent as `stopped` before stopping managed Gateways and HTTP. If persistence or graceful shutdown fails, the UI stays visible; it does not leave a `running` supervisor intent that could resurrect the process.

A temporary Manager outage leaves the RabiRoute Desktop UI available, marks it offline, and keeps reconnecting. Full desktop startup through the Windows launcher or packaged RabiRoute Desktop also starts `scripts/watch-rabiroute-desktop-lifecycle.ps1`. That lightweight owner maintains one desktop runtime across its local backend and UI, then reuses existing safe startup gates after consecutive misses. QQ, NapCat, Route, and adapter health remain outside this supervisor. Plain `npm run start:manager` is a development or cross-platform backend entry and does not implicitly create RabiRoute Desktop.

## Code layout

- `ManagerClient`: the shared Manager HTTP backend client for Routes, plans, memory, conversation, avatars, actions, and shutdown.
- `DesktopRefreshService`: Qt-free API snapshot orchestration with no local role-file access.
- `desktop_models` / `desktop_read_model`: Manager DTO conversion and rebuildable presentation caches.
- `qt_async`: generic Qt thread-pool bridge with no Manager or role business logic.
- `system_selection`: Windows global mouse-drag and keyboard-selection detection, UI Automation text extraction, the Unity-only clipboard fallback, selection-avoiding no-activate floating bar, active-persona hover menu, and Manager-only speech/role-panel actions. The Read aloud button is hidden when `readAloudEnabled` is false.
- `system_screenshot`: Windows global region capture, selected-area or clipboard pinning, screen and selected-area history, restart-restored pinned-image windows, and role-panel image-attachment delivery; persistent settings are owned by Manager at `/api/desktop/settings`.
- `LifecycleController`: explicit user-exit decisions only; Manager reachability is presentation state and never decides tray lifetime.
- `TaskWindow`: Route navigation, six views, composer, and rendering.
- `DesktopAdapter`: portable URL and path opening.
- `tray_app`: presentation-only composition root for menus, windows, cached DTO application, and user events.

Future macOS and Linux launchers should reuse this Manager protocol and Qt panel rather than fork the business behavior.
