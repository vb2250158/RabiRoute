<a href="./cordis-plugin-runtime-refactor.md">简体中文</a> | English

# RabiRoute Cordis Plugin Runtime

> Status: Profile, Patch, Bundle, content revisions, Manager Fiber hot replacement, and Web Bundle remounting are implemented.
>
> Primary readers: RabiRoute maintainers and plugin authors.

## Current entry point

The Manager Plugin source of truth is the Profile:

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
```

Every Profile entry has a stable `id`, Bundle `package`, pinned `version`, `enabled` state, and JSON `config`. Patches apply `upsert` and `remove` in lexical filename order. Package installation, version selection, and local configuration overrides are separate concerns.

When the Profile is absent, Manager uses the Bundle-owned default Profile plus old `manager.json.managerPlugins` enabled values for its first load; after the HTTP listener is ready, it writes the Profile and removes the old field. An existing Profile is the only configuration source. The same initialization rewrites old `rabi.manager.builtin` Profile or Patch rows to `rabi.manager.base`. Normal reconciliation reads only Profile, Patch, and Bundle data; it never reads or writes the old field.

## Bundle contract

Every Bundle directory needs `rabi.plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "example.manager.echo",
  "version": "1.0.0",
  "hosts": ["manager", "web"],
  "entry": "./index.mjs",
  "webEntry": "./client.mjs"
}
```

The manifest declares only identity, version, hosts, and entries. It cannot declare commands, arbitrary paths, URLs, or environment variables. The Manager calculates a SHA-256 revision over every Bundle file and imports each revision from an isolated runtime directory so old module caches cannot pollute the new version.

`rabi.manager.base` is the base Bundle shipped with RabiRoute. Its `index.mjs` directly owns the 26 definitions, dependencies, and presentation contributions, while `rabi.manager.profile.json` owns the default Profile. Manager no longer creates an in-process built-in definition on the Bundle’s behalf. The base Bundle receives only an instance-scoped capability to activate Manager-owned resources; external Bundles never receive it.

## Manager lifecycle

A Profile, Patch, or Bundle file change triggers one coalesced reconciliation:

1. The Loader reads the Profile, Patches, and selected Bundle versions.
2. The Reconciler compares the active Fiber by stable `id + revision`.
3. A changed instance stops accepting new routes, removes registered routes, and drains accepted work.
4. The old Fiber disposes and the new isolated revision imports and mounts.
5. Failed activation restores the previous successful Fiber. A failed restore is recorded in reconciliation status.

A Manager Bundle may only register instance-scoped routes, track asynchronous work, publish named events, read bounded JSON requests, and return JSON. It cannot read Manager global state or replace core control-plane routes.

`manager:core` is a Profile entry but cannot be disabled. Modules that own ports, process supervision, or long-lived external connections still stop or restart through a supervised lifecycle; they do not process messages while half-unloaded.

## Web Bundle hot replacement

`GET /api/plugins/modules` returns the active Web Bundle graph from the most recent successfully reconciled Manager runtime snapshot: instance ID, package ID, version, and SHA-256 revision. It does not reread Profile data on request, so failed or dependency-waiting instances are never published to the browser. After receiving `plugin_catalog_changed`, WebGUI:

1. disposes each loaded module whose revision changed;
2. loads `/api/plugins/modules/<instanceId>/client.js?rev=<revision>`;
3. permits the new module to register only controlled pages, settings renderers, or status renderers;
4. reactivates the prior revision if new activation fails; it exposes an error and keeps the host recovery entry only when both activations fail.

A Web entry is a single-file ESM module loaded directly by the browser. Publishers must bundle dependencies into `client.mjs`; the current module URL does not expose a relative-import dependency tree.

## Acceptance entry points

- [Plugin Bundles and Hot Replacement](plugin-bundles_en.md): Profiles, Patches, directories, and the constrained API.
- [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README_en.md): the smallest Bundle with a Manager route and Web status card.
- `GET /api/plugins/reconciliation`: current instances, revisions, reconciliation state, and rollback results.
- `GET /api/plugins/modules`: current Web Bundle graph.

DSH's Profile / Bundle / Patch / stable-ID / disposable-effect model is the reference. RabiRoute retains ownership of its Route, event-record, delivery, and Outbox business facts instead of turning them into globally writable Bundle state.
