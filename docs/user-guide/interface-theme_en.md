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
- **Add custom theme**: clone every parameter from the current theme, then edit its name, light/dark base, semantic colors, corner radius, surface opacity, and shadow. **Save and apply** makes it active immediately and keeps it as a selectable theme.

Built-in choices are persisted by the page save action. A custom theme is persisted directly by **Save and apply**. The current WebGUI changes immediately. The tray changes on its next settings refresh, usually within ten seconds, and also reads the saved choice on restart.

## Single source of truth

The theme is a host-level desktop setting stored in `data/desktop/settings.json`:

```json
{
  "theme": "custom:night-rain-green",
  "webTheme": "custom:night-rain-green",
  "customThemes": [
    {
      "id": "custom:night-rain-green",
      "name": "Night Rain Green",
      "baseTheme": "dark",
      "colors": { "success": "#16a34a" },
      "styles": { "cornerRadius": 8, "shadow": "soft", "glassOpacity": 94 }
    }
  ]
}
```

`theme` stores the Desktop-compatible selection. `webTheme` stores the WebGUI selection and may also reference a trusted Web-only plugin theme. Older settings without `webTheme` inherit `theme`; dangling `custom:*` values fall back to an available theme. Manager's `GET` and `PATCH /api/desktop/settings` are the common interface for WebGUI and Windows Desktop. The legacy browser key is migrated once and removed, so it cannot become a second source of truth.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/shared/interfaceThemeContract.ts` and `desktopSettingsContract.ts` | Built-in templates, custom fields and bounds, selected theme, and input validation. |
| Manager | Read and write the host setting, and return it through `/api/desktop/settings`. |
| WebGUI | Load built-in CSS tokens and Vuetify palettes from `ribiwebgui/src/themes/light/` or `dark/`; map custom semantic colors onto the same tokens; and make every switch use theme-owned off-track, thumb, and green on-state colors. |
| Windows tray | Load built-ins from `desktop/tray-task-window/rabiroute_tray/themes/`; generate a Qt palette, menu stylesheet, and existing-window color replacements from the same custom declaration. |

The theme controls appearance colors and system color preference only. It does not change routing, messages, plans, permissions, or data handling.

## Verification

1. Change the theme, refresh WebGUI, and confirm the choice remains.
2. Open the tray menu and role panel. Their background, text, borders, and buttons use the same light or dark mode as WebGUI.
3. Enable the selected-text menu and screenshot feature. Their action bar and screenshot windows change with the tray theme.
4. Choose Follow system, switch the system color mode, and confirm that both WebGUI and tray update.
5. Check switches on different pages: the off state fits the current theme, while the on state consistently uses the green supplied by that theme.
6. Clone the current theme, change the Success / On color, and save it. Confirm WebGUI switches, the tray menu, and the role panel update, and that the theme remains selectable after refreshing.
