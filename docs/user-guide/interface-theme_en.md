<!-- docs-language-switch -->
<div align="center">
  <a href="./interface-theme.md">Simplified Chinese</a> | English
</div>
<!-- /docs-language-switch -->

# Interface theme

**Current guide.** The Settings page, WebGUI, tray menus, role panel, selected-text action bar, and screenshot windows use the same theme choice.

## Use it

Choose one option on the WebGUI **Settings** page:

- **Follow system**: RabiRoute follows the current light or dark appearance of the browser and Windows.
- **Light**: always use the light interface.
- **Dark**: always use the dark interface.

The current WebGUI changes immediately after saving. The tray changes on its next settings refresh, usually within ten seconds, and also reads the saved choice on restart.

## Single source of truth

The theme is a host-level desktop setting stored in `data/desktop/settings.json`:

```json
{
  "theme": "system"
}
```

The allowed values are `system`, `light`, and `dark`. A missing or invalid value becomes `system`. Manager's `GET` and `PATCH /api/desktop/settings` are the common interface for WebGUI and the Windows tray. Browser local storage, tray-private files, and individual window state must not become a second theme setting.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/shared/desktopSettingsContract.ts` | Theme values, default value, and input validation. |
| Manager | Read and write the host setting, and return it through `/api/desktop/settings`. |
| WebGUI | Load CSS tokens and the Vuetify palette from `ribiwebgui/src/themes/light/` or `ribiwebgui/src/themes/dark/`, and observe browser system-color changes for Follow system. |
| Windows tray | Load its palette and menu stylesheet from `desktop/tray-task-window/rabiroute_tray/themes/light/` or `desktop/tray-task-window/rabiroute_tray/themes/dark/`, then update the Qt application, role panel, selected-text action bar, and screenshot windows during refresh. |

The theme controls appearance colors and system color preference only. It does not change routing, messages, plans, permissions, or data handling.

## Verification

1. Change the theme, refresh WebGUI, and confirm the choice remains.
2. Open the tray menu and role panel. Their background, text, borders, and buttons use the same light or dark mode as WebGUI.
3. Enable the selected-text menu and screenshot feature. Their action bar and screenshot windows change with the tray theme.
4. Choose Follow system, switch the system color mode, and confirm that both WebGUI and tray update.
