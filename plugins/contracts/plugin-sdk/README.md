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

`context.lifecycle` 提供完整 activation 的取消信号和故障上报，`effects.adopt` 接管准备阶段取得的私有资源。`context.publication.add({ publish, rollback, afterPublish?, retire? }, label?)` 用于发布边界：同步可逆指针切换与服务/贡献图同时提交；发布后启动与旧 owner 退役分开。独占 worker 在 `afterPublish({ previousRetirement, signal })` 中等待旧实例完整退役再启动。详见[publication 生命周期](../../../docs/plugin-publication-lifecycle.md)。

正式纯生命周期入口是 `@rabiroute/plugin-sdk/publication`，直接导出同一 `PublicationScope` 实现及 `PluginPublication`、`PluginPublicationContext`、`PluginPublicationRegistrar` 类型。该 leaf 不导入运行时代码或业务类型；SDK 根入口仍转导出同一个类。Plugin Kernel 只允许从该 leaf 具名导入 `PublicationScope` 与显式类型导入/导出上述三种类型，不允许依赖 SDK 根入口、其它 leaf 或业务模块。

架构检查按 AST 识别 effects 清理和 publication 的真实 `retire`，支持包内可解析的生命周期引用；空回调、注释或字符串不算清理。该静态门禁不能替代实际资源 drain 与失败回滚测试。
