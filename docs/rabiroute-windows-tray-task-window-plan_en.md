<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabiroute-windows-tray-task-window-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Windows Tray Plan and Memory Window

> Status: implemented-boundary record. Use [Windows Launch and Packaging](windows-launcher-and-packaging_en.md) and `desktop/tray-task-window/` for current runtime details.

The Windows tray application is a lightweight desktop entry for viewing the selected role's plans, recent memory, consolidated memory, conversation, and runtime status. It is not a replacement for RibiWebGUI, an Agent OS, an executor, or a full project-management application.

## Sources of truth

```text
data/roles/<RoleId>/plans/items/active/*.json
data/roles/<RoleId>/plans/archive/*.json
data/roles/<RoleId>/memory/recent/*.json
data/roles/<RoleId>/memory/consolidated/*.json
```

The tray does not reconstruct plans or memory from chat logs and does not read the retired task-directory layout.

## Views

- Chat: reads the selected role's role-panel timeline. The message editor, file picker, and send button appear only in this view.
- Current: shows plans whose wire status is `进行中` first, then recent memory; the two groups keep their separate file sources of truth.
- Plans: read-only overview of all non-archived plans.
- Recent memory: recent items created or updated by the handler through RabiRoute APIs.
- Archived: read-only overview of archived plans and consolidated memory.
- Diagnostics: a read-only table for Manager, gateway, role/plans/memory paths, route-status path, and runtime-status summaries.

All six views are first-level navigation destinations. Recent memory, Archived, and Diagnostics are no longer hidden in the overflow menu. The left sidebar only switches routes; the header only identifies the selected role, Manager/Gateway state, and current route; the overflow menu retains secondary directory actions, manual triggers, refresh, and sidebar collapse.

The visual layer reuses RibiWebGUI's `RabiLight` language: mist-blue page backgrounds; white navigation, header, composer, and card surfaces; deep navy body text; and teal hover, selected, and focus states. Components share light borders and 8px radii. Qt styling remains presentation-only and does not copy WebGUI configuration state or create a second theme data source.

Plan and memory entries share one expandable read-only row pattern. While collapsed, trigger keywords stay on one line: the row reveals more complete keywords as width becomes available and marks any hidden remainder with `……`. Expanding the row reveals every keyword plus the detail fields already supplied by the existing JSON sources. The layout does not create an independent progress source of truth, analytics, settings, or a second copy of runtime state.

Expanded plans use an action-summary-first hierarchy: `currentStep` and `nextAction` appear in a two-column summary, followed by existing metadata such as priority, kind, project, waiting state, timestamps, source, and file. The tray reader accepts an optional `steps` array for compatibility. Only when the source file provides real steps does the panel derive completed counts and render a progress bar, six-row preview, and Reveal All action. This is a read-only presentation derivation; it never writes the plan or invents percentages without step data.

## Write boundary

Plan and memory views are read-only. The tray does not create, edit, complete, archive, delete, normalize, or migrate role-knowledge files. Writes go through the Manager's Agent/role APIs.

The role conversation endpoint is a separate current capability; it can append role-panel messages and route them to the handler without giving the plan/memory viewer direct mutation access.

## Lifecycle

The tray connects to the portable Manager at `http://127.0.0.1:8790`. **Exit RabiRoute** calls `POST /manager/shutdown`, allowing the Manager to stop gateways and close cleanly. The desktop panel remains optional for the portable Node/WebGUI runtime.
