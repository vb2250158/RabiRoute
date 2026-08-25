# Manager Echo Bundle

English | [简体中文](README.md)

This is a minimal hot-replaceable Manager and Web Bundle. Copy it into the trusted local Bundle directory, then add `manager:example-echo` to the Profile. It provides:

```text
GET /api/plugins/example-echo
A Plugin Echo page and status card in WebGUI
```

```powershell
$target = "plugins/packages/example.manager.echo/1.0.0"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item examples/plugin-bundles/manager-echo/* $target -Recurse -Force
```

Create `data/plugins/manager/profile.d/10-example-echo.json`:

```json
{
  "schemaVersion": 1,
  "operations": [
    {
      "op": "upsert",
      "plugin": {
        "id": "manager:example-echo",
        "package": "example.manager.echo",
        "version": "1.0.0",
        "enabled": true,
        "config": { "message": "hello" }
      }
    }
  ]
}
```

Saving the Patch, `index.mjs`, or `client.mjs` creates a new Manager revision. The backend stops the old Fiber, removes its routes, and drains accepted work. The browser runs the old disposer before activating the new Web entry. If the new Web entry fails, the browser restores the prior revision.

`client.mjs` is a single-file ESM entry loaded directly by the browser. Bundle it into one file before publishing; the current HTTP contract does not serve relative-import dependencies.
