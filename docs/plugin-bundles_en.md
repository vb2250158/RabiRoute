<!-- docs-language-switch -->
<div align="center">
English | <a href="./plugin-bundles.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Plugin Packages, Execution Boundaries, and Hot Replacement

RabiRoute keeps application lifecycle, business state, and the Plugin Kernel in one trunk while features extend as a plugin tree. A plugin is not another Host: it provides capabilities only inside Manager-owned generations, permissions, dependencies, and process leases. Ordinary plugins never control the Windows Host/Manager/tray lifetime.

## One production format

Manifest and Profile accept schema v2 only. No other version has a compatibility parser; unknown or retired fields fail directly so one package cannot acquire two lifecycle meanings on different machines.

Production layout:

```text
plugins/
  profiles/desktop.json
  builtin/<package-id>/<version>/rabi.plugin.json
  builtin/<package-id>/<version>/manager.mjs
  builtin/<package-id>/<version>/web/
```

Out-of-tree plugins use the same package layout, schemas, SDK, and Profile instance contract. Built-in identity grants no extra lifecycle authority.

## Manifest v2

```json
{
  "schemaVersion": 2,
  "id": "io.example.feature",
  "version": "1.0.0",
  "entries": {
    "manager": {
      "execution": "isolated",
      "module": "./manager.mjs"
    },
    "desktop": {
      "execution": "declarative",
      "resource": "./desktop.json"
    }
  },
  "provides": ["example.feature@1"],
  "requires": ["manager.core@1"],
  "optional": [],
  "permissions": ["example.read"]
}
```

`provides`, `requires`, `optional`, and `readyRequires` use `name@major`. Package paths must stay inside their package. Unknown fields, duplicate capabilities, invalid permissions, and capability conflicts fail before execution.

## Three execution modes

| Mode | Use | Isolation and limits |
| --- | --- | --- |
| `in_process` | Reviewed core plugins shipped with Manager that need direct service objects | Runs inside Manager; must use SDK lifecycle/effects and cannot create another application owner |
| `isolated` | Out-of-tree code, larger failure surfaces, or plugins needing a separate process | The loader never imports entry top-level code; a dedicated Plugin Runtime Host uses restricted RPC and structured-clone data; process leases reclaim the child |
| `declarative` | Desktop/Web menus, panels, themes, and resources that need declarations only | Executes no plugin JavaScript; the kernel validates a resource and passes it to the presentation adapter |

Execution mode belongs to an entry, not the whole package. One package may declare different modes for different hosts. A manifest cannot supply arbitrary commands, executable paths, or resources outside its package.

## Asynchronous service transport v2 (experimental candidate; matching build required)

The existing isolated v1 data contract remains available to existing packages. A build containing the asynchronous bridge can read `rabi.async-services.json` from the immutable package verified by the normal PackageCatalog:

```json
{
  "schemaVersion": 1,
  "provides": {
    "example.worker@1": { "kind": "async-methods", "methods": ["run"] }
  }
}
```

This describes provider method semantics, not capability permissions. It may only describe capabilities already provided by the manifest. Original host owners declare host asynchronous semantics through `declareAsyncPluginService(value, methods)`; package metadata cannot silently turn arbitrary synchronous host methods into promises. The normal require/optional, identity and permission contracts remain unchanged, including functionality available to authenticated remote connections.

The entry remains `createFullPluginExecutor`. It selects the protocol before launch using the real candidate-to-PackageCatalog owner association. One activation starts one original-owner child. A v2 failure never launches a fallback v1 child or replays calls with replacement request IDs. Existing v1 packages without asynchronous contracts keep their data, heartbeat and restart behavior. V1 remains for compatibility with independently deployed packages; removal requires equivalent migration and actual acceptance of those packages and their restart/owner semantics.

V2 imports, activation, effects and declared provider methods run in the child. Host implementations still run in Manager. Transport accepts explicit DTOs or declared asynchronous methods and rejects custom classes, accessors, synchronous publication, native HTTP/socket objects, streams and subscription callbacks. It does not establish isolation acceptance for all default 30 plugins, and a promise deadline cannot isolate synchronous host code. V2 currently supports only `restart.mode=never`; `on_failure` needs an owner adapter that can reconcile unknown outcomes without replaying prepare/commit or business actions.

The original ProcessLeaseRegistry owns processes, with an independent actual-close check. Admission, dispatch, execution, native mutationOutcome/uncertain/operationId and response delivery are separate. Real unknowns use the full activation identity plus requestId. A dedicated Manager stateRoot owner asynchronously archives minimal outcome metadata, retaining direct cold lookup after the64-entry hot cache evicts it. Another owner's identical requestId cannot replace original facts. Normal successful/read/probe/startup calls perform no archive fsync; a merely running Promise is not a historical unknown. Unconfirmed archives retain their facts and actual join. Capacity refusal affects only that plugin's not-yet-dispatched potentially effectful call, not other plugins or reads/probes. Existing native operationId/receiptId/deliveryId references remain with their original owner; the bridge does not create another business transaction or replay a request. The executor exposes owner-bound cold lookup; a public HTTP diagnostic route is not connected yet. Synchronous publication, HTTP/stream ownership and default-plugin migration remain unfinished.

Only the original service owner declares read/owned-resource/mutation/unknown method semantics. They govern outcome/resource preservation, not feature authorization. Manager does not execute return/error getters, proxies or custom behavior to extract metadata. Transport failure after dispatch remains unknown and cannot become not_started.

The normal backend build copies exactly three native MJS bridge assets. TS declarations check the caller boundary, not implementation acceptance. Build, lifecycle compatibility and actual caller tests must pass before installation. An old installed build or source files alone do not prove support.

## Profile v2

The Profile is the single source of truth for enabled deployment instances:

```json
{
  "schemaVersion": 2,
  "readyRequires": ["manager.core@1"],
  "instances": [
    {
      "id": "manager:example",
      "package": "io.example.feature",
      "version": "1.0.0",
      "enabled": true,
      "config": {},
      "grants": ["example.read"],
      "policy": {
        "restart": {
          "mode": "on_failure",
          "maxAttempts": 3,
          "windowMs": 60000,
          "initialBackoffMs": 500,
          "maximumBackoffMs": 10000
        },
        "resources": {
          "memoryMb": 256,
          "maxChildProcesses": 2,
          "shutdownTimeoutMs": 5000
        }
      }
    }
  ]
}
```

Installed plugins use host APIs declared by their Manifest without another Profile grant. Legacy `grants` input and the `grantedPermissions` callback no longer control execution and will be removed in 0.4.0. `policy` still bounds restarts and resources. Every `readyRequires` capability must have an active provider before the generation is ready.

On every reconciliation, Manager reports missing `readyRequires` truthfully and publishes the healthy subset whose dependencies are available. Failed plugins and consumers waiting for dependencies retain their own state; missing capabilities do not first roll back core and trigger a whole-group retry. Startup prepares core dependencies first, then publishes other healthy features in the background. The capability list does not gate application startup or unrelated features. `readiness.missingCapabilities` and `health.requiredReady=false` remain truthful. Core owns the stable `manager.meta.read` (`/meta`) operation, so a missing diagnostics plugin does not remove discovery. Its original aliases, schema, diagnostic-read behavior and connection authentication remain unchanged. The generic Plugin Kernel still defaults to strict enforcement for other hosts; publications that have not explicitly selected reporting retain the published generation when required capabilities are missing. If `manager.core` itself cannot activate, there is still no independent HTTP bootstrap entry; that structural boundary remains open.

## Identity and lifecycle

Every activation carries the full identity:

```text
applicationGenerationId
managerInstanceId
activationId
instanceId
pluginId
version
revision
host
```

External requests, process leases, logs, and contributions must trace back to this identity instead of relying on a reusable plugin name or PID.

Plugins register services, contributions, and effects through `activate(context)`. `context.lifecycle.signal` is the cancellation source of truth. Existing `effects.add` commits reversible candidate resources while the old graph remains active; work that must start after publication uses `context.publication`. Synchronous `publish/rollback` commits with the services/contributions graph, `afterPublish` starts work, and `retire` releases the published owner. Exclusive workers await `previousRetirement`. See the [publication lifecycle](plugin-publication-lifecycle_en.md). Replacement or shutdown stops admission and aborts the signal, then begins disposal in reverse dependency order: consumers before providers, with each instance's effects/disposers closed under kernel control.

## Process Lease

A plugin that needs a long-lived child process must create it through the shared Process Lease Registry. Lease ownership includes application generation, Manager instance, activation, plugin instance, and revision. The Registry provides:

- duplicate rejection for the same owner/key;
- the `maxChildProcesses` resource limit;
- rejection of new children after quiesce;
- drain within `shutdownTimeoutMs`, followed by process-tree termination;
- reclamation when the generation, instance, or Manager ends.

Directly spawning and losing ownership is a design contradiction. The Windows Job is a final application-generation cleanup boundary, not a substitute for plugin leases.

## Hot replacement

When a Profile or package revision changes, Plugin Kernel:

1. reads and validates v2 Manifest/Profile;
2. builds the capability graph and rejects missing dependencies or cycles;
3. prepares candidates by execution mode without importing `isolated` top-level code into Manager;
4. validates `readyRequires`, permissions, and contributions;
5. atomically commits the candidate generation so new requests enter only the new graph;
6. drains old requests, then disposes old consumers before providers and reclaims leases.

A failed candidate cannot contaminate the current generation or leave half-active services and processes. Unchanged instances whose dependencies are unchanged may be retained; replacing a provider also replaces affected consumers.

## Author gates

Trusted Manager packages may use the shared SDK, Node built-ins, and package-local `./` modules. Entry checks reject other bare dependencies, cross-package paths and symbolic links. This is not a JavaScript sandbox: execution modes and host capabilities remain the authority boundary. Implementation modules ship with the package and must not import the source checkout.

```powershell
npm test
npm run build
npm run check:config
```

New plugins must also prove: non-v2 schemas are rejected; Manager loader never runs `isolated` top-level code; missing `readyRequires` never reports required capabilities as ready; consumers stop before providers; leases reach zero after reload, failure, and Manager shutdown; Desktop/Web consume declarations without acquiring application-lifecycle authority.

The archive lives under Manager stateRoot `data/.runtime/plugin-runtime/unknown-outcomes`. Publishing metadata requires observing the original file handle's actual close. A failed close keeps the same owner; an explicit metadata flush only reconciles that original resource. Cold reads join loading of the original first observation. If it is unavailable, `OUTCOME_FIRST_UNAVAILABLE` exposes the current observation separately instead of inventing first fields. This does not prove that the original business operation never ran and does not permit replay.

Read calls use an independent, activation-spanning RAM admission pool. They consume no mutation-archive slot and perform no archive fsync. An explicit native unknown contradicting a read declaration retains its original call and admission; a derived index of unarchived facts carries that method knowledge across activations. A settled ordinary read failure becomes disposable diagnostic history after its failure notification is acknowledged. Actual original process close plus settled read execution also releases RAM admission. Unsettled, unacknowledged or genuinely unknown calls are not cleared as ordinary success. Probes do not use this business-call pool.

The new `host.manager.route-control-registration@1` capability is an asynchronous registration contract owned by the parent process; the original native `host.manager.route-control@1` service stays unchanged. The Route control child only prepares a cloneable handle. The original SDK effect commits API registration in the parent scope, and cancellation joins that same registration and actual child close. Existing core/gateway dependencies still determine ordering; unused native dependencies carry an unsupported descriptor and actual reads report `UNSUPPORTED_SERVICE_TRANSPORT`. This does not change connection permissions or claim migration of other default plugins. Normal packaging also bundles the SDK of isolated entries into `.rabi-deps`, without depending on the source tree or a spare Runtime.

When source inspection cannot identify a local release statement in the plugin entry, the build reports a non-blocking diagnostic: resources may belong to a parent through asynchronous registration. This source heuristic does not replace the actual lifecycle contract or resource retirement tests. Explicit schema, invalid-entry and cross-package dependency violations still fail the check. Do not add a fake disposer to satisfy a text pattern.

When explicitly configured, `RABIROUTE_PLUGIN_IN_PROCESS_ROOTS` is a JSON array of directories; `[]` disables only `in_process` plugins. An unset setting adds no directory restriction. A malformed value records the field and editing location and skips this invalid optional setting, keeping each plugin’s declared execution mode. A missing directory produces a diagnostic while other matching configured directories remain enabled. A nonempty array with no matching directory is skipped as an invalid optional restriction; a valid `[]` still disables `in_process` plugins. Diagnostics do not echo the malformed value. This setting does not grant or revoke API access.
