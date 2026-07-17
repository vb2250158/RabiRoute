<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabiroute-ue-ux-audit-and-refactor.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute UI/UX Audit and Refactor Notes

> Status: phase design audit. It records issues and principles; the list is not a current completion ledger. Verify the live WebGUI, Qt panel, and plugin entry before treating an item as open or finished.

## Goal

Unify visible RabiRoute surfaces into a clear local message-dispatch console. A user should quickly understand whether the Manager, tray, route, message endpoint, and handler are healthy and what to do next.

The intended character is “Rabi as a lightweight, reliable message courier,” combined with the structural clarity of a mature admin console: stable navigation, configuration cards, adapter/plugin entry points, diagnostics, logs, status filters, and trace-like runtime observation.

The work must preserve product boundaries:

- RibiWebGUI remains the complete management surface.
- The Qt tray/floating panel remains the lightweight resident entry.
- The NapCat plugin page remains an integration jump point.
- Windows-specific convenience does not move into the portable core.
- Visual inspiration must not become brand or layout copying.

## Audit themes

- Make the first screen establish operational confidence.
- Separate the terms Manager, route, message endpoint, handler, role, and rule.
- Use consistent empty/error/loading states with a concrete next action.
- Align visual rhythm across WebGUI, Qt, and plugin entry pages.
- Keep Rabi character assets restrained and functional.
- Emphasize route/endpoint/handler health over marketing content.
- Preserve accessibility, readable density, and keyboard/focus behavior.

## Recommended implementation order

1. Define shared terminology, status colors, and component rhythm.
2. Improve the overview and route health hierarchy.
3. Normalize empty/error states and diagnostic actions.
4. Align adapter, handler, logs, and documentation pages.
5. Bring Qt and plugin entry pages into the same language without duplicating the full WebGUI.
6. Re-run usability and accessibility checks against the actual implementation.

## Acceptance principles

- A new user can identify the active route and first broken boundary without reading logs.
- Status text distinguishes configured, running, connected, authenticated, verified, and experimental.
- The UI does not imply that an experimental adapter is production-ready.
- Visual changes do not alter Manager/gateway protocols or hide actionable diagnostics.
- Each empty/error state explains the safest next step.
