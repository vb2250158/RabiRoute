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
