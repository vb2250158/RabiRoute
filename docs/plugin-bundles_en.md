# Plugin Bundles and Hot Replacement

English | [简体中文](plugin-bundles.md)

The Manager Plugin source of truth is the Profile, not `manager.json`. Each entry has a stable `id`, a trusted Bundle package and version, an enabled state, and JSON configuration. `profile.d/*.json` patches apply `upsert` and `remove` operations in filename order.

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
  rabi.plugin.json
  index.mjs
  client.mjs (optional)
```

The first startup migrates old `manager.json.managerPlugins` entries and old `rabi.manager.builtin` Profile rows into the `rabi.manager.base` Bundle. After migration, `manager.json.managerPlugins` is not read. `manager:core` remains a Profile entry but cannot be disabled.

`rabi.plugin.json` may declare only its schema, package ID, version, hosts, Manager entry, and optional Web entry. It cannot carry commands, arbitrary paths, URLs, or environment variables. Manager hashes every Bundle file into a SHA-256 revision. A Profile, Patch, entry, or dependency change makes the file watcher copy the new revision into an isolated runtime directory; the Plugin Reconciler then stops the old Fiber, removes routes, drains accepted work, and mounts the new Fiber. A failed activation restores the old Fiber.

A Manager Bundle can use only the controlled host API to register HTTP routes, track asynchronous operations, publish named plugin events, read a bounded JSON body, and return JSON. The host fixes every route to the current `instanceId`; unloading automatically removes all routes and waits for accepted work. A Bundle cannot access global Manager state or replace a core route.

The Web module catalog at `/api/plugins/modules` exposes an instance ID, package ID, version, and revision. The browser loads `/api/plugins/modules/<instanceId>/client.js?rev=<revision>`; after `plugin_catalog_changed`, it first runs the old disposer and then activates the new Bundle. If activation fails, it reactivates the preceding revision; only a failed rollback leaves the module unavailable. A Web Bundle can only register controlled pages, settings renderers, and status renderers. It cannot mutate Manager internals. `webEntry` is a single-file ESM module loaded directly by the browser; publishers must bundle dependencies into that file because the current HTTP contract does not expose relative-import dependencies.

A minimal working Bundle is available at [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README_en.md).
