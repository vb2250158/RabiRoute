# Plugin data ownership and upgrades

[简体中文](plugin-storage.md)

Plugin packages contain source, public schemas and defaults. Stable data owners hold effective configuration and private state. Package versions never select storage paths.

```text
stateRoot/data/plugins/<pluginId>/
  <plugin-shared private files>
  instances/<stableInstanceId>/<files with a real independent instance owner>
```

Application profiles supply public defaults; `PluginProfileSettings` remains the owner of user instance overrides. Each effective configuration has one read/write owner. Route, persona, request, receipt and delivery replay stores retain their original host or persona owners.

Cold-start storage preparation resolves the version selected by the same instance settings. Its default search order includes bundled packages, locally imported packages under `stateRoot/data/plugins/packages/`, and explicitly configured extension roots. A version installed through the native API remains available after restart without also appearing in the bundle. An explicit `packageRoots` list still replaces these defaults. Missing or invalid packages remain isolated; migration failures are never bypassed.

| Plugin | Default storage |
| --- | --- |
| DSH | Plugin `credentials/`, including its local protection key, and `auth.json` |
| WorkBuddy | Plugin `auth.json`; WorkBuddy retains its native sessions and database |
| Bilibili history | `bridge.json` under the actual instance; history records remain persona-owned |
| Xiaomi Home | Plugin `resources.json` selects the runtime resource; new installations use the plugin's `runtime/` directory |

An existing Xiaomi Home VM, media, keys and ledgers stay at their original location through one explicit resource binding. Migration does not copy or move an active Hyper-V disk. `health.storage.runtimeDir` shows the actual location. Users can configure the plugin's `runtimeDir`, or edit the absolute path in its formal `resources.json` after retiring that owner.

The 0.6 → 0.7 storage layout upgrade requires a full Host generation change. After the previous owners retire, the Manager acquires its instance lock and loads the formal environment, then invokes this single entry before assembling plugins:

```ts
await prepareApplicationPluginStorage({
  phase: "owners-retired",
  layout,
  readOnly
});
```

Each plugin declares its sources and targets in `storage-migrations.json`. Physical migration preserves a private raw backup, verifies content, atomically publishes the target, then retires the original file. Recovery material lives under `stateRoot/data/.runtime/plugin-storage-backups/0.7/`. After interruption, migration verifies the original source, backup and target against the original receipt before completing it. Actual conflicts preserve all claims and report a failure only for the affected plugin. Read-only startup moves no data.

An old shared Bilibili queue migrates only when its original instance owner is unambiguous. Jobs are never copied to multiple execution owners. New installations without an old shared source allow independent instance directories.

A remote Agent runs the same entry after retiring its previous owner, with explicit local Agent profile, settings, package roots, layout and environment. Some old remote versions selected default storage relative to their package location. When the updater has exact original owner metadata, it can pass:

```ts
legacySources: [
  { pluginId, migrationId, sourcePath: absoluteOriginalResourcePath }
]
```

`legacySources` selects each original resource by plugin and migration ID. It takes precedence over `legacyStateRoot`, which applies only to an actual shared old root. The updater never scans caches or picks the newest directory. If an old protocol did not record the original path, obtain that owner's path record before adopting it; do not report the data as migrated. Explicit environment and user paths remain in effect.

Old profile package references change only through exact packageId/fromVersion declarations in the published `package-migrations.json`. Queries report effective migrations without rewriting the original profile, overlay, instance IDs or business files.

Malformed rows remain local to their owner. Queries expose `partial` and actual location diagnostics while healthy records remain readable. Root JSON, schema and I/O failures preserve the original file and return recovery errors. Batch replay requiring complete evidence cannot treat omitted damaged rows as a complete ledger.

HTML snapshots, content keys and GUID reuse records belong to stable private storage for `io.rabiroute.manager.html-shares`, independent of its package version. Relay retains routing metadata and forwards opaque encrypted frames. Normal restarts and original-device reconnections reuse the persistent directory and device identity, so existing links can be reopened. There is currently no automatic TTL or revocation control; live connections are not offline hosting. Prepared attachment payloads belong to the original delivery transaction and cannot be treated as disposable temporary files.
