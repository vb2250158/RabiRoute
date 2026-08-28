English | <a href="./plugin-bundles.md">简体中文</a>

# Plugin Packages and Hot Replacement

Manager loads built-in and out-of-tree packages through one Plugin Kernel. Both use the same `rabi.plugin.json`, `@rabiroute/plugin-sdk`, capability dependencies, permission checks, and effect lifecycle.

## Production layout

Default build output:

```text
dist/plugins/profiles/desktop.json
dist/plugins/packages/<package-id>/<version>/
  rabi.plugin.json
  manager.mjs
  web/client.mjs  # optional
```

Source packages live only in `plugins/builtin/`. `npm run build` creates `dist/plugins/`; Manager never loads plugin code from the source directory.

Use an independent package root and one Profile for out-of-tree plugins:

```powershell
$env:RABIROUTE_PLUGIN_PACKAGE_ROOTS = "C:\RabiRoutePlugins"
$env:RABIROUTE_PLUGIN_PROFILE = "C:\RabiRouteProfiles\desktop.json"
npm run start:manager
```

Separate multiple Windows roots with `;`. The environment selects the process Profile and package roots. After startup, package or Profile changes hot-replace the affected generation.

## Profile

There is one Profile schema and no Patch format:

```json
{
  "schemaVersion": 1,
  "instances": [
    {
      "id": "manager:example-echo",
      "package": "example.manager.echo",
      "version": "1.0.0",
      "enabled": true,
      "config": { "message": "hello" },
      "grants": ["manager.http"]
    }
  ]
}
```

`id` is the instance identity. `package` and `version` select the installed package. `grants` lists permissions granted to that instance. Disabling or removing an instance releases its routes, listeners, timers, connections, services, and UI contributions.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "example.manager.echo",
  "version": "1.0.0",
  "entries": {
    "manager": "./manager.mjs",
    "web": "./web/client.mjs"
  },
  "provides": ["example.manager.echo@1"],
  "requires": ["host.manager.http@1"],
  "optional": [],
  "permissions": ["manager.http"]
}
```

Capability references use `name@major`. A missing required capability produces `waiting_dependency`; an ungranted permission fails closed. The manifest rejects removed host fields, standalone entry fields, and startup commands.

## Hot replacement

Manager hashes every package file into a SHA-256 revision and imports an isolated copy below `data/plugins/.runtime/`.

- unchanged revision, configuration, permissions, and dependency revisions do not reactivate;
- only the changed plugin and its real dependency component reload;
- unrelated plugins keep running;
- candidate activation or effect publication failure keeps the preceding working generation;
- successful publication disposes the preceding effect scope;
- Web modules use immutable revision URLs and retain the preceding working module after failure;
- ordinary updates do not replace Manager or Gateway processes.

`GET /api/plugins/catalog` returns plugins and UI contributions. `GET /api/plugins/reconciliation` returns active, waiting, failed, and diagnostic state. `POST /api/plugins/reconciliation` rereads immediately.

## Plugin author entrypoints

- SDK: `plugins/contracts/plugin-sdk/`
- built-in packages: `plugins/builtin/`
- Profile: `plugins/profiles/desktop.json`
- working example: [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README_en.md)
- architecture and boundaries: [`manager-plugin-implementation-hot-swap_en.md`](manager-plugin-implementation-hot-swap_en.md)

Run before submission:

```powershell
npm run check:plugin-architecture
npm test
npm run build
```
