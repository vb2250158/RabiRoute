# Startup window and plugin lifecycle

[简体中文](startup-and-plugin-lifecycle.md)

An interactive double-click shows the RabiRoute brand window before installation checks and the original Host startup. It reports real stages without a fixed display duration or invented percentage. It closes when the service is available. Closing the window or choosing “Continue in background” hides the presentation while the original Host continues. Command queries, background autostart and elevated scheduled tasks do not open another startup window.

## Core availability and background initialization

The critical path retains release selection, original Host control and process ownership, Manager identity and listener, and the actual dependency closure of the profile's `readyRequires`. Host-owned plugin management and diagnostics remain available when a business plugin fails.

Other plugins initialize in the background. Consumers wait for actual published dependencies; a slow or failed independent plugin does not hold unrelated plugins or management. Source-patch watching starts after Manager READY, while its compiler and entered publication work retain their original shutdown owner. Reading dependency declarations is distinct from executing plugin initialization.

The UI distinguishes desired configuration from runtime facts:

- **Initializing**: initialization is incomplete; an update can retain the previous running version.
- **Active**: the activation is published; an additional initialization marker still reports unfinished post-publication startup.
- **Stopping**: configuration is disabled or removed while actual resources are retiring.
- **Retirement unconfirmed**: the original owner's diagnostic remains visible without disabling unrelated functionality.

Confirmed retirement clears the current stopping state. Historical diagnostics do not permanently classify a stopped plugin as unconfirmed.

## Install, disable and uninstall

Use the Plugins page to select an available package version, or import an SDK-built runtime directory **on the computer running the RabiRoute Host**. It must contain `rabi.plugin.json` and its declared entries and resources. This is directory import, not ZIP upload.

Release directories stay immutable. Imported packages live under `data/plugins/packages/<pluginId>/<version>`. Explicitly installed versions are retained there so Host updates do not discard independent plugin selections. Different bytes cannot overwrite an existing plugin/version; publish a new plugin version instead.

The original per-instance `PluginProfileSettings` owns enabled state and installation membership, retaining revision checks. Uninstall removes effective membership and uses the original Kernel to cancel initialization, withdraw registrations and release resources. Stored configuration and business data are preserved. Reinstalling a removed version reuses its original instance identity. Already installed packages can add another instance; actual declarations and the Kernel report capability conflicts.

Accepting a settings write does not prove resource exit. The page follows lifecycle events and readback for initialization, retirement and failures. Uncertain results are read back without automatically repeating installation. A malformed instance remains local; installing never overwrites a broken or foreign target settings file.

## Authoring asynchronous initialization

All executable plugins keep the same `activate(context): void | Promise<void>` contract. Declarative plugins require no extra executable glue. Async work belongs to the original activation and `EffectScope`:

```ts
export async function activate(context) {
  const resource = await openResource({ signal: context.lifecycle.signal });
  context.effects.adopt(() => resource.close(), "resource connection");
  context.services.provide("example.resource@1", resource);
}
```

Do not register services after cancellation. Late resources still belong to the original scope, and disposal promises must represent actual exit. Use the original Worker execution path for CPU-heavy work: adding `async` does not move synchronous computation off the main thread. Dependencies come from manifests rather than a hardcoded startup list.

Kernel `.switch()` retains its default completion semantics. Manager uses `initialization: "background"` for optional initialization. `settle(instanceId?)` joins existing work and `pendingRetirements()` reports actual resource owners. Initialization and cleanup run outside the global mutation queue; publication and rollback retain the original transaction.

## Replacing the startup animation

Startup follows the existing `desktop settings.webTheme` selection. A theme adds `value.startup` to its existing static `theme` contribution:

```json
{
  "kind": "theme",
  "id": "example.theme",
  "value": {
    "surface": "shared.themes",
    "hosts": ["web", "desktop"],
    "themeId": "example",
    "webResourceId": "example.web-theme.v1",
    "startup": {
      "schemaVersion": 1,
      "light": {"background": "#F5F8FC", "foreground": "#17242C", "accent": "#22BEC5"},
      "dark": {"background": "#111B21", "foreground": "#F0F6FA", "accent": "#6CE8E6"},
      "motion": "orbit",
      "logo": "./assets/logo.ico",
      "frames": [
        {"logo": "./assets/frame-1.ico", "durationMs": 160},
        {"logo": "./assets/frame-2.ico", "durationMs": 160}
      ]
    }
  }
}
```

Use the existing `{"contributions": [...]}` resource wrapper. Both `entries.manager` and `entries.desktop` can declare `execution: "declarative"` and reference this file. A theme selectable in the Web UI also registers matching `themeId` and `webResourceId` through the original Web `api.registerTheme`. The launcher does not execute that Web code.

ICO frames and durations provide custom frame animation. Without frames, `none`, `breathe` and `orbit` provide built-in presentation. System animation preferences retain a static image. The native window displays the brand first, preloads theme icons asynchronously and reuses in-memory handles. Closing, replacing a theme and exiting release the original resources.

After settings, membership or package changes, Manager rebuilds `data/desktop/startup-theme.json` and the current SHA icon cache. Cold startup reads only this local presentation. Disabled, removed or unavailable themes use the brand without delaying Host startup. Unreferenced derived icons are cleaned; authoritative configuration and original plugin resources are retained.
