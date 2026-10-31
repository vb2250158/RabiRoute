English | [简体中文](web-hot-patches.md)

# Installed Web hot patches

Status: experimental. Covers WebGUI, static resources, user guides compiled into the page, and independent Web Bundles. Compatible Web updates keep the Manager PID, application generation and instance unchanged. A changed backend fingerprint, dependency lock or plugin contract cannot be published with Web-only updates; follow the actual [source hot-patch](source-hot-patches_en.md) and state-migration support matrix. Only a concrete non-migratable boundary or missing runtime support on first installation requires a Host-controlled switch.

## Pages and versions

- Each content-addressed candidate contains the Web output, documentation and plugin entry mapping. Root HTML `data-rabi-web-release` and `x-rabiroute-web-revision` identify that candidate.
- JS, CSS, fonts, images and lazy resources use `/_rabiroute/web/<hash>/web/...`. Module catalog requests carry `webRelease=<hash>`. Missing matching modules fail closed rather than mixing releases.
- New or deliberately refreshed pages use the current release. Existing pages retain the old release. Publication does not force-refresh Vue instances, resubmit forms or restart business consumers.
- Root HTML is not cached; versioned assets use immutable caching. Legacy `/assets/...` and unversioned module routes serve the installed baseline solely for pages opened before the upgrade. They are not a publication mechanism. Their retirement condition is closure or refresh of all pre-upgrade pages; new root HTML must reference versioned assets only.
- Rollback changes subsequent page selection, not committed business data. Backend source compatibility is documented separately in [source hot patches](source-hot-patches_en.md).

## Automatic build and activation

1. One release owner installs support on first use; later publication follows actual compatibility. Discover `managerBaseUrl` through `RabiRouteHost.exe --command status --json`; match `/meta` application/Manager identities and require `health.live=true` with `health.state=healthy|degraded`. `health.requiredReady` diagnoses declared capabilities; the target interface decides its dependencies, and unrelated capability failures do not veto the operation.
2. Configure the Host with a trusted `RABIROUTE_HOT_PATCH_SOURCE_ROOT`. `RABIROUTE_HOT_PATCH_WATCH=0` disables automatic activation. Do not select a build directory another task is cleaning.
3. Use `npm run webgui:build` for one build or `npm run webgui:watch` for continuous work. The latter watches Web sources, shared contracts, resources and documentation, serializing type checks and Vite **production builds**, not a development server. Stopping it does not stop Manager.
4. Builds exclusively own `ribiwebgui/.web-patch-build.lock`; concurrent builds fail closed. If a crashed process leaves it behind, verify its recorded PID has exited and no build owner remains before removing that lock.
5. Source changes during a build, type errors, missing assets, bad hashes and incompatible backends do not publish a completion marker. Watch mode retries after the next actual input change, not endlessly for unchanged failures.
6. A successful build writes `dist/web-patches/<hash>` before atomically replacing `dist/web-patches/latest.json`. Manager validates completed candidates, then atomically records the active pointer and receipt. Do not overwrite installation files.

The backend compatibility fingerprint includes compiled JS/MJS, non-Web JSON, `package.json` and `package-lock.json`. A changed fingerprint cannot be published through Web-only updates. Use the actual source hot-patch and migration support matrix; do not rewrite fingerprints to bypass compatibility.

## Query, manual activation and rollback

| Endpoint | Contract |
| --- | --- |
| `GET /api/web-patches` | State, active/previous candidate, revision, runtime identities and limits; no business writes |
| `GET /api/web-patches/operations/<operationId>` | 200 for a committed receipt; 404/not_started only when ready; 503/unknown when blocked or starting |
| `POST /_rabiroute/host/web-patches` | Loopback plus Host authority; publishes an already imported candidate, never network source or arbitrary paths |
| `POST /_rabiroute/host/web-patches/reconcile` | Same authority; reconciles a finished local persistence attempt without executing publication or business writes again |

Use Host forwarding instead of reading or sharing its token. Read the current identities, revision and candidate hash, then save the complete request at an absolute path. For rollback, select `previous`; rollback itself creates a new revision:

```json
{
  "operationId": "web-release-operation-unique-id",
  "applicationGenerationId": "<current application generation>",
  "managerInstanceId": "<current Manager instance>",
  "pluginGenerationId": "<current plugin generation>",
  "candidate": "<64 lowercase hex characters>",
  "expectedRevision": 1
}
```

```powershell
& $hostExe --command web-patch --application-generation-id $generation --web-patch-request $requestPath --json
```

Freeze each operation's payload. Reusing its ID with a different candidate or revision is rejected. Host timeouts are unconfirmed: query the original operation instead of replaying with another ID. If necessary, retain the operation ID, supply freshly verified identities and use `web-patch-reconcile`. `committed` returns the persisted receipt; only `not_started` permits a deliberate retry. Keep `unknown` operations frozen. Corrupt state never silently clears history.

## Capacity and maintenance

A candidate is limited to 8192 files and 128 MiB. Optional imports are admitted only while the current backend has fewer than 64 valid manifest records, with 2048 receipts per backend baseline. The installed baseline is required startup material and is never rejected because historical slots are full, so physical candidate counts can exceed 64. Optional imports retain their existing wait-for-baseline and serialized commit order. Foreign-backend, unknown and unverifiable-manifest history remains untouched and does not count against the current backend. Counting validates manifest hashes and schemas without reading existing payloads; import sources, reused destinations and actual static reads retain full content verification. The in-memory manifest cache holds at most eight releases.

This version **does not automatically delete old disk candidates or receipts**. At the current backend limit, new optional imports are rejected while idempotent imports and reads of existing releases remain available. Historical candidates are not automatically archived; total disk usage still needs separate management. The current service continues; unlimited continuous updating is not claimed. Offline archival requires publication to be frozen, complete state/receipt backups, confirmation that old pages are closed and old backends will not be recovered. Never delete candidates solely by timestamp. Without those conditions, keep the capacity warning and preserve data.

## Acceptance

Run `npm run test:web-patches`, Host contract tests, `node --test scripts/dynamic-manager-active-truth.test.mjs`, and `npm run build`. Real control-plane acceptance must additionally verify:

- Continuous HTTP reads before, during and after updates; old lazy assets, guides and modules still match their original hash.
- Automatic activation followed by formal Host rollback without changing Manager identity or backend processes.
- Build, integrity and persistence failures retain the old service; timeouts and disconnected clients do not duplicate business effects, and original operations remain queryable.
- Served root HTML and downloaded bytes match the candidate. Source tests, one health check and development servers do not replace installed-runtime evidence.
