简体中文 | <a href="./README_en.md">English</a>

# RabiRoute Plugin SDK

面向插件作者。插件通过 `definePlugin()` 声明入口，只使用版本化服务、权限、贡献和作用域资源接口，不导入 Manager、Gateway、WebGUI 或 Desktop 源码。

```js
import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const routes = context.services.require("host.http.routes@1");
    context.effects.add(() => routes.register(context.identity.instanceId, []));
  }
}).activate;
```

`createPluginTestHarness()` 用于树外插件合同测试。测试必须覆盖激活、缺少权限、缺少依赖和释放后的注册清理。
