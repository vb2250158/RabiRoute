<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.desktop

This built-in Manager plugin reuses desktop settings and managed config-file owners through `host.manager.desktop@1`, and provides `manager.desktop@1`. Existing settings sections, hotkeys, system commands and tray entries remain plugin contributions.

`createDesktopControlOperations` installs four public operations from the same executable contracts:

| Operation ID | HTTP endpoint | Result |
| --- | --- | --- |
| `manager.desktop.settings.read` | `GET /api/desktop/settings` | Original settings and whether explicit autostart configuration exists |
| `manager.desktop.settings.patch` | `PATCH /api/desktop/settings` | Merge, normalize and persist settings |
| `manager.desktop.settings.put` | `PUT /api/desktop/settings` | Preserve the original PATCH-style merge semantics |
| `manager.desktop.config.open` | `POST /open-config-file` | Prepare a managed config file or directory, then invoke the original local opener |

Settings writes merge `screenshot` fields recursively by one level; other fields retain the original shallow merge and shared normalization. Persistence uses the original atomic file owner and mutation audit, followed by `desktop_settings_changed` carrying the saved `webTheme`. Successful writes retain `autostartConfigured=true`, which proves saved configuration rather than operating-system startup registration or applied desktop UI state. Read-only mode rejects settings mutations before consuming their bodies. Original permissive JSON, empty-body `{}`, any Content-Type and absence of an application byte limit remain.

Opening configuration uses query parameters `type`, `gatewayId` and `roleId`; the first repeated value wins, missing values become `null`, and the body is ignored. Supported types are manager, role/persona, role-folder, role-message-config, xiaomi-recordings/xiaomi-media/camera-clips, routes and route-folder. Original role/route sanitization and file transactions remain authoritative. Preparation may create or write configuration. HTTP success proves preparation and opener dispatch returned, not that an application window became visible. Native transaction failures retain their HTTP status and stable error code.

Authenticated remote connections use the same public contracts, existing explicit user disables and native object rules, without a new local-origin requirement. There is no request-level idempotency key. Read back the original settings or file after an error or disconnect; do not assume no effect occurred or automatically replay the action. Retirement stops admission and joins accepted file preparation and opener dispatch without closing user applications.
