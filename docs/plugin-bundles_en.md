# Plugin Bundles and Hot Replacement

English | [简体中文](plugin-bundles.md)

The Manager Plugin source of truth is the Profile, not `manager.json`. Each entry has a stable `id`, a trusted Bundle package and version, an enabled state, and JSON configuration. `profile.d/*.json` patches apply `upsert` and `remove` operations in filename order.

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
  rabi.plugin.json
  index.mjs
  web/client.mjs (optional, with browser dependencies beside it)
```

When the Profile is absent, the first load uses `rabi.manager.base/rabi.manager.profile.json` plus old `manager.json.managerPlugins` enabled values; after the listener is ready, initialization writes the Profile and removes the old field. An existing Profile never reads the old field. The same initialization migrates old `rabi.manager.builtin` Profile or Patch rows to `rabi.manager.base`. Normal reconciliation does not read `manager.json.managerPlugins` after that. `manager:core` remains a Profile entry but cannot be disabled.

`rabi.plugin.json` may declare only its schema, package ID, version, hosts, Manager entry, and optional Web entry. It cannot carry commands, arbitrary paths, URLs, or environment variables. Manager hashes every Bundle file into a SHA-256 revision. A Profile, Patch, entry, or dependency change makes the file watcher copy the new revision into an isolated runtime directory; the Plugin Reconciler then stops the old Fiber, removes routes, drains accepted work, and mounts the new Fiber. A failed activation restores the old Fiber.

A Manager Bundle can use only the controlled host API to register HTTP routes, track asynchronous operations, publish named plugin events, read a bounded JSON body, and return JSON. The host fixes every route to the current `instanceId`; unloading automatically removes all routes and waits for accepted work. A Bundle cannot access global Manager state or replace a core route.

The Web module catalog at `/api/plugins/modules` exposes an instance ID, package ID, version, revision, and `entryPath`. The browser loads `/api/plugins/modules/<instanceId>/<revision>/<entryPath>`; JavaScript, CSS, and font dependencies relative to that entry come from the same retained Bundle revision. After `plugin_catalog_changed`, it first runs the old disposer and then activates the new Bundle. If activation fails, it reactivates the preceding revision; only a failed rollback leaves the module unavailable. A Web Bundle can only register controlled pages, settings renderers, status renderers, and theme resources. It cannot mutate Manager internals. Rollback never depends on WebGUI static assets overwritten by a newer build.

A minimal working Bundle is available at [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README_en.md).
