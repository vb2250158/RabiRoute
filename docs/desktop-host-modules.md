# Desktop host modules

The Windows Qt Desktop is a presentation host.  It does not own persona data,
desktop-pet packs, bindings, or Manager business rules.

## Composition

```text
plugins/profiles/desktop.json
  -> Manager plugin package io.rabiroute.manager.desktop-pet
       -> desktop-pet API, pack/binding validation, resource access

desktop/tray-task-window/rabiroute_tray/desktop-host.profile.json
  -> Qt host io.rabiroute.desktop.qt-host
       -> selected builtin presentation features
           -> io.rabiroute.desktop.pet-renderer@1
                -> Manager API client, animation window, tray actions
```

The two profiles have different owners.  The Manager profile selects backend
packages and is the only authority for API routes and persona-owned assets.
The Qt-host profile selects trusted presentation features.  A Qt feature gets a
small context (Manager URL, host actions, and explicit callbacks), returns a
disposer, and cannot read persona directories or install arbitrary Python code.

This follows the same composition shape as DSH: a profile names independent
packages; a package exposes a constrained host entry (`apply` / `activate`);
the host supplies capabilities; and the package's lifecycle is released through
the disposer.  It intentionally does not claim that Python and DSH share a
binary loader or execute each other's modules.

## Adding a built-in Qt feature

1. Add its stable feature id and trusted module path to
   `rabiroute_tray/desktop_feature_runtime.py`.
2. Implement `activate(context) -> disposer` in that module.  Keep Manager
   business rules behind an existing API.
3. Select it in `desktop-host.profile.json`.
4. Add a lifecycle/profile test.  Do not wire it directly into `tray_app.py`.

Unknown feature ids, malformed profiles, and disabled entries are ignored.
That is a fail-closed selection boundary; allowing third-party presentation code
requires the separate Extension Host work rather than expanding this builtin
allowlist.
