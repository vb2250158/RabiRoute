English | <a href="./dsh-plugin-architecture-lessons.md">简体中文</a>

# Plugin Architecture Lessons for RabiRoute from DSH

> Status: architecture research with phased implementation. Cordis composition roots, Adapter Registries, the Manager Plugin Runtime, and controlled presentation contributions are implemented; configuration reconciliation, third-party presentation code, and isolated-process plugins remain later stages.
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

This document is based on these official versions:

- [DeepSeek Harness `141eb6f`](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534), the `dsh@0.1.0-rc.8` release commit dated August 19, 2026.
- [A Programming Paradigm for Spatiotemporal Composability, v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf), committed August 13, 2026.
- The [DSH architecture guide](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/architecture.md) and [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/cordis-primer.md).

DSH is still a developer preview. RabiRoute should learn from its design rather than treat the current APIs as a compatibility target.

## How DSH composes plugins

### 1. The shared context exposes capabilities

Cordis represents the runtime as a shared context. Plugins provide services, and consumers declare dependencies on stable capability keys instead of importing a concrete implementation.

DSH mounts model adapters, tool registries, session logs, the Agent loop, persistence, and user interfaces through the same composition mechanism. The host owns composition; each plugin owns its capability.

### 2. Dependencies control lifecycle

A plugin declares required services through `inject`. It remains inactive while dependencies are missing, activates when they appear, and stops or resolves again when a provider is replaced or removed.

Startup order therefore follows capability relationships instead of a manually maintained sequence in an entrypoint.

### 3. Effects are disposable

Cordis treats registration as an effect with an inverse. Event listeners, services, tools, prompt sections, and providers belong to the lifecycle of the plugin that installed them. The host withdraws them in reverse order when the plugin stops.

The paper calls this temporal composability: the system should remove a component's internal changes when that component leaves.

### 4. Configuration describes desired state

DSH combines profiles, bundles, and patches into a plugin tree. Each entry has a stable ID, module entry, configuration, isolation data, and enabled state. The Loader compares this specification with live instances and replaces only affected parts.

Hot reload uses the same mechanism. It disposes the old instances before loading new ones and restores the previous modules and instances when loading fails.

### 5. A plugin boundary is not a security sandbox

Ordinary DSH profile plugins enter the main process through Node ESM and are trusted code. Cordis `isolate` changes service-instance resolution realms; it does not restrict process, filesystem, or network access.

DSH evaluates model-written dynamic Host plugins in an in-process `node:vm` with a restricted Context facade, but the source explicitly says this constrains cooperative code and is not containment. Dynamic browser plugins also execute in the current page. The DSH operating-system sandbox protects tool subprocesses such as Bash and PowerShell; it does not automatically wrap ordinary Cordis plugins.

RabiRoute's separate-process rule for unknown or high-risk plugins is additional security hardening over the DSH composition model. See [How DSH Uses Cordis: Runtime, UI, and Isolation Analysis](dsh-cordis-runtime-analysis_en.md) for the evidence.

### 6. External emissions cannot be undone by unload

Listeners, ports, timers, and local registrations are usually reversible. A QQ message, remote API write, or device command has already left the process and cannot be recalled by unloading a plugin.

The paper places these emissions outside the recoverable system boundary and requires delayed commitment or business compensation. RabiRoute's existing Outbox, sending rules, idempotency keys, and delivery records should continue to own these effects.

## RabiRoute's current base

RabiRoute already has useful ownership boundaries:

- `src/forwarding.ts` owns route decisions, context assembly, and handler delivery.
- `src/adapters/`, `src/agentAdapters/`, and `src/messageEndpoints/` separate integration types.
- `src/manager/controlPlaneRoutes.ts` owns configuration, processes, and control-plane APIs.
- JSONL records, Outbox, and delivery replay separate facts, send requests, and outcomes.
- `scripts/check-event-driven-architecture.mjs` requires owner events for business-state changes.

Extensions still require coordinated edits to static entrypoints:

| Location | Current behavior | Future owner |
|---|---|---|
| `src/adapters/messageAdapter.ts` | Message adapter types are a fixed union | Message-plugin catalog |
| `src/index.ts` | Imports and creates every message adapter | Gateway plugin composer |
| `src/agentAdapters/agentAdapter.ts` | Selects implementations with `if` branches | Agent Adapter registry |
| `src/agentAdapters/managerApi.ts` | Builds scan results from known types | Plugin catalog and capability reports |
| WebGUI types and copy | New integrations often require catalog edits | Controlled catalog returned by Manager |
| `MessageAdapter` | Defines only `start()` | Unified activation and disposal lifecycle |

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

Manager, Gateway, WebGUI, and Desktop remain product hosts. A plugin must not redefine the router or Outbox boundary.

### Principle 3: services perform work; events report facts

Use service interfaces for direct operations such as delivering to an Agent, appending an event, or submitting to Outbox.

Use events for notifications such as Route configuration changes, completed delivery, or provider availability. Policy interception needs explicit ordering, short-circuit semantics, and a final decision owner.

### Principle 4: one lifecycle scope owns every resource

Each activated plugin receives a lifecycle scope that owns:

- service and Adapter registrations;
- event listeners;
- HTTP, WebSocket, and IPC listeners;
- timers and one-shot deadlines;
- file watchers;
- child processes and temporary directories;
- status and diagnostic catalog contributions.

On deactivation, configuration replacement, or startup failure, the scope withdraws completed operations in reverse order. Resources without a registered disposer are not eligible for hot reload.

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
├─ Lifecycle Scope       collects and runs disposers in reverse order
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

## Adoption stages

### Stage 1: internal registries

Keep built-in compilation and the existing configuration format. Consolidate Agent Adapter creation, scanning, capabilities, and display metadata into one registry. Then add complete `stop/dispose` behavior to one message adapter to prove that listeners, ports, and timers can be withdrawn.

Success criterion: adding a built-in Agent Adapter no longer requires edits to multiple central `if` branches, scan tables, and WebGUI enums.

### Stage 2: shared plugin contract

Add manifests, lifecycle scopes, a service registry, and the plugin-catalog API. Migrate existing adapters one by one without changing ownership of `forwarding.ts`, Route configuration, or Outbox.

Success criterion: Manager reports each plugin's source, dependencies, scope, state, and failure phase.

### Stage 3: reconciliation and local reload

Represent built-in plugin instances as desired configuration with stable IDs. Replace only affected instances after a configuration change and restore the previous instance after failure.

Success criterion: repeated enable, disable, reconfigure, and recovery operations on one Gateway leave no duplicate listeners or sends.

### Stage 4: external plugins and isolation

Support out-of-tree packages only after the contract stabilizes. Untrusted or high-risk plugins run in separate processes and receive a versioned protocol with the smallest required capability set.

Success criterion: plugin upgrades, crashes, and protocol incompatibility do not terminate Manager or unrelated Routes.

## Rejected approaches

- Do not start by rewriting Manager or `forwarding.ts`.
- Do not let plugins own Route facts, plans, memories, or Outbox state.
- Do not load arbitrary frontend code as a first-stage plugin capability. Start with declarative UI contributions, then admit trusted custom code through a controlled Extension Host after the contract stabilizes.
- Do not present in-process dependency declarations as a security sandbox.
- Do not enable hot reload before disposal tests and delivery draining exist.
- Do not make every code unit a replaceable plugin. Product-facing pages, menus, commands, settings, status, themes, and device capabilities enter plugin or contribution contracts, while minimal hosts and business fact owners keep stable boundaries.

## Recommended starting slice

The first implementation slice should prove two different benefits:

1. Use one Agent Adapter registry to remove duplicate creation, scan, capability, and UI catalog sources.
2. Give one built-in message adapter a complete lifecycle scope and prove that deactivation leaves no listener, port, or timer behind.

Decide on configuration trees, dynamic package loading, and hot reload only after these two slices pass.

See the selected implementation direction in [Cordis-Based Plugin Runtime Refactor for RabiRoute](cordis-plugin-runtime-refactor_en.md).
