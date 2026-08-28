English | <a href="./dsh-plugin-architecture-lessons.md">简体中文</a>

# Plugin Architecture Lessons for RabiRoute from DSH

> Status: architecture research, migration of all 28 built-in Manager plugins, and unified validation are complete, with configuration reconciliation, controlled presentation contributions, and a separate-process extension contract implemented.
>
> Primary audience: RabiRoute maintainers and developers of message-side and Agent-side integrations.

## Decision

RabiRoute should adopt the runtime-composition principles used by DeepSeek Harness (DSH) and the long-term goal that every product capability is extensible through plugins, without immediately copying the complete DSH implementation.

The four most useful changes are:

1. Register replaceable capabilities behind stable contracts so entrypoints do not know every implementation.
2. Pair every registration, listener, timer, bound port, and child process with a disposal action.
3. Let plugins declare provided and required capabilities, while the host decides when to activate, deactivate, or reactivate them.
4. Treat configuration as desired state. The host reconciles runtime state to it and restores the previous state after a failed change.

These changes can reduce the files touched when adding a platform and prevent stale listeners, duplicate timers, and old registrations after reloads.

## Research snapshot

The implementation baseline is the local [DeepSeek Harness `528c682e06`](https://github.com/deepseek-ai/deepseek-harness/tree/528c682e061696f5a160f363f236ecbf53cbd006), the `dsh@0.1.1-rc.1` commit from August 21, 2026 at 14:21:44 +08:00. At the August 21, 2026 review, remote `master` had advanced to `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`; that newer remote commit is not audited here, and source claims still apply only to local `528c682e06`.

Other sources:
- [A Programming Paradigm for Spatiotemporal Composability, v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf), committed August 13, 2026.
- The [DSH architecture guide](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/architecture.md) and [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/cordis-primer.md).

DSH is still a developer preview. RabiRoute should learn from its design rather than treat the current APIs as a compatibility target.

## How DSH composes plugins

### 1. The shared context exposes capabilities

Cordis represents the runtime as a shared context. Plugins provide services, and consumers declare dependencies on stable capability keys instead of importing a concrete implementation.

DSH mounts model adapters, tool registries, session logs, the Agent loop, persistence, and user interfaces through the same composition mechanism. The host owns composition; each plugin owns its capability.

### 2. Dependencies control lifecycle

A plugin declares required services through `inject`. It remains inactive while dependencies are missing, activates when they appear, and stops or resolves again when a provider is replaced or removed.

Startup order therefore follows capability relationships instead of a manually maintained sequence in an entrypoint.

Service instances are also constrained by realm and Fiber ownership: one realm can contain only one provider, and only the Fiber that registered a service may change its value. DSH Agent presets reject preset services that leak into the root realm. RabiRoute should likewise keep plugin-scoped services in their own realm and reserve host-global services for explicit host composition.

### 3. Effects are disposable

Cordis treats registration as an effect with an inverse. Event listeners, services, tools, prompt sections, and providers belong to the Fiber of the plugin that installed them.

Top-level effect disposers on a Fiber are taken in reverse registration order and then started and awaited through `Promise.all(...)`, so asynchronous cleanup can overlap. Multiple disposers returned inside one `ctx.effect()` are also taken in reverse order, but run serially through a Promise chain. A plugin that needs business ordering keeps `unregister → stop accepting → drain → stop resources → await exit` inside one critical effect/disposer.

The paper calls reversible internal change temporal composability: when a component leaves, the system should remove the internal changes owned by that component.

### 4. Configuration describes desired state

DSH combines profiles, bundles, and patches into a plugin tree. Each entry has a stable ID, module entry, configuration, isolation data, and enabled state. The Loader compares this specification with live instances and replaces only affected parts.

Configuration changes use Loader Entry transactions: an Entry update disposes the old Fiber, starts the new Fiber, and restores the old plugin on failure. Source HMR is a separate path that backs up and restores ESM/CJS caches. The two paths share only Fiber disposal and remount semantics; they are not one update mechanism.

### 5. Agent presets use one standing mount per preset

Each preset `cordis.yml` is mounted once in the process. Multiple Agents naming the same preset share that standing mount through the scope parent chain, so plugin instances, tool registrations, prompt sections, and projection units exist once; plugins isolate state by Session/Agent key. A preset file change creates a new generation. DSH still has a TODO to reclaim a superseded generation after its last Agent leaves.

### 6. A plugin boundary is not a security sandbox

Ordinary DSH profile plugins enter the main process through Node ESM and are trusted code. Cordis `isolate` changes service-instance resolution realms; it does not restrict process, filesystem, or network access.

DSH evaluates model-written dynamic Host plugins in an in-process `node:vm` with a restricted Context facade, but the source explicitly says this constrains cooperative code and is not containment. Dynamic browser plugins also execute in the current page. The DSH operating-system sandbox protects tool subprocesses such as Bash and PowerShell; it does not automatically wrap ordinary Cordis plugins.

RabiRoute's separate-process rule for unknown or high-risk plugins is additional security hardening over the DSH composition model. See [How DSH Uses Cordis: Runtime, UI, and Isolation Analysis](dsh-cordis-runtime-analysis_en.md) for the evidence.

### 7. External emissions cannot be undone by unload

Listeners, ports, timers, and local registrations are usually reversible. A QQ message, remote API write, or device command has already left the process and cannot be recalled by unloading a plugin.

The paper places these emissions outside the recoverable system boundary and requires delayed commitment or business compensation. RabiRoute's existing Outbox, sending rules, idempotency keys, and delivery records should continue to own these effects.

## RabiRoute's current base

The current implementation has these boundaries:

- Manager and Gateway use independent Cordis root Contexts.
- Gateway performance sampling and reporting have moved into a Fiber under the Gateway root Context; disposing the root withdraws reporter resources through the effect disposer.
- Production Manager initialization runs only through `startManager()`: mount shared resources, compose the 28 definitions with their hooks, then perform initial reconciliation. Definitions use `provides`, `requires`, and `optional` to build the capability graph.
- The presentation Contribution Catalog publishes only `page`, `navigation`, `settings-section`, `status-card`, `command`, `tray-menu`, `hotkey`, and `theme`; Manager plugin `apply` hooks register business HTTP routes in `ManagerPluginRouteRegistry`.
- The central HTTP chain is limited to LAN authentication, the read-only write gate, plugin route dispatch, Manager SSE, plugin catalog/reconciliation, static assets, JSON 404 for control paths, and WebGUI HTML fallback for all other paths.
- Seven Manager plugins contribute pages, navigation, settings sections, status cards, commands, hotkeys, tray menus, or themes. Nineteen provide runtime capabilities only.
- WebGUI consumes the catalog through trusted command/renderer registries. Desktop consumes lifecycle and panel actions through one frozen Registry. Neither maintains a second extension truth.
- Each plugin keeps ordered teardown in one disposer and uses `ManagerPluginRequestTracker` to remove routes, reject new requests, and drain accepted work. The Manager host separately shuts down through `managerPluginRuntime.unmount() -> managerSharedResourcesRuntime.unmount() -> managerCordisRoot.dispose()` so shared Workers/Persistence do not stop first.
- The separate-process protocol is reserved for unknown, untrusted, or high-risk extensions. Trusted built-in plugins run in the Manager process.

Stable business modules continue to own Route configuration, message records, routing decisions, `AgentPacket`, Outbox, plans, memories, and message-processing records. `PluginCatalog.refreshDeclaration()` updates the manifest and `missingCapabilities` during reload and supports `active -> waiting_dependency -> active`.

## Principles for RabiRoute

### Principle 1: stable modules keep owning business facts

The following facts should remain under stable owners:

- received messages and event records;
- Route configuration, route decisions, and `AgentPacket`;
- handler delivery records and provenance;
- Outbox policy, approval, idempotency, and reply evidence;
- Manager configuration persistence and process state.

Plugins use these facts through public commands, queries, events, or registration interfaces. They do not maintain parallel copies.

### Principle 2: optional or replaceable capabilities become plugins

Prioritize these capabilities:

- message adapters;
- Agent adapters;
- reply endpoints and device connectors;
- context sections, template variables, and diagnostic contributions;
- replaceable speech, storage, or remote-call providers.

Manager and Gateway retain minimal composition kernels, while WebGUI and Desktop retain minimal presentation hosts. Plugins contribute pages, settings, commands, navigation, status, and lifecycle entries, but cannot redefine the router or Outbox boundary.

### Principle 3: services perform work; events report facts

Use service interfaces for direct operations such as delivering to an Agent, appending an event, or submitting to Outbox.

Use events for notifications such as Route configuration changes, completed delivery, or provider availability. Policy interception needs explicit ordering, short-circuit semantics, and a final decision owner.

### Principle 4: one lifecycle scope owns every resource

Each activated plugin receives a lifecycle scope that owns:

- service and Adapter registrations;
- event listeners;
- HTTP, WebSocket, and IPC entries;
- timers and one-shot deadlines;
- file watchers;
- child processes and temporary directories;
- status and diagnostic catalog contributions.

Top-level effect disposers on a Fiber are taken in reverse registration order and then started and awaited concurrently. Multiple disposers inside one `ctx.effect()` run serially in reverse registration order. When teardown phases depend on one another, the plugin registers one critical effect/disposer and completes:

```text
unregister routes
→ stop accepting new requests
→ drain accepted requests
→ stop plugin-owned resources
→ await resource exit
```

A resource without a disposer is not eligible for local reload.

### Principle 5: plugins declare capabilities, not manual startup order

A minimal manifest could describe:

```ts
type RabiPluginManifest = {
  id: string;
  apiVersion: string;
  kind: "message-adapter" | "agent-adapter" | "endpoint" | "context" | "provider";
  scope: "manager" | "gateway" | "route";
  provides: string[];
  requires: string[];
  optional?: string[];
  trust: "in-process" | "process";
};
```

A plugin with missing `requires` reports the exact missing capabilities. Replacing a provider reactivates only instances that depend on it.

### Principle 6: desired configuration and runtime state remain separate

Configuration records desired state. The runtime catalog reports actual state, including:

- discovered;
- waiting for dependencies;
- activating;
- active;
- deactivating;
- failed;
- disabled.

Each instance uses a stable reconciliation ID. A failed update keeps the previous instance and reports the failed phase and restoration result.

### Principle 7: WebGUI reads one authoritative catalog

Plugin ID, display name, maturity, configuration schema, external requirements, diagnostic actions, and runtime state come from one Manager plugin catalog.

WebGUI presents, edits, and saves configuration. It does not maintain a second Adapter list or infer backend capabilities.

### Principle 8: tests prove disposal and real composition

Plugin tests should cover:

1. capabilities become visible after activation;
2. registrations, listeners, ports, and timers disappear after deactivation;
3. repeated activation and deactivation do not duplicate registrations;
4. missing dependencies leave the plugin waiting with exact diagnostics;
5. provider replacement affects only real consumers;
6. partial activation failure rolls back completed work;
7. external sends still pass through Outbox and idempotency checks;
8. tests boot a real composition config instead of only constructing objects by hand.

## Suggested host structure

```text
Manager / Gateway Host
├─ Plugin Composer       reconciles desired config with instances
├─ Service Registry      publishes and resolves stable capabilities
├─ Event Bus             broadcasts typed facts and controlled policy events
├─ Lifecycle Scope       owns plugin disposers; plugins order dependent teardown internally
├─ Plugin Catalog        supplies one catalog to Manager API and WebGUI
└─ Core Services
   ├─ Route Config
   ├─ Event Store
   ├─ Forwarding
   ├─ Agent Delivery
   ├─ Outbox
   └─ Diagnostics

Plugins
├─ Message Adapters
├─ Agent Adapters
├─ Reply / Device Endpoints
├─ Context Contributors
└─ Replaceable Providers
```

A conceptual plugin context could be:

```ts
interface RabiPluginContext {
  provide<T>(key: string, service: T): Dispose;
  require<T>(key: string): T;
  on<T>(event: string, listener: (event: T) => void): Dispose;
  effect(setup: () => Dispose | Promise<Dispose>): Promise<Dispose>;
  diagnostics: RabiPluginDiagnostics;
}
```

Every registration helper should ultimately attach to the same lifecycle scope.

## Current adoption

1. Agent Adapter and Message Adapter capabilities now use controlled registration and composition boundaries.
2. Manager has 28 independent built-in plugin packages with configuration-driven local reconciliation. Dependency revisions recursively include direct and transitive providers, so upstream changes restart real downstream consumers.
3. Production Manager business routes use stable `routeId` values with real `exact/prefix` declarations; duplicate IDs and intersecting static paths are rejected. HTTP routes are not presentation contributions.
4. WebGUI and Desktop consume presentation contributions through host-owned trusted registries. Contracts are bound to `pluginId + instanceId`, so cross-plugin catalog references fail closed. The `manager:desktop` settings section owns system-selection, system-screenshot, clipboard-image hotkey, and login-startup settings.
5. Unknown, untrusted, or high-risk third-party extensions must use a separate process and versioned protocol. This is RabiRoute hardening, not the default execution model for ordinary DSH plugins.
6. Gateway performance sampling and reporting are owned by a root-Context Fiber.
7. A second RabiLink `stop()` cancels a restart queued during shutdown; the configuration watcher and Rabi identity PATCH both await asynchronous Relay synchronization.
8. AstrBot uses only ChatUI `/api/chat/send` and requires `ASTRBOT_SESSION_ID`; the old plugin fallback, deployment API, and deployment script are removed.
9. Trusted Python entry points are in-process Desktop extensions; an owner-scoped registrar, permission model, and stronger isolation still require the controlled Extension Host.
10. Unified validation is complete: TypeScript type checking, backend build, 1,360 TypeScript tests, 55 script-contract tests, WebGUI build, configuration checks, and 202 Desktop Python tests passed; one TypeScript test was skipped by contract.

## Rejected approaches

- Do not start by rewriting Manager or `forwarding.ts`.
- Do not let plugins own Route facts, plans, memories, or Outbox state.
- Do not load arbitrary frontend code as a first-stage plugin capability. Start with declarative UI contributions, then admit trusted custom code through a controlled Extension Host after the contract stabilizes.
- Do not present in-process dependency declarations as a security sandbox.
- Do not enable hot reload before disposal tests and delivery draining exist.
- Do not make every code unit a replaceable plugin. Product-facing pages, menus, commands, settings, status, themes, and device capabilities enter plugin or contribution contracts, while minimal hosts and business fact owners keep stable boundaries.

## Remaining work

- Define a controlled Extension Host and permission model for third-party custom Web/Desktop code.
