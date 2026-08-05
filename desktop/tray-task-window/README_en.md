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
- Follows RibiWebGUI's `RabiLight` visual language: mist-blue page backgrounds, white surfaces, deep navy text, teal interaction accents, 8px radii, and light borders. The tray menu and the panel's More actions menu share this palette. Windows no longer registers Qt's implicit `setContextMenu`; presentation-only `TrayMenuController` handles both left-click `Trigger` and right-click `Context` and directly calls non-blocking `QMenu.popup()`, so either click immediately opens the same prewarmed menu. The role panel also completes an invisible QWidget/native-layout warmup before the tray icon becomes clickable, keeping the first persona click from paying several hundred milliseconds of construction cost. Persona actions first show, raise, and request activation synchronously inside the user-click callback, preserving Windows foreground-user permission, then apply cached DTOs and rebuild content on the next event-loop turn. Menu rebuilding likewise waits until the menu closes. The current persona and up to five persona-chat entries are shown directly, while overflow entries are created lazily when More personas opens. Running, warning, and offline states retain distinct semantic colors.
- Uses the same Rabi Manager backend as RibiWebGUI. Route summaries and persona display information come from `/gateways?summary=1`; plans, memory, role conversation, and avatars come from `/api/roles/:roleId/plans`, `/memory`, `/role-panel/messages`, and `/avatar`, while plan approval feedback uses `/api/roles/:roleId/plans/:planId/feedback`. The tray never reads `data/` or persona files directly. A Qt-free `DesktopRefreshService` assembles API snapshots and a generic Qt thread-pool bridge runs them asynchronously; refreshes, role-chat sends, approval submissions, manual triggers, and shutdown requests keep Manager I/O off the UI thread. A hidden panel requests only the lightweight Manager/Route summary—not plans, memory, conversation, or avatars—and does not rebuild widgets, so the 10-second tray refresh cannot repeatedly trigger large role-data reads. Completed refreshes wait while the tray menu is visible, and Manager fields outside the presentation signature do not rebuild the menu or panel. Only one refresh runs at a time, while explicit manual refresh remains queued. Transient failures retain and label the last snapshot; a real Manager disconnect still clears live state.
- `/gateways?summary=1` contains only persona identity, path, avatar, a lightweight title extracted from the file prefix, and other presentation metadata. It neither reads nor transfers full persona Markdown bodies, avoiding repeated large persona transfers during the 10-second refresh.
- Collapsed plan cards use three summary rows: title, current step, and trigger keywords. The current-step row prefers the structured `Step N · title` form; plan and memory keywords stay on one responsive line, reveal more as the window widens, and mark hidden items with `……`. Expanding a plan hides the collapsed current-step summary and reveals every keyword plus the full plan details.
- Expanded plan cards list the complete `steps` array first, show completed/total progress, and identify the execution point with both a `Current: step N` callout and a highlighted row. Steps are no longer truncated to a six-row preview, and structured plans do not repeat `nextAction`. The status, callout, and current row become blocked only when Manager returns `presentation.tone=blocked`; raw `blockedBy` text does not let the tray invent a second blocked-state rule. Only legacy plans without `steps` keep the old current/next compatibility area.
- The card shows a purple `Awaiting QA acceptance` badge only when Manager identifies the structured current step as an in-progress `qa-* / verify-*` step. A future QA step, or prose such as “QA gate” and “QA not notified” inside an implementation step, does not change the badge; the tray never scans free-text phase keywords. This implementation/package/QA lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance keep their real workflows.
- Plan categories, stage counts, order, status colors, and approval contracts come from Rabi Manager. `presentation.views` supplies `current / plans / archived` membership, `status / tone / sortBucket / palette` supplies the label, colors, and ordering bucket, and `counts.stages` summarizes the presentation stages. Except for paused plans, complete approval contracts sort first and incomplete contracts next, followed by `Awaiting approval → Awaiting QA acceptance → Executing → Awaiting environment/assets/information/external response → Awaiting shared package → Not started → Completed → Archived` and newest `updatedAt`. Amber external waits and blue `Awaiting shared package` remain in Current. Paused plans appear only under Plans and always sort last. The tray renders the API DTO without maintaining a second stage classifier, category, sorting, status-color, or contract-completeness rule.
- When Manager marks the current plan/step as requiring approval, the expanded card shows Manager's approval contract and missing fields. `incomplete/enabled=false` is labeled `Approval information incomplete / approval disabled` and disables input and submission; only `ready/enabled=true` can submit. Submission waits only for Manager persistence with a five-second request boundary; a `pending` response ends loading immediately while Agent notification continues in the background. Feedback remains linked to `planId` and `stepId`, and a failed record can retry with the same `feedbackId`. This entry never advances a step or changes plan status directly.
- Reads role-panel history and sends explicit text or file messages. The chat view groups messages by date, keeps sender and time inside each bubble, and renders attachments as compact file rows so timestamps and nested cards do not interrupt the conversation. The composer grows within a bounded height, sends with `Enter`, and keeps `Shift+Enter` for line breaks. Delivery waits for Manager and Agent-adapter confirmation on a background thread, so the window remains usable; failed sends keep the draft intact.
- Labels panel input as `Local user` instead of the selected persona, and reports success only after a matched Route and Agent adapter return `delivered`. Disabled Routes, rule misses, and missing handlers surface as failures.
- Keeps plan content and memory read-only; only Manager-declared approval steps accept appended feedback.
- Opens role, plan, memory, project, and runtime-status directories.
- Runs declared `manual_trigger` or `heartbeat` actions from the selected persona rules.
- Opens RibiWebGUI, refreshes state, and requests a graceful local shutdown.

Sending a message, submitting approval feedback, or triggering a rule is an explicit user action. The panel never creates, edits, completes, archives, or deletes plan and memory files directly; Manager writes approval feedback to its audit record and the Agent decides whether to update the plan.

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

`Exit RabiRoute` requests `POST /manager/shutdown` with an explicit desktop-exit marker. Manager atomically persists private runtime intent as `stopped` before stopping managed Gateways and HTTP. If persistence or graceful shutdown fails, the UI stays visible; it does not leave a `running` supervisor intent that could resurrect the process.

A temporary Manager outage leaves the tray visible, marks it offline, and keeps reconnecting. Full desktop startup through the Windows launcher or packaged tray also starts `scripts/watch-rabiroute-desktop-lifecycle.ps1`. That lightweight owner maintains only the Manager/tray process pair and reuses existing safe startup gates after consecutive misses. QQ, NapCat, Route, and adapter health remain outside this supervisor. Plain `npm run start:manager` remains an independent core path and does not implicitly create a tray.

## Code layout

- `ManagerClient`: the shared Manager HTTP backend client for Routes, plans, memory, conversation, avatars, actions, and shutdown.
- `DesktopRefreshService`: Qt-free API snapshot orchestration with no local role-file access.
- `desktop_models` / `desktop_read_model`: Manager DTO conversion and rebuildable presentation caches.
- `qt_async`: generic Qt thread-pool bridge with no Manager or role business logic.
- `LifecycleController`: explicit user-exit decisions only; Manager reachability is presentation state and never decides tray lifetime.
- `TaskWindow`: Route navigation, six views, composer, and rendering.
- `DesktopAdapter`: portable URL and path opening.
- `tray_app`: presentation-only composition root for menus, windows, cached DTO application, and user events.

Future macOS and Linux launchers should reuse this Manager protocol and Qt panel rather than fork the business behavior.
