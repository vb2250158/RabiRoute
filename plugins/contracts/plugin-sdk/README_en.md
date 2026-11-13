<a href="./README.md">简体中文</a> | English

# RabiRoute Plugin SDK

For plugin authors. A plugin declares its entry with `definePlugin()` and uses only versioned services, permissions, contributions, and scoped resources. It does not import Manager, Gateway, WebGUI, or Desktop source code.

```js
import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const routes = context.services.require("host.http.routes@1");
    context.effects.add(() => routes.register(context.identity.instanceId, []));
  }
}).activate;
```

Use `createPluginTestHarness()` for out-of-tree contract tests. Cover activation, missing permissions, missing dependencies, and registration removal after disposal.

`context.lifecycle` provides activation cancellation and failure reporting; `effects.adopt` owns private resources acquired during preparation. Use `context.publication.add({ publish, rollback, afterPublish?, retire? }, label?)` at the publication boundary: reversible synchronous pointers commit with the services/contributions graph, while post-publication startup and old-owner retirement are separate. Exclusive workers await full retirement in `afterPublish({ previousRetirement, signal })` before starting. See the [publication lifecycle](../../../docs/plugin-publication-lifecycle_en.md).

The formal pure-lifecycle entry is `@rabiroute/plugin-sdk/publication`, exporting the same `PublicationScope` implementation and the `PluginPublication`, `PluginPublicationContext`, and `PluginPublicationRegistrar` types directly. This leaf imports no runtime code or business types; the SDK root re-exports the same class. Plugin Kernel permits only named `PublicationScope` imports and explicit type imports/exports of those three types from this leaf. The SDK root, other leaves, and business modules remain outside its boundary.

The architecture gate uses AST analysis for effect cleanup and actual publication retirement, including resolvable package-local lifecycle references. Empty callbacks, comments, and strings do not count as cleanup. This structural check does not replace actual drain and failure rollback tests.

## Agent packages

Validate package metadata with `parseAgentAdapterPackageDescriptor()` before preparing host modules or evaluating the platform implementation. It reuses the same manifest validator. Entry error cleanup and native rollback share one memoized disposer so actual resources are released once.

An Agent's Manager, Gateway, and Web entries belong to one independent package with an explicit descriptor `type` / `capability` mapping. Existing session IDs and external execution owners remain intact. Platform protocols, implementations, and scanner workers are built into the package; `host.agent-adapters@1` supplies generic host ports.

Declare the Web entry directly as `entries.web: { execution: "in_process", module: "./web/client.mjs" }`. The complete Web build generates this file as `export { activate } from "/assets/<package-entry>.js";`. The publisher reads this wrapper directly and pins the independent card module and its assets to the same Web release. Do not add a second forwarding layer through `web.mjs`.

```js
import { definePlugin, ownAgentAdapter } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./runtime.mjs";

export const activate = definePlugin({ async activate(context) {
  const service = context.services.require("host.agent-adapters@1");
  const host = service.forActivation?.(context.config) ?? service;
  await host.prepareModules(hostModules);
  const owned = createImplementation(host).createAgentOperations();
  ownAgentAdapter(context, {
    type: "exampleAgent", capability: "agent.adapter.example-agent@1",
    manifest: {
      type: "exampleAgent", label: "Example Agent", maturity: "experimental",
      transport: { protocol: "http", mode: "original-owner" }, capabilities: {}
    },
    sessionBinding: { sessionId: "exampleSessionId", workspace: "exampleCwd" },
    operations: owned.operations, dispose: owned.dispose
  });
} }).activate;
```

`parseAgentAdapterDescriptor()` validates and deeply freezes metadata; false `managedTasks` entries become undeclared. `ownAgentAdapter()` uses the same validator and publishes immutable `manifest` and `sessionBinding` field mappings through both the native service and its `agent-adapter` contribution. A verified active owner's metadata takes precedence over a failed replacement's source. Disabled adapters retain readable saved identities; execution requires the current active provider.

`invoke(operation, payload, invocation?)` holds an accepted-work lease until real completion. Multi-step work can use `acquire(snapshot)`, `lease.call()`, and `lease.release()` in `finally`; `runAcceptedWork()` covers original-owner children, receipts, or composite operations. Disabling rejects new work while admitted requests retain their original snapshots and leases. A replacement waits for confirmed retirement before admitting work. It must not replay requests or stop an external Agent.

Run `node scripts/generate-agent-plugin-metadata.mjs` to derive the synchronous compatibility projection from `agent-adapter.json`. This supports legacy synchronous declarations and wire compatibility, and implies neither enabled nor ready status. Running applications resolve the original profile, native services, and declaration metadata. Remove this generated projection and its compatibility exports after all synchronous consumers use declaration ports and historical binding regressions pass. See the [Agent integration requirements](../../../docs/agent-adapter-standard-requirements_en.md) and [publication lifecycle](../../../docs/plugin-publication-lifecycle_en.md) for configuration switching and real shared-worker dependencies.

## Build from an independent plugin repository

Install `@rabiroute/plugin-sdk` and `@rabiroute/host-api`, then run `rabi-plugin-build --root . --output ./dist`. `runtime.build.json`, `manager-runtime.build.json`, and `egress-runtime.build.json` select the plugin’s real implementation entry points. Source imports stay inside the plugin folder; shared host dependencies use `@rabiroute/host-api/<moduleId>`. The builder reads published export signatures without reading host TypeScript source. An existing output with this plugin’s build receipt can be rebuilt; failed compilation preserves the previous output, and unknown directories are never replaced.

The host prepares the emitted `hostModules`; `createImplementation(host)` uses the original shared owners for configuration, routing, storage, and receipts. Workers run in independent processes and cannot directly call main-process host ports. Provide a process-local worker contract before building such a worker. Web entries continue to use their declared frontend build tool and shared UI dependencies.

Scanner workers declare `mode: "host-factory"` in their descriptor and export `hostModules` plus `createImplementation(host)`. The generic host worker prepares its own public ports inside the child process, then calls the scan export named by the task. Main-process ports are never passed across processes. Direct workers bundle their own code and resources and cannot import main-process host ports.

## Test entry

In the Host workspace, run `npm run build` followed by `npm run test:plugins` to collect native-plugin and existing-integration MJS suites. The root `npm test` includes this entry; TypeScript suites remain in its main source phase.

Use `createPluginTestHarness()` for independent plugin contract tests. Integration fixtures that verify actual Host owners, including video fixtures, require the current Host workspace, built output and development dependencies. They do not claim that an independent plugin repository installs or runs the Host.


## Standalone Web builder

A Web plugin can import `@rabiroute/plugin-sdk/web-builder` directly without a RabiRoute `src/plugins` or profile source tree. Provide `package.json`, `rabi.plugin.json` and `rabi.webSource` (or an explicit `entry`). The builder loads `vite` and `@vitejs/plugin-vue` from that plugin repository's own development dependencies, or accepts an explicitly supplied toolchain. Native-only SDK consumers do not load these Web tools.

```js
import { buildPluginWebPackage } from '@rabiroute/plugin-sdk/web-builder';

const result = await buildPluginWebPackage({
  sourceDirectory: process.cwd(),
  outputDirectory: './candidate/web',
  runtimeCatalog: './target-web-runtime.json'
});
```

Read `runtimeCatalog` from the target WebGUI's `assets/web-runtime.json`, or pass the parsed object. Declare custom resource MIME by extension in `rabi.webContentTypes` or `contentTypes`; it travels with the package. The output contains its entry, demand-loaded resources and `module.json`. Rebuilding an existing directory owned by the same plugin stages a replacement; a failed build retains the original directory. Source directories, their parents and paths containing input files cannot be cleared as output. Returned `inputs` contain absolute paths for private build verification, not fields in the public resource manifest. Candidate activation checks the shared exports actually required; ordinary API calls do not go through that check.
