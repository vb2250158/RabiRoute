English | <a href="./cordis-plugin-runtime-refactor.md">简体中文</a>

# Cordis-Based Plugin Runtime Refactor for RabiRoute

> Status: refactor in progress. The single Gateway root Context, Manager Plugin Runtime, and unified Plugin/Contribution Catalog API are implemented. WebGUI/Desktop catalog consumption, configuration reconciliation, and isolated-process plugins are not complete.
>
> Primary audience: RabiRoute maintainers, Manager/Gateway developers, WebGUI/Desktop developers, and plugin authors.

## Design decision

RabiRoute adopts a Cordis composition kernel, a Rabi business adaptation layer, and a multi-host extension protocol:

- Manager and Gateway use Cordis for plugin dependencies, Fiber lifecycle, and effect disposal.
- RabiRoute supplies its own service keys, events, manifests, configuration, and status catalog so business code does not depend directly on Cordis APIs.
- WebGUI and Desktop are minimal hosts. Pages, status cards, commands, menus, settings, themes, and other extensible entries come from the unified plugin/contribution catalog. Manager publishes the catalog, while both presentation hosts still need to consume it.
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

In the target state, the base distribution also mounts built-in plugins through a base bundle. Users will be able to replace, disable, or add extensible features, while the boot kernel, security entrypoints, and fact owners remain protected from ordinary plugins.

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

WebGUI is an independent JavaScript runtime and Desktop is an independent Python/Qt runtime; neither is required to port Cordis. Manager now publishes the shared Plugin/Contribution Catalog through `GET /api/plugins/catalog`, with `host=web|desktop` filtering. WebGUI and Desktop do not consume that endpoint yet, so their current entries still come from fixed host implementations.

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

Manager now publishes one Plugin/Contribution Catalog through `GET /api/plugins/catalog` and can filter contributions for `web` or `desktop`. WebGUI and Desktop consumption is still pending. Once connected, catalog revisions caused by plugin unload will remove the corresponding page entries, menus, hotkeys, and status cards.

### Custom presentation code

When declarative contributions are insufficient, later stages support `web-extension` or `desktop-extension` packages:

- the package declares entrypoint, version, hash, permissions, and compatibility range;
- trusted extensions require explicit user enablement;
- Web extensions use a controlled bridge to Manager and do not directly read local files or credentials;
- Desktop extensions prefer a separate process or controlled script runtime;
- the plugin API exposes only declared capabilities;
- a load failure preserves the host shell and other extensions;
- third-party extensions cannot replace login, security, update, or recovery entrypoints.

Ordinary DSH profile plugins run in the main process through Node ESM. Cordis `isolate` separates service scope rather than processes, and the `node:vm` used for model-written Host plugins is not a security sandbox. RabiRoute adds an optional separate-process policy for unknown or high-risk plugins. See [How DSH Uses Cordis: Runtime, UI, and Isolation Analysis](dsh-cordis-runtime-analysis_en.md) for the evidence.

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

Generic Webhook, FenneNote, XiaoAI, RabiLink, Heartbeat, NapCat, WeCom, Weixin, and Feishu now register through `MessageAdapterDefinition`, manifests, and `MessageAdapterRegistry`. FenneNote and XiaoAI reuse the generic Webhook listener lifecycle while retaining their own ports, paths, event types, message records, and Route sources. The RabiLink Fiber owns both its HTTP listener and a Relay-worker lease; releasing the last lease cancels SSE, task claims, attachment downloads, completion acknowledgements, and reconnect waits. Wearable no longer creates a Gateway Adapter or starts the shared Relay worker; Manager API remains the health-data entry. The Webhook Fiber owns its HTTP listener, the Heartbeat Fiber owns every timer, the NapCat Fiber owns all multi-instance OneBot WebSocket listeners and connected clients, the WeCom Fiber owns its inbound SDK client, the Weixin Fiber owns one cancellation signal for QR requests, long polling, waits, and inbound media downloads, and the Feishu Fiber owns its dedicated event-callback listener and active connections. Disposal releases or aborts the corresponding resources, rejects stale results before they update state, append messages, or deliver work, and records `disabled`; partial activation rolls back created resources and records `error`. `src/index.ts` mounts only message endpoints registered as Gateway plugins. `speech`, `rolePanel`, `wearable`, and `remoteAgent` remain Manager/Desktop-owned business entries and no longer create placeholder adapters or empty Gateway child processes.

Tests cover Webhook and Feishu port lifecycle, Heartbeat timer lifecycle, NapCat multi-instance resource cleanup, the WeCom SDK client lifecycle, and Weixin long-poll cancellation, stale-result rejection, and repeated mounting. Feishu also covers listener readiness, port conflicts, incomplete-request disposal, missing configuration, and same-port remounting. A real `dist/index.js` process verified Webhook `ready -> SIGINT -> disabled` with port release, Weixin `not_requested -> Ctrl+C -> disabled`, Feishu `listening -> Ctrl+C -> disabled` with port release, and simultaneous FenneNote/XiaoAI mounting from `running -> Ctrl+C -> disabled` with both ports released. Targeted RabiLink tests cover listener port lifecycle, port conflicts, disabled Relay, shared leases, last-release cancellation, reconnect shutdown, stale-event rejection, and worker reacquisition. A real `dist/index.js` process verified `ready -> Ctrl+C -> disabled`, `relayWorker=disabled`, and port release. Stage 2 has completed the message-endpoint host type split. The next step is one Gateway root Context that composes the Agent, Message, and Contribution registries through the same entry.

### Stage 3: Gateway Host

`src/index.ts` only reads configuration, creates Context, mounts the base bundle, waits while running, and disposes the root Fiber. It no longer imports and selects every Adapter directly.

Exit criterion: current Gateway behavior and records remain unchanged.

### Stage 4: Manager Plugin/Contribution Catalog

Current status: implemented. `src/runtime/managerPluginRuntime.ts` provides Plugin Catalog and Contribution Registry services under the Manager root Context. It records plugin manifests, hosts, scopes, lifecycle state, missing capabilities, and sanitized failures, and removes contributions with the owning Fiber. `src/manager/builtinManagerPlugins.ts` declares current WebGUI navigation, settings sections, status cards, and the Desktop settings entry as built-in plugin contributions. `GET /api/plugins/catalog` returns one snapshot; `host=web|desktop` filters presentation contributions only, while the plugin-instance list remains complete. Failed or unmounted instances can reactivate under the same instance ID. Manager startup uses one rollback path, so listener failure or later initialization failure stops started resources, closes HTTP/SSE, removes signal handlers, and disposes the Manager root. Existing scan APIs remain compatible.

Exit criterion: Manager publishes plugins and contributions through one API. This is complete; removing fixed presentation-host catalogs belongs to Stage 5.

### Stage 5: declarative WebGUI and Desktop extensions

Current status: not complete. WebGUI will generate navigation, page templates, settings sections, status cards, commands, and themes from the unified catalog. Desktop will generate tray menus, hotkeys, commands, settings sections, status cards, and themes from the same catalog.

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

All seven items are now implemented: exact dependency, Cordis wrapper, Agent Adapter Registry, all five built-in adapters, the compatibility creation entry, unified scan metadata, a declarative Contribution Registry contract, and Fiber lifecycle tests. A later slice now publishes the Contribution Registry through Manager API; WebGUI/Desktop still do not generate their interfaces from that catalog.

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
5. WebGUI and Desktop are extensible minimal hosts. Extension authors add pages, actions, status, or settings through contribution plugins, so presentation entries remain inside the plugin model.

`create-gateway-host` is complete.

## Twelfth implementation slice: Manager Plugin Runtime and unified catalog

1. extract Gateway root initialization deduplication, failure retry, initialization-aware disposal, and idempotent disposal into the reusable `RabiCordisRoot`, with symmetric but separate Gateway and Manager root APIs;
2. mount `PluginCatalog`, `ContributionRegistry`, and built-in Manager plugins under one Manager root Context during startup;
3. record stable instance IDs, manifests, hosts, scopes, status, missing capabilities, start/stop timestamps, and sanitized failures in Plugin Catalog;
4. give each Manager plugin its own Fiber so activation failure rolls back its contributions, plugin unload removes only its registrations, and root disposal clears the complete Manager catalog;
5. publish plugin and contribution revisions, instance state, and declarative contributions through `GET /api/plugins/catalog`, with `host=web|desktop` filtering;
6. declare the current WebGUI navigation, settings sections, status cards, and Desktop settings entry as built-in Manager plugin contributions, while leaving WebGUI/Desktop catalog consumption for the next slice.

`create-manager-contribution-catalog` is complete. The next stage makes WebGUI and Desktop generate extension entries from the unified catalog.

## Readiness criteria

- Cordis version and provenance are recorded;
- Rabi service, event, contribution, and plugin contracts are reviewed;
- core fact ownership remains unchanged;
- WebGUI and Desktop extension points are included in the long-term design;
- Stage 1 compatibility entries and acceptance matrix are fixed;
- unrelated working-tree changes remain untouched.
