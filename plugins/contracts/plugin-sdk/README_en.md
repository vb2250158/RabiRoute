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
