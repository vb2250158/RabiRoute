English | <a href="./cordis-plugin-runtime-refactor.md">简体中文</a>

# Cordis-Based Plugin Runtime Refactor for RabiRoute

> Status: migration of all 26 built-in Manager plugins is complete. Plugins register business HTTP routes, and WebGUI/Desktop consume declarative contributions as minimal extension hosts. Unified validation passed on August 21, 2026; a controlled Extension Host for arbitrary third-party presentation code remains a future route.
>
> Primary audience: RabiRoute maintainers, Manager/Gateway developers, WebGUI/Desktop developers, and plugin authors.

## Design decision

RabiRoute adopts a Cordis composition kernel, a Rabi business adaptation layer, and a multi-host extension protocol:

- Manager and Gateway use Cordis for plugin dependencies, Fiber lifecycle, and effect disposal.
- RabiRoute supplies its own service keys, events, manifests, configuration, and status catalog so business code does not depend directly on Cordis APIs.
- WebGUI and Desktop are minimal hosts. Plugins contribute pages, settings sections, commands, navigation, status cards, lifecycle entries, menus, hotkeys, and themes. Hosts own connectivity, catalog loading, safe rendering, page/window shells, and fixed recovery entries; they do not load arbitrary presentation code supplied by the catalog.
- Route configuration, event records, routing decisions, `AgentPacket`, delivery evidence, and Outbox remain owned by stable modules.
- Built-in capabilities completed migration in this order: Agent Adapters, message-side lifecycle, Gateway composition, Manager catalog, presentation extensions, and configuration reconciliation.

The design follows [Plugin Architecture Lessons for RabiRoute from DSH](dsh-plugin-architecture-lessons_en.md).

## What “everything is a plugin” means

“Everything is a plugin” does not mean that no host exists. A minimal kernel must boot, verify, load, unload, authorize, and recover plugins.

The RabiRoute minimal host only:

1. starts the process or application;
2. validates manifest, version, provenance, and permission data;
3. creates the plugin runtime context;
4. provides lifecycle and capability access;
5. loads the base composition bundle;
6. isolates, restores, and reports plugin failures.

Routing, Adapters, settings pages, status pages, tray menus, shortcuts, themes, and device capabilities are composable product features; every extensible entry is provided through a built-in plugin or controlled plugin contribution point.

Only the minimal loader kernel and operating-system/runtime boundaries remain outside the plugin model. Desktop and WebGUI do not own a second extension truth; as hosts, they render entries declared by the plugin contribution catalog and supported by the current platform.

## Dependency baseline

As of August 21, 2026, the initial validation uses:

- [`cordis@4.0.0-rc.8`](https://github.com/cordiverse/cordis/tree/main/packages/core), MIT and ESM;
- RabiRoute's current Node ESM and TypeScript project;
- a local smoke test confirming that `Context` mounts a plugin and that a disposer registered through `ctx.effect()` runs when the Fiber is disposed.

Cordis 4 is still a prerelease. Before any upgrade or Loader adoption, refresh the current version, changelog, and Loader API, and continue using an exact version and lockfile.

DSH uses pinned, renamed, and locally modified Cordis sources. Its Loader imports ordinary plugins into the same Node process and mounts them as Fibers; Cordis `isolate` changes service lookup scope only. Subprocesses and Workers are created explicitly by dedicated capabilities such as subprocess and workflow providers, not by every plugin. RabiRoute does not depend on DSH's `@deepseek-ai/cordis` or copy its patches. Prefer an upstream fix when a defect blocks production; maintain a minimal patch only when necessary.

## Goals and non-goals

### Goals

- Reduce repeated edits to central entrypoints, scan tables, type catalogs, and UI catalogs when adding a plugin.
- Give listeners, ports, timers, file watchers, and child processes one disposal path.
- Let dependencies control activation, waiting, deactivation, and reactivation.
- Give Manager one plugin catalog from which WebGUI and Desktop build their entries.
- Preserve current routing, delivery, and external-send semantics.
- Configuration reconciliation, local reload, and the separate-process contract are implemented. Out-of-tree plugins and a controlled Extension Host for arbitrary third-party presentation code remain future routes.

### Non-goals

- Do not rewrite routing rules in `src/forwarding.ts` during Stage 1.
- Do not let plugins own plans, memories, personas, or Route facts.
- Do not change `adapterConfig.json`, environment variables, or public Manager APIs during Stage 1.
- Do not treat an in-process Cordis Context as a security sandbox.
- Do not load arbitrary third-party code directly into Manager, Gateway, browser, or Desktop processes.
- Do not claim that sent messages, remote writes, or device commands can be reversed.

## Product hosts and plugin scope

| Host | Minimal kernel | Plugin contributions |
|---|---|---|
| Manager | HTTP server, LAN authentication, read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, JSON 404 for control paths, WebGUI HTML fallback for other paths, and process shutdown | Business APIs, Gateway control, scanning, diagnostics, knowledge, plans, speech, synchronization, and lifecycle entries |
| Gateway | Process boot, configuration read, root Context, and exit handling | Message adapters, Agent adapters, context contributions, providers, reply endpoints, and routing extensions |
| WebGUI | Vue shell, Manager connectivity, catalog loading, safe rendering, and recovery page | Pages, navigation, settings sections, status cards, commands, forms, themes, and resources |
| Desktop | Qt shell, Manager connectivity, catalog loading, host-owned trusted handler/resource registry, window lifecycle, and recovery entries | Tray menus, hotkeys, commands, settings sections, status, selection actions, notifications, and themes |

Desktop and WebGUI are not fixed business entrypoints. The presentation Contribution Catalog publishes only `page`, `navigation`, `settings-section`, `status-card`, `command`, `tray-menu`, `hotkey`, and `theme`; Manager plugin `apply` hooks register HTTP routes in `ManagerPluginRouteRegistry`. Host-owned trusted registries can register new renderer, route, handler, and resource contracts. Unknown or unregistered contributions fail closed.

All 26 current Manager instances have hooks. Seven declare presentation contributions; nineteen provide runtime capabilities only. `src/manager/builtinManagerPlugins.ts` is the source of instance identity, and `src/manager/controlPlaneRoutes.ts` is the current lifecycle composition root.

The base distribution also mounts extensible capabilities as built-in plugins. The boot kernel, security boundary, and business-fact owners remain stable and cannot be replaced by ordinary plugins.

## Process and runtime model

Manager and every Gateway child process create separate Cordis root `Context` instances. A Context is never shared across processes.

```text
Desktop / WebGUI
       │
       ▼
Manager Process
└─ Manager Cordis Context
   ├─ Manager Core Bundle
   ├─ Plugin Catalog
   ├─ Gateway Runtime Registry
   ├─ UI Contribution Registry
   └─ Manager Plugins
       │
       ├─ Gateway A Process
       │  └─ Gateway Cordis Context
       └─ Gateway B Process
          └─ Gateway Cordis Context
```

Stage 1 preserves the current one-Route-per-Gateway process model. Each resident Gateway creates one root Context and mounts the Agent Adapter Registry, Message Adapter Registry, and Contribution Registry under that same root instead of creating separate Hosts for the three registries.

WebGUI is an independent JavaScript runtime and Desktop is an independent Python/Qt runtime; neither is required to port Cordis. Manager publishes the shared Plugin/Contribution Catalog through `GET /api/plugins/catalog`, with `host=web|desktop` filtering. WebGUI and Desktop resolve pages, commands, hotkeys, themes, status cards, and settings sections through host-owned trusted registries. Built-ins and explicitly installed trusted extensions use the same registration entry points; unregistered contracts fail closed.

## Rabi adaptation layer

Business modules do not receive Cordis `Context` directly. All Cordis imports remain under:

```text
src/runtime/
├─ cordisHost.ts
├─ pluginContext.ts
├─ pluginManifest.ts
├─ pluginCatalog.ts
├─ pluginState.ts
├─ serviceKeys.ts
├─ eventKeys.ts
├─ contributionRegistry.ts
├─ coreServices.ts
└─ builtin/
   ├─ agentAdapters/
   ├─ messageAdapters/
   ├─ endpoints/
   ├─ contextContributors/
   └─ uiContributors/
```

### Service keys

```ts
export type RabiServiceKey<T> = {
  readonly id: string;
  readonly apiVersion: number;
  readonly _type?: T;
};

export const RABI_SERVICES = {
  eventStore: serviceKey<RabiEventStore>("rabi.event-store", 1),
  forwarding: serviceKey<RabiForwarding>("rabi.forwarding", 1),
  agentAdapters: serviceKey<AgentAdapterRegistry>("rabi.agent-adapters", 1),
  outbox: serviceKey<RabiOutbox>("rabi.outbox", 1),
  contributions: serviceKey<ContributionRegistry>("rabi.contributions", 1),
  diagnostics: serviceKey<RabiDiagnostics>("rabi.diagnostics", 1)
};
```

Business API versions belong to Rabi contracts and do not follow the Cordis package version.

### Plugin manifest

```ts
export type RabiPluginManifest = {
  id: string;
  apiVersion: 1;
  displayName: string;
  kind:
    | "manager-feature"
    | "message-adapter"
    | "agent-adapter"
    | "endpoint"
    | "context-contributor"
    | "provider"
    | "web-extension"
    | "desktop-extension";
  scope: "manager" | "gateway" | "route" | "web" | "desktop";
  maturity: "verified" | "experimental" | "placeholder";
  provides: string[];
  requires: string[];
  optional?: string[];
  trust: "builtin" | "trusted" | "process" | "sandbox";
};
```

The manifest describes identity and contracts, not runtime state.

### Plugin context

```ts
export interface RabiPluginContext {
  readonly manifest: RabiPluginManifest;
  provide<T>(key: RabiServiceKey<T>, service: T): Dispose;
  require<T>(key: RabiServiceKey<T>): T;
  optional<T>(key: RabiServiceKey<T>): T | undefined;
  on<T>(event: RabiEventKey<T>, listener: RabiEventListener<T>): Dispose;
  contribute<T>(slot: RabiContributionSlot<T>, value: T): Dispose;
  effect(setup: () => Dispose | Promise<Dispose>): Promise<Dispose>;
  report(patch: RabiPluginStatusPatch): void;
}
```

`provide`, `on`, `contribute`, and project helpers all attach to the current Fiber's effect scope.

## Presentation extension model

### Declarative contributions

The first version accepts controlled declarative contributions without executing third-party frontend code:

```ts
type RabiUiContribution =
  | { kind: "navigation"; routeId: string }
  | {
      kind: "settings-section";
      rendererId: string;
      schemaId: string;
      readCommandId: string;
      writeCommandId: string;
    }
  | { kind: "status-card"; queryId: string; rendererId: string }
  | { kind: "command"; handlerId: string; dangerLevel: "safe" | "confirm" | "dangerous" }
  | { kind: "tray-menu"; commandId: string }
  | { kind: "hotkey"; commandId: string; defaultBinding?: string }
  | { kind: "theme"; themeId: string; webResourceId?: string; desktopResourceId?: string };
```

Schema v2 publishes host-controlled IDs rather than arbitrary `target`, `endpoint`, `query`, `body`, or `resourceRoot` values. Both plugin manifests and contributions are rebuilt from explicit field allowlists before entering the public catalog. A `tray-menu` or `hotkey` must reference a `command` from the same plugin instance and registration batch.

Manager publishes one Plugin/Contribution Catalog through `GET /api/plugins/catalog` and can filter contributions for `web` or `desktop`. WebGUI uses fixed `routeId`, icon, and slot mappings for its sidebar, User Guide, and persona-sync entry. Desktop reads the catalog in the background, resolves tray items through `pluginId + instanceId + commandId`, and executes only host-supported `handlerId` values. Both hosts retain fixed recovery entries when the catalog is unavailable.

### Custom presentation code

When declarative contributions are insufficient, later stages support `web-extension` or `desktop-extension` packages:

- the package declares entrypoint, version, hash, permissions, and compatibility range;
- trusted extensions require explicit user enablement;
- Web extensions use a controlled bridge to Manager and do not directly read local files or credentials;
- Desktop extensions prefer a separate process or controlled script runtime;
- the plugin API exposes only declared capabilities;
- a load failure preserves the host shell and other extensions;
- third-party extensions cannot replace login, security, update, or recovery entrypoints.

Ordinary DSH profile plugins run in the main process through Node ESM. Cordis `isolate` separates service scope rather than processes, and the `node:vm` used for model-written Host plugins is not a security sandbox. RabiRoute requires unknown or high-risk third-party extensions to run in a separate process. See [How DSH Uses Cordis: Runtime, UI, and Isolation Analysis](dsh-cordis-runtime-analysis_en.md) for the evidence.

This preserves extensibility for all product capabilities without injecting arbitrary code into critical hosts during the first stage.

## Core fact ownership

| Fact | Owner | Plugin access |
|---|---|---|
| Route configuration | Current configuration model and Repository | Query or submit controlled commands |
| Messages and event records | Event Store / history | Append through a service |
| Routing decisions | `forwarding.ts` and `routing/*` | Call a stable service or contribute controlled policy |
| Agent delivery | Agent Delivery Registry | Register a provider |
| Outbox and replies | RabiRoute Outbox | Only external-send entry |
| Plugin instance state | Cordis Fiber + Plugin Catalog | Manager projects and queries it |
| Page, menu, and command catalog | Contribution Registry | Plugins contribute; presentation hosts render |

Cordis Context stores only rebuildable runtime-composition state. Persistent facts stay in the current configuration, JSONL, database, or dedicated storage owner.

## Lifecycle

```text
discovered
   ├─ missing dependency ─► waiting_dependency
   └─ ready ──────────────► activating
                              ├─ success ─► active
                              └─ failure ─► failed
active ── config/provider change ─► deactivating
 deactivating ── disposed ────────► inactive / activating
```

The catalog reports at least instance ID, plugin ID, host, scope, state, missing capabilities, start/stop times, and a safe error summary.

Cordis runs multiple disposers in the same Fiber concurrently through `Promise.all(...)`. Several `ctx.effect()` calls may describe independent cleanup, but they cannot encode teardown phases that depend on one another. Every RabiRoute plugin performs this sequence in one disposer:

```text
unregister routes
→ stop accepting new requests
→ drain accepted requests
→ stop plugin-owned workers/processes/timers/sockets/services
→ await resource exit
```

`ManagerPluginRequestTracker` waits for both HTTP responses and actual business Promises registered through `trackOperation()`. An early client disconnect therefore cannot let plugin disposal overtake an accepted send, task, configuration write, or scan. Remote Agent disposal aborts callback signals and waits for callbacks to finish, FenneNote waits for forwarding tasks, and NapCat records instance PIDs once after launch and again after the readiness check. Dynamic batch reconciliation first deactivates the whole changed batch in reverse current activation order, then activates definitions in desired order; activation failure removes the new batch and restores the previous batch. Current hooks for all 26 Manager plugins use one critical disposer. Unified validation passed on August 21, 2026.

## Unified validation

The following checks passed on August 21, 2026:

- `git diff --check`
- `npx tsc -p tsconfig.json --noEmit`
- `npm run build:backend`
- `npm test`: 1,339 source tests with 1,338 passed and 1 skipped; all 55 script tests passed
- `npm run webgui:build`
- `npm run check:config`
- `.\.venv-tray\Scripts\python.exe -m unittest discover -s desktop\tray-task-window\tests -p test_*.py`: all 197 tests passed

## Services, events, and contributions

- Services perform operations requiring explicit results, such as appending events, routing, Agent delivery, and Outbox submission.
- Events report facts that already happened, such as configuration commit, Gateway changes, delivery completion, and Fiber state changes.
- Contributions describe entries that a host adds, such as pages, menus, settings sections, status cards, and themes.

Every event declares one mode: observation, awaited parallel fan-out, serial decision, or short-circuit policy. Cordis does not introduce fixed-interval business polling.

## External effects

Fiber disposal can withdraw service registrations, listeners, ports, timers, watchers, child processes, and plugin-exclusive temporary resources.

It cannot withdraw sent messages, committed remote writes, executed device commands, or data already consumed by another system. These operations continue through Outbox, idempotency reservations, delivery receipts, and business compensation.

Before deactivation, a plugin stops accepting new work and waits for current delivery to reach an explicit terminal state. `/manager` and every `/manager/*` path always remain control paths; unknown or misspelled paths return Manager JSON 404 instead of WebGUI HTML fallback. The disposer only cleans up local lifecycle resources.

## Configuration model

Stage 1 keeps the current `adapterConfig.json` and environment variables. The current model produces the built-in plugin composition.

```text
adapterConfig.json
      ▼
existing normalize / validate
      ▼
Rabi base bundle + selected built-in plugins
      ▼
Cordis Context
```

Later explicit plugin configuration uses stable instance IDs:

```yaml
plugins:
  - id: agent-codex
    plugin: builtin:agent-adapter/codex
    enabled: true
    config: {}

  - id: custom-status-page
    plugin: package:example/rabi-status-extension
    enabled: true
    config: {}
```

`id` is the instance identity; `plugin` is the implementation identity. Display name, array position, and file path do not replace the instance ID.

## Check before continuing the refactor

After every context compaction, and before starting a new implementation slice, reread this minimum evidence set:

DSH:

- `deepseek-harness/AGENTS.md`
- `deepseek-harness/docs/architecture.md`
- `deepseek-harness/packages/boot/app-boot/src/index.ts`
- `deepseek-harness/packages/core/scope/README.zh.md`

RabiRoute:

- `docs/dsh-plugin-architecture-lessons.md`
- `docs/cordis-plugin-runtime-refactor.md`
- `docs/code-architecture.md`
- `docs/project-function-map.md`

Confirm these four conditions before changing code:

1. Every listener, timer, port, process, and registration owned by a new plugin can be revoked with that instance.
2. Route definitions, message records, route decisions, `AgentPacket`, Outbox, plan feedback, and message-processing records still have one business owner each.
3. Cordis scope or isolate is not described or used as process, filesystem, network, or permission isolation.
4. New capabilities cooperate through public services, events, commands, or query APIs instead of mutating another module's internal state.

## Migration stages

### Stage 0: Cordis boundary validation

Add `src/runtime/` and real composition tests without connecting production startup. Verify the exact version, effect disposal, dependency waiting, provider replacement, and root Fiber exit.

Current state: complete. Cordis compatibility, Context creation, plugin mounting, and root Fiber disposal are contained in `src/runtime/`; lifecycle tests cover both individual Fiber and root Context disposal.

Exit criterion: Cordis APIs appear only under `src/runtime/` and its tests.

### Stage 1: Agent Adapter registry

Combine Adapter creation, `deliver()`, capabilities, Manager scanning, display name, maturity, and diagnostic actions. Keep `createAgentAdapter(type)` as a compatibility entry. Do not change routing decisions or templates in `forwarding.ts`.

`codex`, `dsh`, `copilotCli`, `marvis`, and `astrbot` now use one Cordis registry. `createAgentAdapter(type)` is retained as a compatibility entry, while message rendering and real delivery functions keep their existing paths. Type parsing, Gateway configuration enums, Manager scan metadata, and Quick Setup input now read the same manifest; the Contribution Registry contract is also in place.

Exit criterion: adding a built-in Agent Adapter adds one plugin and manifest.

### Stage 2: complete message-side lifecycle

Generic Webhook, FenneNote, XiaoAI, RabiLink, Heartbeat, NapCat, WeCom, Weixin, and Feishu now register through `MessageAdapterDefinition`, manifests, and `MessageAdapterRegistry`. FenneNote and XiaoAI reuse the generic Webhook listener lifecycle while retaining their own ports, paths, event types, message records, and Route sources. The RabiLink Fiber owns both its HTTP listener and a Relay-worker lease; releasing the last lease cancels SSE, task claims, attachment downloads, completion acknowledgements, and reconnect waits. Wearable no longer creates a Gateway Adapter or starts the shared Relay worker; Manager API remains the health-data entry. The Webhook Fiber owns its HTTP listener, the Heartbeat Fiber owns every timer, the NapCat Fiber owns all multi-instance OneBot WebSocket listeners and connected clients, the WeCom Fiber owns its inbound SDK client, the Weixin Fiber owns one cancellation signal for QR requests, long polling, waits, and inbound media downloads, and the Feishu Fiber owns its dedicated event-callback listener and active connections. Disposal releases or aborts the corresponding resources, rejects stale results before they update state, append messages, or deliver work, and records `disabled`; partial activation rolls back created resources and records `error`. `src/index.ts` mounts only message endpoints registered as Gateway plugins. `speech`, `rolePanel`, `wearable`, and `remoteAgent` remain Manager/Desktop-owned business entries and no longer create placeholder adapters or empty Gateway child processes.

Tests cover Webhook and Feishu port lifecycle, Heartbeat timer lifecycle, NapCat multi-instance resource cleanup, the WeCom SDK client lifecycle, and Weixin long-poll cancellation, stale-result rejection, and repeated mounting. Feishu also covers listener readiness, port conflicts, incomplete-request disposal, missing configuration, and same-port remounting. A real `dist/index.js` process verified Webhook `ready -> SIGINT -> disabled` with port release, Weixin `not_requested -> Ctrl+C -> disabled`, Feishu `listening -> Ctrl+C -> disabled` with port release, and simultaneous FenneNote/XiaoAI mounting from `running -> Ctrl+C -> disabled` with both ports released. Targeted RabiLink tests cover listener port lifecycle, port conflicts, disabled Relay, shared leases, last-release cancellation, reconnect shutdown, stale-event rejection, and worker reacquisition. A real `dist/index.js` process verified `ready -> Ctrl+C -> disabled`, `relayWorker=disabled`, and port release. Stage 2 has completed the message-endpoint host type split. The next step is one Gateway root Context that composes the Agent, Message, and Contribution registries through the same entry.

### Stage 3: Gateway Host

`src/index.ts` only reads configuration, creates Context, mounts the base bundle, waits while running, and disposes the root Fiber. It no longer imports and selects every Adapter directly.

Exit criterion: current Gateway behavior and records remain unchanged.

### Stage 4: Manager Plugin/Contribution Catalog

Current status: implemented. `src/runtime/managerPluginRuntime.ts` provides Plugin Catalog and Contribution Registry services under the Manager root Context. It records plugin manifests, hosts, scopes, lifecycle state, missing capabilities, and sanitized failures, and removes contributions with the owning Fiber. `src/manager/builtinManagerPlugins.ts` declares current WebGUI navigation, settings sections, status cards, and the Desktop settings entry as built-in plugin contributions. `GET /api/plugins/catalog` returns one snapshot; `host=web|desktop` filters presentation contributions only, while the plugin-instance list remains complete. Failed or unmounted instances can reactivate under the same instance ID. Manager startup uses one rollback path, so listener failure or later initialization failure stops started resources, closes HTTP/SSE, removes signal handlers, and disposes the Manager root. Existing scan APIs remain compatible.

Exit criterion: Manager publishes plugins and contributions through one API. This is complete; removing fixed presentation-host catalogs belongs to Stage 5.

### Stage 5: declarative WebGUI and Desktop extensions

Current status: the presentation Contribution Catalog publishes eight declarative contribution kinds. WebGUI and Desktop resolve new renderer, route, handler, and resource contracts through host-owned trusted registries. Unknown, unregistered, cross-plugin, or unsupported contributions fail closed. Recovery entries remain available when the catalog is unavailable. A controlled Extension Host for arbitrary third-party presentation code remains future work.

Current-slice exit criterion: the catalog can show or hide host-owned entries, fixed recovery remains available, and a Manager restart cannot preserve an obsolete catalog indefinitely. Third-party page components, theme resources, and command handlers belong to Stage 7.

### Stage 6: reconciliation and local reload

Current status: configuration-driven enable, disable, revision recreation, and failed-update rollback are implemented without source-code HMR. All 26 built-in Manager instances share one catalog and reconciler. Seven declare presentation contributions; nineteen provide runtime capabilities only.

Every definition has a matching hook. Plugin `apply` hooks register business HTTP routes in `ManagerPluginRouteRegistry`. The central HTTP chain is limited to LAN authentication, the read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, JSON 404 for control paths, and WebGUI HTML fallback for all other paths. Desktop lifecycle/settings, diagnostics, Gateway management, scanning, Agent control, Remote Agent, NapCat, message processing, plan feedback, and background services follow the state of their owning instances.

Each hook uses one critical disposer for `unregister → stop accepting → drain → stop resources → await exit`. Cordis runs multiple disposers in one Fiber concurrently, so teardown phases with ordering dependencies are not split across several `ctx.effect()` calls.

Remaining work covers a controlled Extension Host for third-party custom presentation code and a clearer permission boundary. Unified validation passed on August 21, 2026.

### Stage 7: out-of-tree code plugins and isolation

After contracts stabilize, support custom Web/Desktop code extensions and isolated-process backend plugins. Unknown packages are never installed automatically, and untrusted code never enters critical host processes.

Exit criterion: plugin crashes, upgrades, or protocol incompatibility do not terminate other Routes or hosts.

## Verification contract

### Lifecycle

- providers and contributions are visible after activation;
- providers, pages, menus, hotkeys, listeners, ports, and timers disappear after disposal;
- partial activation failure leaves no registration;
- repeated lifecycle operations do not increase handles or duplicate entries;
- consumers stop before a provider disappears;
- unrelated provider changes do not restart consumers.

### Business consistency

- the same input produces the same event record, RouteDecision, `AgentPacket`, and delivery target;
- message templates, Desktop IPC, DSH session delivery, and Outbox semantics remain unchanged;
- configuration is desired state and Plugin Catalog is actual state;
- WebGUI and Desktop read facts from one contribution catalog.

### Security

- plugin errors exclude credentials, private messages, and sensitive paths;
- third-party code requires explicit trust and capability grants;
- untrusted code runs in a separate process or stronger isolation;
- external sends continue through idempotency and delivery evidence.

### Performance

Compare Manager/Gateway cold start, first and warm delivery, Context lookup overhead, handle counts, memory, and concurrent Gateway load before and after migration.

## Rollback strategy

Each stage retains compatibility shells:

- `createAgentAdapter()` can switch back to the old factory;
- the legacy `disabled` sentinel remains normalized at the configuration-read boundary and never enters the plugin registry or runtime;
- Cordis Gateway Host uses a controlled feature switch;
- Manager API retains old responses until the catalog becomes authoritative;
- WebGUI/Desktop retain their base recovery UI if the contribution catalog fails.

Rollback changes runtime selection only and never creates duplicate business facts.

## First implementation slice

1. add an exact Cordis version and `src/runtime/` adaptation layer;
2. create the Gateway Agent Adapter Registry Service;
3. register `codex` and `dsh` as built-in plugins;
4. retain `createAgentAdapter()`;
5. make Manager Agent scanning read the same manifest;
6. define the Contribution Registry contract without changing WebGUI/Desktop yet;
7. add real Context composition, disposal, and repeated-mount tests.

All seven items are now implemented: exact dependency, Cordis wrapper, Agent Adapter Registry, all five built-in adapters, the compatibility creation entry, unified scan metadata, a declarative Contribution Registry contract, and Fiber lifecycle tests. Later slices publish the catalog through Manager API and connect the first controlled WebGUI and Desktop entries.

This slice does not change message templates, Desktop IPC, DSH delivery, Route configuration, Outbox, or current UI behavior.

## Second implementation slice: generic Webhook lifecycle

1. define the Message Adapter manifest, Definition, and Registry;
2. make generic Webhook `start()` return an awaitable close action after the listener is ready;
3. let a Cordis Fiber own startup and teardown;
4. mount registered message adapters first while retaining the compatibility creation entry for unmigrated adapters;
5. verify repeated mounting, port conflicts, post-listen initialization failure, process-exit status, and port release.

This slice keeps Webhook payload, recording, Forwarding, and HTTP response contracts unchanged.

## Third implementation slice: Heartbeat timer lifecycle

1. register Heartbeat as a `timer` Message Adapter Definition;
2. let each instance Fiber own every timer created by that instance;
3. clear timers and `nextTickAt` on disposal, and prevent queued stale callbacks from running or scheduling again;
4. clean timers created before an activation failure and record `error`;
5. keep timer counts constant across repeated mount/dispose cycles and record `disabled` after a normal stop.

Route selection, Forwarding, AgentPacket creation, script execution, and delivery evidence after a scheduled trigger remain owned by the existing business modules. Fiber disposal stops future scheduling and does not undo work that already started.

## Fourth implementation slice: NapCat multi-instance WebSocket lifecycle

1. register NapCat as a `websocket` Message Adapter Definition;
2. wait for every enabled instance listener before reporting `running`;
3. close listeners created earlier and record `error` when a later instance fails to start;
4. terminate connected clients, close every listener, release ports, and record `disabled` on Fiber disposal;
5. remount the same port after disposal without accumulating connections or listeners.

QQ message parsing, reply-chain resolution, media persistence, Route decisions, Forwarding, and Outbox remain owned by the existing NapCat business modules.

## Fifth implementation slice: WeCom SDK WebSocket lifecycle

1. register WeCom as a `websocket` Message Adapter Definition;
2. create one inbound SDK client per Fiber mount and call `connect()` once;
3. call `disconnect()` and record `disabled` on disposal, while ignoring late connection, authentication, and message events;
4. disconnect the created client and record `error` when `connect()` fails synchronously;
5. keep the adapter fail-closed and avoid client creation when the Bot ID or secret is missing.

WeCom message parsing, message records, Route decisions, Forwarding, and Outbox remain owned by the existing business modules. The outbound client cache in `src/wecom.ts` still serves Outbox and is not folded into the inbound Fiber.

## Sixth implementation slice: Weixin login and long-poll lifecycle

1. register Weixin as an `http` Message Adapter Definition;
2. create an independent cancellation signal and message-deduplication set for each Fiber mount;
3. pass the same signal to QR creation, QR status polling, message long polling, waits, and inbound image downloads;
4. abort the active request and await loop exit on disposal, so stale results cannot update session state, append messages, or trigger Forwarding;
5. clear QR presentation state and record `disabled` on normal stop, while each remount creates a new long poll.

Personal-Weixin secure sessions, login requests, sync cursors, message parsing, media decryption, Route decisions, Forwarding, and Outbox remain owned by the existing business modules. The Fiber owns only the runtime loop and reversible effects.

## Seventh implementation slice: Feishu HTTP listener lifecycle

1. register Feishu as an `http` Message Adapter Definition;
2. complete `start()` only after the listener is ready, and reject Cordis mounting on a port conflict;
3. invalidate the lifecycle before closing active connections and the listener on Fiber disposal, then record `disabled`;
4. prevent incomplete requests from updating status, appending message records, or triggering Forwarding during disposal;
5. remain `blocked` without creating an HTTP server when app credentials, Verification Token, Encrypt Key, or event-subscription confirmation is missing;
6. write status and Adapter logs to the instance `dataDir`, and message records to `memoryDataDir`.

Feishu signature verification, URL challenge, encrypted-callback decryption, persistent `event_id` deduplication, source `chat_id`, Route decisions, Forwarding, and Outbox remain owned by the existing business modules. The Fiber owns only the event listener and reversible effects.

## Eighth implementation slice: FenneNote and XiaoAI Webhook profiles

1. register FenneNote and XiaoAI as separate `http` Message Adapter Definitions;
2. reuse generic Webhook listener readiness, port-conflict rollback, connection closure, and same-port remounting;
3. remove the FenneNote, XiaoAI, and generic Webhook compatibility creation branches from the Gateway entry;
4. preserve separate manifest labels and existing path and port configuration;
5. preserve FenneNote record-first behavior and the XiaoAI transcript event contract.

## Ninth implementation slice: RabiLink Relay lease lifecycle

1. register RabiLink as an `http` Message Adapter Definition;
2. acquire the Relay-worker lease only after the HTTP listener is ready, so listener startup failure creates no worker;
3. let the first lease start SSE, task claiming, and the reconnect loop while later leases only increase the reference count;
4. cancel SSE, claims, attachment downloads, completion acknowledgements, and reconnect waits when the final lease is released, await the active drain, and remove the worker;
5. always process ordinary tasks with the RabiLink profile so another entry cannot change event type, record source, or Route kind;
6. remove the Wearable Gateway Adapter and its shared-worker startup side effect while Manager API and the existing health-rule modules retain health-data ownership.

RabiLink message parsing, conversation records, health observations, Route decisions, Forwarding, delivery deduplication, and remote completion acknowledgements remain owned by the existing business modules. The Fiber and lease own only the listener, SSE, requests, waits, and disposal order.

## Tenth implementation slice: message-endpoint host type split

1. `MessageEndpointType` represents every message endpoint available to Route configuration, records, rules, scanning, and one-shot delivery;
2. `GatewayMessageAdapterType` contains only the nine resident message adapters mounted by Gateway Fibers;
3. `disabled` remains a legacy configuration-read sentinel and cannot be registered, mounted, or written as a new runtime adapter type;
4. the Gateway entry removes placeholder factories, the compatibility creation factory, and `legacyDisposers`, then composes only definitions from `MessageAdapterRegistry`;
5. Manager starts a child process only when the Route contains Gateway plugins and stops an existing process when the Route becomes Manager/Desktop-only;
6. one-shot `speech`, `rolePanel`, `wearable`, and Remote Agent delivery still reads the complete Route endpoint set and policies.

This split gives message-source facts and resident plugin lifecycles separate contracts. WebGUI uses the same Gateway type predicate and no longer treats Wearable status as waiting for a Gateway process.

## Eleventh implementation slice: single Gateway root Context and command dispatch

1. `src/index.ts` only classifies the invocation and dynamically loads the matching module; it no longer owns both one-shot commands and the resident Gateway lifecycle;
2. the resident Gateway uses one Cordis root Context and mounts the Agent Adapter Registry, Message Adapter Registry, and Contribution Registry under that root;
3. one-shot alert, replay, manual-trigger, role-panel, plan-feedback, speech, and Direct Agent Envelope commands enter their command implementation without starting the Message Adapter Runtime or Contribution Runtime;
4. normal resident shutdown and startup failure both dispose the whole root Context, allowing each Registry Fiber to remove its listeners, timers, and registrations;
5. WebGUI and Desktop are minimal hosts. The current contribution catalog controls only host-pre-registered pages, actions, status, and settings; third-party presentation code waits for stable contracts and isolation boundaries.

`create-gateway-host` is complete.

## Twelfth implementation slice: Manager Plugin Runtime and unified catalog

1. The Manager root Context mounts `PluginCatalog`, `ContributionRegistry`, and all 26 built-in Manager plugins.
2. Each plugin has its own Fiber; activation failure rolls back its contributions and unload removes only its registrations.
3. `GET /api/plugins/catalog` returns instance state and presentation contributions.
4. The presentation catalog contains only eight contribution kinds; plugin `apply` hooks register business HTTP routes.

`create-manager-contribution-catalog` is complete.

## Thirteenth implementation slice: Schema v2 and presentation catalog consumption

1. WebGUI and Desktop use host-owned trusted registries for new renderer, route, handler, and resource contracts.
2. Same-instance, same-batch references must resolve; unknown, unregistered, cross-plugin, and unsupported contributions fail closed.
3. The catalog carries no arbitrary URLs, request bodies, or resource paths.
4. A controlled Extension Host for arbitrary third-party presentation code remains future work.

`extend-webgui-desktop` is complete. Unified validation passed on August 21, 2026.

## Slice 14: configuration reconciliation and local reload

1. `data/manager.json.managerPlugins` accepts only registered built-in instance IDs and a boolean `enabled`; `manager:core` is required.
2. The Manager watcher tracks `manager.json`, Route configuration, and persona configuration.
3. `ManagerPluginReconciler` serializes desired-revision comparisons and starts, stops, or reloads only changed instances.
4. Failed activation restores the previous definition when possible; failed rollback records `rollback_failed`.
5. HTTP routes, services, and background effects for all 26 built-in Manager plugins follow their instance state.
6. `GET /api/plugins/reconciliation` and `POST /api/plugins/reconcile` expose state and a controlled manual reread.
7. WebGUI listens for `plugin_catalog_changed` without adding business polling.

This slice is complete.

## Slice 15: isolated-process plugin contract

1. Isolated processes exchange versioned JSON Lines manifest, handshake, request, response, health, and stop messages.
2. The current grant is limited to `ui.contributions`; contributions still pass existing field, host, and reference validation.
3. Deadlines, protocol errors, unexpected exits, and stderr produce sanitized errors.
4. Windows shutdown uses an injectable process-tree cleaner.
5. `processManagerPlugin.ts` mounts a handshaken process through a normal Manager Plugin Fiber; disposal removes contributions before stopping the process.
6. `manager.json` rejects commands, paths, package names, URLs, and environment variables. Only trusted host composition code can construct a process instance.

This slice is complete.

## Readiness criteria

- Cordis version and provenance are recorded;
- Rabi service, event, contribution, and plugin contracts are reviewed;
- core fact ownership remains unchanged;
- WebGUI and Desktop extension points are included in the long-term design;
- Stage 1 compatibility entries and acceptance matrix are fixed;
- unified validation of the 26 Manager plugins has not been run;
- unrelated working-tree changes remain untouched.
