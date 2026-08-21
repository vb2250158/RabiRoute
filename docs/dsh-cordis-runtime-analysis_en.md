English | <a href="./dsh-cordis-runtime-analysis.md">简体中文</a>

# How DSH Uses Cordis: Runtime, UI, and Isolation Analysis

> Status: implementation research based on DSH `141eb6f`, `dsh@0.1.0-rc.8`.
>
> Primary audience: RabiRoute maintainers, plugin-runtime designers, and WebGUI/Desktop extension developers.

## Direct answer

DSH does not place every plugin in a separate process.

- Ordinary plugins installed in a profile enter the current process through the Cordis Loader and Node ESM. They are trusted code.
- Cordis `isolate` changes service-instance resolution realms. It does not isolate processes, memory, filesystem access, or network access.
- A model-written dynamic Host plugin runs in an in-process `node:vm` realm and receives a restricted `ctx`. DSH explicitly documents that this constrains cooperative code and is not containment.
- A model-written browser plugin executes in the current page through `new Function`, with parameter shadowing and a `ctx` proxy restricting common paths. A package with a browser half requires confirmation by a person in the page.
- The DSH operating-system sandbox confines subprocesses launched by Agent tools such as Bash and PowerShell. It is not the general execution boundary for Cordis plugins.
- Worker Threads implement specific providers such as Workflow. They are not the Loader's default isolation for third-party plugins.

RabiRoute's decision to place high-risk or untrusted plugins in separate processes is additional security hardening, not a copy of current DSH behavior.

## Research snapshot

On August 21, 2026, the official DSH `master` and the inspected local checkout both point to:

- [DeepSeek Harness `141eb6f`](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534), `dsh@0.1.0-rc.8`;
- vendored [`@deepseek-ai/cordis` 4.0.0-rc.7](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/vendor/README.md#manifest);
- vendored [`@deepseek-ai/cordis-plugin-loader` 1.0.0-rc.5](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/vendor/README.md#manifest);
- [Cordis composability paper v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf).

DSH does not consume the public upstream npm packages directly. It pins Cordis, Loader, Include, Group, HMR, Timer, and related sources under `vendor/`, renames them into the `@deepseek-ai` scope, and maintains a local modification log.

## Six DSH execution environments

| Code class | Location | Cordis role | Current isolation strength |
|---|---|---|---|
| Built-in and profile npm plugins | DSH Node main process | Loader, services, Fiber, effects, HMR | Trusted, same process |
| Agent preset plugins | Per-session subtree in the Node process | Per-Agent composition and teardown | Service-scope isolation, same process |
| Web client plugins | Current browser page | Browser Context, Loader, UI slots | Trusted, same page |
| Model-written dynamic Host plugins | `node:vm` realm in the Node process | Dynamic Fiber and restricted Context facade | Cooperative restriction, not containment |
| Model-written dynamic browser plugins | `new Function` closure in the current page | Dynamic browser Fiber and restricted Context facade | Cooperative restriction with page confirmation |
| Bash/PowerShell/Workflow work | Subprocess or specific Worker Thread | Cordis selects the provider and owns lifecycle | Capability-specific isolation, not general plugin isolation |

This distinction matters. DSH's “everything is a plugin” describes composition. The host and each provider separately decide whether code is trusted, where it runs, and what it may access.

## 1. DSH pins and modifies Cordis

DSH manages the framework layer as product source instead of a normal dependency:

1. pin upstream commits and versions;
2. rename packages into `@deepseek-ai`;
3. record every local modification;
4. make DSH packages share one Cordis copy through workspace peer dependencies;
5. recopy upstream sources, replay patches, and run the full test suite when updating.

The local changes cover behavior as well as naming. The current log includes Loader failure rollback, serialized Include updates, Windows persistence retries, lazy configuration evaluation, HMR cache rollback, and startup diagnostics.

RabiRoute does not need this maintenance cost in Stage 1. The safer start is an exact upstream version with all Cordis APIs contained under `src/runtime/`, adding a minimal patch only when upstream behavior blocks a real requirement.

## 2. Profiles, bundles, and patches form desired state

DSH does not make its entrypoint construct every business module. Boot starts from an empty list and applies configuration layers in order:

```text
empty plugin tree
  ↓
profile bundle patches
  ↓
profile/cordis.patch.yml
  ↓
$DSH_HOME/cordis.patch.yml
  ↓
command-line --patch overlays
  ↓
final Loader entry tree
```

A row contains at least:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

- `id` is instance identity and the patch target;
- `name` is plugin module identity;
- `inject` adds service requirements for this instance;
- `config` is plugin configuration;
- `isolate` changes the service realm for selected keys;
- `disabled` controls mounting.

A patch replaces the target row's full `config`; it does not deep-merge keys. `dsh --profile <name> --dump-config` prints the effective tree, reducing ambiguity between source files and the actual composition.

## 3. Loader owns imports, instance identity, and local updates

The Cordis Loader turns rows into `Entry` objects:

1. resolve the module from `name`;
2. load it through the Node internal ESM loader or ordinary `import()`;
3. normalize exports and create a Cordis Fiber;
4. associate Entry ID, configuration, and Fiber;
5. update only changed entries;
6. remove new entries and restore old configuration when an update fails.

Out-of-tree plugins are installed with `dsh plugin --profile <name> add <package>`. The command forwards arguments to pnpm in the profile directory. A package declares its bundle patch in `package.json`, then enters the DSH main process as an ordinary ESM plugin during boot.

This mechanism covers installation, resolution, composition, reload, and teardown. It does not isolate malicious code.

## 4. `inject` makes service dependencies control lifecycle

DSH plugins publish capabilities through the Cordis Context, including:

- `ctx.sessions`;
- `ctx.tools`;
- `ctx.agents`;
- `ctx.llm`;
- `ctx.sandbox`;
- `ctx.slots`.

Consumers declare `inject` in plugin metadata or a configuration row. Cordis derives Fiber state from service availability:

```text
missing dependency → PENDING
all dependencies available → LOADING → ACTIVE
provider removed or replaced → consumer unloads or waits
requirements available again → consumer reactivates
```

Row order in a bundle is therefore primarily for readers. Service dependencies determine runtime activation.

DSH calls a swappable capability a seam. A complete seam usually has:

1. a Service Definition with the stable interface;
2. a Service Provider implementing it;
3. a Consumer such as a tool or business plugin.

Filesystem, subprocess, and sandbox providers can change while Bash, PTY, LSP, and other consumers keep using the same service interfaces.

## 5. Fibers own reversible effects

Every `ctx.plugin()` call creates a Fiber. Services, event listeners, timers, UI slots, tools, and other resources installed by a plugin should belong to that Fiber.

Common entries include:

```ts
ctx.effect(() => disposer)
ctx.on(event, listener)
ctx.provide(name, service)
ctx.plugin(childPlugin)
```

Stopping the Fiber reverses these resources through the lifecycle. DSH also disposes partially mounted Contexts after startup failure so terminal state, ports, listeners, or UI contributions do not remain active.

This is the first DSH practice RabiRoute should adopt: give every Adapter listener, port, timer, watcher, and child process one disposal path before implementing dynamic installation.

## 6. Cordis `isolate` is a service realm

DSH `isolate` assigns different Symbols to selected service keys:

```yaml
isolate:
  tools: agent-a
  systemPrompt: agent-a
```

Providers and consumers using one label resolve the same service instance. Different labels can host several implementations with the same service name inside one Node process.

It supports:

- different tool registries per Agent;
- different prompt or provider sets per session;
- multiple same-name services in one process;
- provider replacement notifications limited to actual consumers.

It does not restrict access to `process`, Node built-ins, the filesystem, the network, or other in-memory objects. RabiRoute documentation and APIs should call this a service realm or service scope rather than presenting it as a security level.

## 7. Configuration reload and code HMR are separate paths

DSH separates two kinds of change.

### Configuration changes

Include watches `cordis.patch.yml`, recalculates the Entry list, and uses transactional `update()` operations to create, update, and remove instances. A failed apply restores the previous Entry list.

### Code changes

HMR finds affected modules and consumers, backs up ESM/CJS caches, clears them, and imports the new modules. If import or activation fails, it restores caches and remounts the old plugins.

DSH adds serialization, failure aggregation, asynchronous write draining, and startup audits around these paths. RabiRoute Stage 1 only needs configuration-driven disable, enable, and recreation. Source HMR can wait until lifecycle tests are mature.

## 8. Agent presets are per-session plugin subtrees

DSH separates host capabilities from per-Agent capabilities:

- the host tree owns sessions, persistence, model routing, settings, credentials, sandbox, approval, and cross-session registries;
- an Agent preset contributes tools, persona, prompt sections, compaction policy, and other session plugins;
- the preset subtree is withdrawn with the Agent scope when the session ends.

Different Agents can therefore have different tools and prompts without duplicating the service process.

RabiRoute can learn from Route- or task-level plugin subtrees, while Manager/Gateway stable modules continue owning Routes, event records, delivery evidence, and Outbox.

## 9. The DSH Web UI is another plugin tree

DSH does not treat the Web UI as a fixed page list:

```text
Node Host
  ├─ scan enabled dsh.client packages
  ├─ resolve each ./client export
  ├─ compose and publish the browser module graph
  └─ serve /plugins/<id>/client.js

Browser
  ├─ create ClientModuleSystem
  ├─ create browser Cordis Context + Loader
  ├─ mount each client plugin Fiber
  └─ contribute UI through ctx.slots.register()
```

A UI plugin registers components through slots and may declare child slots, a store, and business injections. When a slot declaration disappears, contributions depending on it are withdrawn. When the plugin unloads, components, child slots, stores, and styles leave through the same lifecycle.

This is more complete than a backend menu manifest: DSH runs a second Cordis plugin tree in the browser.

RabiRoute can adopt it in two stages:

1. Manager Contribution Catalog first supplies declarative navigation, settings, status cards, commands, menus, and themes;
2. after the contract stabilizes, WebGUI gains a client Extension Host for trusted code plugins.

Desktop is currently Python/Qt and does not need a Cordis port for structural symmetry. It can consume the same Contribution Catalog and use a separate-process protocol when code extensions are needed.

## 10. DSH model-written dynamic plugins use another controlled path

DSH also lets the Agent inspect its Cordis runtime and define temporary dynamic packages. These differ from profile npm plugins.

### Host half

- code receives a syntax precheck;
- a new `node:vm` realm evaluates it;
- common entries such as `require`, `fetch`, and Node timers become teaching traps;
- the plugin receives a read-only Context facade exposing lifecycle verbs and declared services;
- the returned plugin still mounts as a Cordis Fiber and can be stopped and withdrawn.

DSH explicitly notes that Host-realm helper functions remain escape routes, so this VM makes cooperative code more inspectable and disposable but is not containment. The VM timeout bounds only synchronous evaluation; asynchronous code can outlive it.

### Browser half

- the Host stores and prechecks the code;
- a person in a page approves a run that has a browser half;
- the browser evaluates the source as an async function body through `new Function`;
- `process` and `Buffer` are `undefined`, while common global calls are shadowed with teaching traps;
- the plugin receives a restricted Client Context facade;
- Fiber teardown removes slots, themes, and styles.

These measures reduce accidental misuse and preserve teardown. The code still runs in the current Host process or browser page and should not be treated as an adversarial security sandbox.

## 11. The DSH OS sandbox protects tool subprocesses

`ctx.sandbox` wraps Bash, PowerShell, and similar calls in argv transformations constrained by a filesystem policy. Current local providers include:

- Linux bwrap/Landlock;
- macOS Seatbelt;
- Windows ACL restricted-token runner.

The sandbox vocabulary primarily governs filesystem effects. Network and process visibility are outside the same mode, and providers report `full` or `partial` enforcement.

It protects commands launched by the Agent. It does not automatically wrap ordinary Cordis plugins imported by Loader; third-party npm plugins still execute in the main process.

## DSH practices worth adopting

### One configuration tree assembles the product

Models, tools, sessions, persistence, Web Host, and UI use the same Entry/Fiber vocabulary. Adding a capability usually adds a package and configuration row rather than central type branches.

### The service graph controls dependencies and restart scope

Missing dependencies, provider replacement, and service-realm changes become explicit Fiber states. Local changes affect actual consumers.

### UI and backend share lifecycle semantics

Host services and browser components can mount, wait for dependencies, withdraw, and reactivate. Unloading a plugin does not remove only backend registrations while leaving stale UI entries.

### Desired state, actual state, and diagnostics are separate

Configuration names the intended entries; Loader/Fiber reports actual state; inventory and startup audits explain failure stages and missing services.

### Dynamic code receives a controlled facade

Even when DSH executes model-written code in-process, it does not pass the entire real Context. It limits services, lifecycle verbs, and cross-face calls.

## Parts not to copy directly

### Do not vendor the whole Cordis stack first

DSH maintains many behavioral patches over its vendored framework. RabiRoute does not yet need the sync, patch replay, and private framework publication cost.

### Do not treat `isolate` as security

It solves same-name service coexistence and dependency-graph partitioning, not malicious code.

### Do not start with source HMR

HMR involves ESM/CJS caches, dependency closures, rollback, and asynchronous resource draining. It amplifies resource residue when lifecycle ownership is incomplete.

### Do not copy model-written code execution directly

DSH `node:vm` and browser closures target cooperative model code and explicitly retain security gaps. RabiRoute should use a separate process, minimal RPC capabilities, and terminable resource limits for unknown-source code.

### Do not let plugins own business facts

Cordis composes capabilities and lifecycle. RabiRoute still needs single owners for Routes, event records, delivery evidence, approval, Outbox, and reply outcomes.

## Recommended RabiRoute trust tiers

| Trust tier | Source | Recommended execution |
|---|---|---|
| `builtin` | Repository code tested with the release | In-process Cordis plugin in Manager/Gateway |
| `installed-trusted` | Explicitly installed and trusted by the user | In-process plugin with recorded source, version, hash, and permissions |
| `declarative` | Third-party manifest and configuration | No code execution; the host renders contributions |
| `isolated` | Unknown, high-risk, or resource-constrained code | Separate process with versioned RPC and capability grants |

Stage 1 needs only `builtin` and `declarative`. Open `installed-trusted` after plugin contracts stabilize, and implement `isolated` only when out-of-tree code has a concrete requirement.

## Adjustment to the current refactor design

- Keep the Cordis composition kernel, Rabi adaptation layer, and multi-host extension protocol.
- Use DSH as a composition and lifecycle reference, not as a security precedent for ordinary plugin loading.
- WebGUI may eventually own a client plugin tree like DSH; Stage 1 still starts with the declarative Contribution Catalog.
- Desktop consumes the same contribution protocol; code plugins prefer a separate process and do not require Python/Qt to run Cordis.
- Label “separate process or stronger isolation” as a RabiRoute security choice, not current DSH behavior.

See [Cordis-Based Plugin Runtime Refactor for RabiRoute](cordis-plugin-runtime-refactor_en.md) for implementation design and [Plugin Architecture Lessons for RabiRoute from DSH](dsh-plugin-architecture-lessons_en.md) for the principle summary.

## Primary evidence paths

- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/architecture.md)
- [DSH Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/cordis-primer.md)
- [Profiles and plugin installation](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/apps/cli/reference/README.md)
- [Vendored Cordis versions and local modifications](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/vendor/README.md)
- [Loader Entry import and update](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/vendor/loader/src/config/entry.ts)
- [`isolate` service-realm implementation](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/vendor/loader/src/config/isolate.ts)
- [Web client Cordis boot](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/client/web/README.md)
- [UI Slot lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/client/ui-slots/README.md)
- [Dynamic Host VM and non-containment statement](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/extensions/cordis-host-runner/src/sandbox.ts)
- [Dynamic Host Context facade](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/extensions/cordis-host-runner/src/guard.ts)
- [Dynamic browser plugin evaluation](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/packages/extensions/cordis-client-runner/src/client/evaluator.ts)
- [DSH process sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/sandbox.md)
