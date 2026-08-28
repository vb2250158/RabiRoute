# Manager Echo Plugin

English | [简体中文](README.md)

This out-of-tree example uses the production manifest, shared SDK, Manager HTTP primitive, and an independent Web entry.

## Install

```powershell
$packageRoot = "C:\RabiRoutePlugins"
$profilePath = "C:\RabiRouteProfiles\desktop.json"
$target = Join-Path $packageRoot "example.manager.echo\1.0.0"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item examples/plugin-bundles/manager-echo/* $target -Recurse -Force
$env:RABIROUTE_PLUGIN_PACKAGE_ROOTS = $packageRoot
$env:RABIROUTE_PLUGIN_PROFILE = $profilePath
```

Add this instance to the Profile:

```json
{
  "id": "manager:example-echo",
  "package": "example.manager.echo",
  "version": "1.0.0",
  "enabled": true,
  "config": { "message": "hello" },
  "grants": ["manager.http"]
}
```

After Manager starts, the plugin provides:

```text
GET /api/plugins/example-echo
Plugin Echo page in WebGUI
```

Changing `manager.mjs`, `web/client.mjs`, or the Profile switches revision without changing Manager PID. Removing the Profile row releases the route, service, and page; the package directory can then be deleted.
