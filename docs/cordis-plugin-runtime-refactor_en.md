English | <a href="./cordis-plugin-runtime-refactor.md">简体中文</a>

# Cordis-Based Plugin Runtime Refactor for RabiRoute

> Status: selected design direction. Stage 0, Stage 1, the Contribution Registry contract, and the Stage 2 Generic Webhook, Heartbeat, NapCat, WeCom, and Weixin slices are implemented; the remaining message adapters and full Manager/Gateway migration remain in progress.
>
> Primary audience: RabiRoute maintainers, Manager/Gateway developers, WebGUI/Desktop developers, and plugin authors.

## Design decision

RabiRoute adopts a Cordis composition kernel, a Rabi business adaptation layer, and a multi-host extension protocol:

- Manager and Gateway use Cordis for plugin dependencies, Fiber lifecycle, and effect disposal.
- RabiRoute supplies its own service keys, events, manifests, configuration, and status catalog so business code does not depend directly on Cordis APIs.
- WebGUI and Desktop retain minimal hosts, while pages, status cards, commands, menus, settings, themes, and other product capabilities can be contributed by plugins.
- Route configuration, event records, routing decisions, `AgentPacket`, delivery evidence, and Outbox remain owned by stable modules.
- Existing capabilities migrate in this order: Agent Adapters, message-side lifecycle, Gateway composition, Manager catalog, presentation extensions, and configuration reconciliation.

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

Routing, Adapters, settings pages, status pages, tray menus, shortcuts, themes, and device capabilities are composable product features and should become built-in plugins or plugin contributions over time.

Only the minimal loader kernel and operating-system/runtime boundaries remain outside the plugin model.

## Dependency baseline

As of August 21, 2026, the initial validation uses:

- [`cordis@4.0.0-rc.8`](https://github.com/cordiverse/cordis/tree/main/packages/core), MIT and ESM;
- RabiRoute's current Node ESM and TypeScript project;
- a local smoke test confirming that `Context` mounts a plugin and that a disposer registered through `ctx.effect()` runs when the Fiber is disposed.

Cordis 4 is still a prerelease. Before any upgrade or Loader adoption, refresh the current version, changelog, and Loader API, and continue using an exact version and lockfile.

DSH uses pinned, renamed, and locally modified Cordis sources. RabiRoute does not depend on DSH's `@deepseek-ai/cordis` or copy its patches. The initial migration uses upstream `cordis`, with every import contained under `src/runtime/`. Prefer an upstream fix when a defect blocks production; maintain a minimal patch only when necessary.

## Goals and non-goals

### Goals

- Reduce repeated edits to central entrypoints, scan tables, type catalogs, and UI catalogs when adding a plugin.
- Give listeners, ports, timers, file watchers, and child processes one disposal path.
- Let dependencies control activation, waiting, deactivation, and reactivation.
- Give Manager one plugin catalog from which WebGUI and Desktop build their entries.
- Preserve current routing, delivery, and external-send semantics.
- Enable later reconciliation, local reload, out-of-tree plugins, and isolated process plugins.

### Non-goals

- Do not rewrite routing rules in `src/forwarding.ts` during Stage 1.
- Do not let plugins own plans, memories, personas, or Route facts.
- Do not change `adapterConfig.json`, environment variables, or public Manager APIs during Stage 1.
- Do not treat an in-process Cordis Context as a security sandbox.
- Do not load arbitrary third-party code directly into Manager, Gateway, browser, or Desktop processes.
- Do not claim that sent messages, remote writes, or device commands can be reversed.

## Product hosts and plugin scope

| Host | Minimal kernel | Plugin capabilities |
|---|---|---|
| Manager | HTTP boot, instance lock, plugin loading, security, and configuration-persistence entry | API routes, Gateway management, scanning, diagnostics, knowledge, plans, speech, sync, and other features |
| Gateway | Process boot, configuration read, root Context, and exit handling | Message adapters, Agent adapters, context contributors, providers, reply endpoints, and routing extensions |
| WebGUI | Vue application shell, login/connection, extension loading, safe rendering, and error boundaries | Pages, navigation, settings sections, status cards, commands, forms, themes, and resources |
| Desktop | Desktop shell, Manager connection, extension catalog, security boundary, and window lifecycle | Tray menus, hotkeys, commands, settings sections, status cards, selection actions, notifications, and themes |

The base distribution also mounts built-in plugins through a base bundle. Users can replace, disable, or add extensible features, while the boot kernel, security entrypoints, and fact owners remain protected from ordinary plugins.

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

Stage 1 preserves the current one-Route-per-Gateway process model. The Gateway root Context already isolates the Route, so it does not add a redundant Route child Context.

WebGUI is an independent JavaScript runtime and may gain a client Extension Host later. Desktop is currently an independent Python/Qt runtime and is not forced to port Cordis. It implements the same composition semantics through the shared manifest and contribution protocol exposed by Manager.

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
  | { kind: "navigation"; id: string; labelKey: string; target: string }
  | { kind: "settings-section"; id: string; schema: JsonSchema; endpoint: string }
  | { kind: "status-card"; id: string; query: string; renderer: BuiltinRenderer }
  | { kind: "command"; id: string; labelKey: string; action: ManagerAction }
  | { kind: "tray-menu"; id: string; commandId: string }
  | { kind: "hotkey"; id: string; commandId: string; defaultBinding?: string }
  | { kind: "theme"; id: string; resourceRoot: string };
```

WebGUI and Desktop read the same Manager Contribution Catalog and render the entries supported by each platform. When a plugin unloads, its page entries, menus, hotkeys, and status cards disappear automatically.

### Custom presentation code

When declarative contributions are insufficient, later stages support `web-extension` or `desktop-extension` packages:

- the package declares entrypoint, version, hash, permissions, and compatibility range;
- trusted extensions require explicit user enablement;
- Web extensions use a controlled bridge to Manager and do not directly read local files or credentials;
- Desktop extensions prefer a separate process or controlled script runtime;
- the plugin API exposes only declared capabilities;
- a load failure preserves the host shell and other extensions;
- third-party extensions cannot replace login, security, update, or recovery entrypoints.

Ordinary DSH profile plugins enter the main process through Node ESM. Its `isolate` is a service realm, and the `node:vm` used for model-written Host plugins is explicitly not containment. The separate-process policy here is RabiRoute security hardening for unknown or high-risk code. See [How DSH Uses Cordis: Runtime, UI, and Isolation Analysis](dsh-cordis-runtime-analysis_en.md) for the evidence.

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

A plugin does not implement a separate `stop()`. Every resource registers a disposer during activation, and Fiber disposal owns teardown. External-process termination and protocol closure are also effects.

## Services, events, and contributions

- Services perform operations requiring explicit results, such as appending events, routing, Agent delivery, and Outbox submission.
- Events report facts that already happened, such as configuration commit, Gateway changes, delivery completion, and Fiber state changes.
- Contributions describe entries that a host adds, such as pages, menus, settings sections, status cards, and themes.

Every event declares one mode: observation, awaited parallel fan-out, serial decision, or short-circuit policy. Cordis does not introduce fixed-interval business polling.

## External effects

Fiber disposal can withdraw service registrations, listeners, ports, timers, watchers, child processes, and plugin-exclusive temporary resources.

It cannot withdraw sent messages, committed remote writes, executed device commands, or data already consumed by another system. These operations continue through Outbox, idempotency reservations, delivery receipts, and business compensation.

Before deactivation, a plugin stops accepting new work and waits for current deliveries to reach explicit terminal states. A disposer cleans local lifecycle resources only.

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

Generic Webhook, Heartbeat, NapCat, WeCom, and Weixin now register through `MessageAdapterDefinition`, manifests, and `MessageAdapterRegistry`. The Webhook Fiber owns its HTTP listener, the Heartbeat Fiber owns every timer, the NapCat Fiber owns all multi-instance OneBot WebSocket listeners and connected clients, the WeCom Fiber owns its inbound SDK client, and the Weixin Fiber owns one cancellation signal for QR requests, long polling, waits, and inbound media downloads. Disposal releases or aborts the corresponding resources, rejects stale results before they update state or deliver messages, and records `disabled`; partial activation rolls back created resources and records `error`. `src/index.ts` mounts registered message adapters first, while Feishu and the remaining adapters keep the compatibility creation entry.

Tests cover Webhook port lifecycle, Heartbeat timer lifecycle, NapCat multi-instance resource cleanup, the WeCom SDK client lifecycle, and Weixin long-poll cancellation, stale-result rejection, and repeated mounting. A real `dist/index.js` process verified Webhook `ready -> SIGINT -> disabled` and port release, and also verified Weixin `not_requested -> Ctrl+C -> disabled`. Stage 2 continues with Feishu and the remaining message adapters.

### Stage 3: Gateway Host

`src/index.ts` only reads configuration, creates Context, mounts the base bundle, waits while running, and disposes the root Fiber. It no longer imports and selects every Adapter directly.

Exit criterion: current Gateway behavior and records remain unchanged.

### Stage 4: Manager Plugin/Contribution Catalog

Manager combines manifests, instance state, missing dependencies, install requirements, diagnostic actions, and WebGUI/Desktop contributions. Existing scan APIs remain compatible first.

Exit criterion: backend, WebGUI, and Desktop no longer maintain separate Adapter and extension catalogs.

### Stage 5: declarative WebGUI and Desktop extensions

WebGUI supports navigation, page templates, settings sections, status cards, commands, and themes. Desktop supports tray menus, hotkeys, commands, settings sections, status cards, and themes.

Exit criterion: installing a backend plugin makes its declared entries appear on supported hosts and unloading it removes them.

### Stage 6: reconciliation and local reload

Add stable instance IDs and Loader. The first version supports configuration-driven enable, disable, and recreation without source-code HMR.

Exit criterion: failed configuration restores the old instance without duplicate listeners or sends.

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
- unmigrated message adapters keep the old startup path;
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

All seven items are now implemented: exact dependency, Cordis wrapper, Agent Adapter Registry, all five built-in adapters, the compatibility creation entry, unified scan metadata, a declarative Contribution Registry contract, and Fiber lifecycle tests. The Contribution Registry currently exists only as a runtime contract with tests; Manager does not publish it yet, and WebGUI/Desktop do not render from it yet.

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

## Readiness criteria

- Cordis version and provenance are recorded;
- Rabi service, event, contribution, and plugin contracts are reviewed;
- core fact ownership remains unchanged;
- WebGUI and Desktop extension points are included in the long-term design;
- Stage 1 compatibility entries and acceptance matrix are fixed;
- unrelated working-tree changes remain untouched.
