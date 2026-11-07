[简体中文](./plugin-catalog-api-contract.md) | English

# Plugin catalog API contracts

These contracts provide five executable operations for the plugin catalog, reconciliation status and Web modules. Core invokes their owners through its existing registration batch. Reconciliation retains the original invocation, queue and kernel publication transaction. Installed status is recorded by the corresponding release acceptance.

| Operation ID | Method and path |
| --- | --- |
| `manager.plugins.catalog.read` | `GET /api/plugins/catalog` |
| `manager.plugins.reconciliation.read` | `GET /api/plugins/reconciliation` |
| `manager.plugins.reconciliation.run` | `POST /api/plugins/reconciliation` |
| `manager.plugins.modules.list` | `GET /api/plugins/modules` |
| `manager.plugins.modules.read` | `GET /api/plugins/modules/:id/:rev/:relativePath`, with a multi-segment tail |

The catalog uses the existing `GenerationRuntime` and source-patch presentation. The first `host` value selects the host; empty means all. Modules retain `WebPluginModuleRegistry` and `WebPatchService` ownership and the first `webRelease` value. URLs, retained revisions, MIME, immutable caching and nosniff remain unchanged. Native module GET ignores Range; this owner adds neither CSP nor HEAD. JSON failures use the existing error presentation.

Authenticated connections without an Agent/persona binding may invoke these public operations. Read-only mode rejects reconciliation. Reconciliation joins its native queue, publication and cleanup. Success reports actual current readiness, active/waiting/failed lists and diagnostics; an unchanged generation is not a new publication. No idempotency key or automatic replay guarantee is introduced.

Before body handling, admission captures the original connection lease, application/Manager identity, source root and owner references. The owner rechecks after asynchronous work and before disclosure. Revocation, identity/source change or cancellation after native dispatch preserves trusted `mutationOutcome=unknown` without disclosing business data. Timeout or disconnect does not release a producer lease before actual completion.

## Local catalog failures and refresh

Catalog presentation materializes each contribution as JSON independently. A failing getter, cycle or serialization error leaves healthy contributions available. `data.partial: true` / `data.diagnostics` report `PLUGIN_CONTRIBUTION_PRESENTATION_FAILED` with the original instance, plugin, kind and ID. The Web parser also isolates invalid plugin rows with `PLUGIN_CATALOG_ITEM_INVALID` and a row index. An untrustworthy response envelope remains a refresh failure.

A temporary Web refresh failure retains the last valid catalog and reports the refresh error separately. Actual HTTP 401/403 clears the current catalog, immediately withdraws original module registrations and cancels initialization. The original module still joins late work and cleanup. A later explicit catalog read can restore healthy modules without waiting for an unrelated old owner to stop. See [startup and plugin lifecycle](startup-and-plugin-lifecycle_en.md#independent-web-module-initialization-and-retirement) for module initialization and actual retirement.

Module URLs retain one decoding step under their original contract. This group's `pathTails` are decoded by the shared parameter parser, with no second decode in the resource registry. A raw resource tail declared as `pathRemainder` passes unchanged to its resource owner, which performs the single decode; public dispatch does not decode that raw tail first.

## Wiring requirements

1. Remove the `handlePluginCatalogApi` import and its complete direct `if` branch in `controlPlaneRoutes.ts`, including its return/closing braces. Keep no boolean dispatcher.
2. `controlPlaneRoutes.ts` supplies the factory and native context through the existing core service. The core plugin registers these five operations in its original `registerOperationsAsync` batch and returns that registration’s disposer. Reconciliation retains the original queue, invocation fences and actual candidate cleanup; do not introduce the previously proposed independent `manager:plugin-catalog-owner` registration or another listener.
3. Pass a stable context and `managerReadOnly`, the existing `managerPluginKernel`, and `root:()=>rootDir`. Check `invocation?.assertCurrent()` before and after `managerSourcePatches.invoke("manager.plugin-catalog","renderPluginCatalog",[input,host])` inside `renderCatalog(input,host,invocation)`.
4. Check before/after `managerWebPatches.modules(webPluginModules.list(),webRelease)` in `webModules.list(webRelease,invocation)`. In `read(id,rev,path,invocation)`, preserve the original WebPatchService-then-registry fallback, checking after each await, before fallback and before return. Never replace the original request or reacquire a lease.
5. Pass the original invocation to `reconcileManagerPlugins("manual API request",{invocation})`. Check before queueing, after dequeue/loadPluginProfile, before changing `loadedManagerPluginProfile`, after kernel switch and before module/status/event publication. Return the actual `managerPluginKernel.current()`. Keep native profile selection and failure recovery; queue acceptance is not completion.
6. The formal kernel interface is `GenerationSwitchOptions.beforePublish?:()=>void`. Both controller and dedicated fixture pass `beforePublish:()=>invocation.assertCurrent()` to `switch()`. The regression loads a real temporary package, pauses its candidate effect commit, revokes the real connection and then releases preparation. The kernel rejects inside its synchronous publication transaction; old generation/services/contributions retain their original references, and neither candidate publication nor afterPublish runs. HTTP completion and request drain wait for the actual candidate disposer. This exercises the native publication point, not just an outer wrapper. Shared controller execution and lifecycle during core's own retirement remain part of unified acceptance.

The original reconciliation restores its old profile only when switch throws. If switch has already published and a later assertion fails, do not restore a stale profile or claim no write occurred. Synchronize the committed native local state, suppress response disclosure and retain `unknown`. Local consistency and external response authorization require separate handling.

## Validation scope

Dedicated tests use temporary packages/profiles, native `loadPluginProfile`, `GenerationRuntime`, `WebPluginModuleRegistry`, the actual registration snapshot and loopback HTTP. They cover authenticated unbound remote success, disabled profiles, readiness/candidate failures, native bytes/cache, revocation/source changes, revocation during candidate preparation and unknown outcomes after publication. A real child stdout producer is stopped on disconnect/deadline; its request lease remains until process close and owner cleanup complete. The unified owner runs the shared build, final controller routing and installed acceptance. No production plugin change, download/install or real platform/Agent delivery is performed.

Clients form multi-segment module tails from the operation contract, retaining the original ingress encoding semantics. The shared parameter parser returns 400 for invalid encoding or invalid `pathTails`; ordinary missing files and invalid revisions retain 404. The corresponding resource owner still handles errors in a raw `pathRemainder`.

Shard validation: `node --test-concurrency=1 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/pluginCatalogOperations.test.ts src/manager/pluginCatalogRoutes.test.ts src/manager/webPluginModules.test.ts` passed all 24 tests. A separate `tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --esModuleInterop` check passed for the six shard TypeScript files; it excludes the shared controller.
