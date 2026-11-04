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

## Agent 包

包入口先用 `parseAgentAdapterPackageDescriptor()` 读取并验证包描述文件，再准备宿主模块和创建平台实现。该函数复用同一 manifest 校验；准备失败时，入口 catch 与原生 rollback 共用一个 memoized disposer，真实资源只回收一次。

Agent 的 Manager、Gateway 和 Web 入口属于同一独立包，使用描述文件中的显式 `type` / `capability` 映射；原有会话 ID 和外部执行 owner 保持不变。平台实现、协议和扫描 worker 随包构建，`host.agent-adapters@1` 仅提供通用宿主端口。

Web 入口直接声明 `entries.web: { execution: "in_process", module: "./web/client.mjs" }`。完整 Web 构建生成该文件，内容为 `export { activate } from "/assets/<本包入口>.js";`。发布器直接解析这层正式 wrapper，并将独立卡片模块及其资源固定到同一 Web 版本；不要另加 `web.mjs` 多级转发。

包入口可按下列方式发布真实实现：

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

`parseAgentAdapterDescriptor()` 验证并深度冻结描述信息；`managedTasks` 中值为 `false` 的项规范化为未声明。`ownAgentAdapter()` 使用同一校验，将不可变 `manifest`、`sessionBinding` 字段映射同时发布到原生服务和 `agent-adapter` 贡献。已验证的 active owner 元信息优先于更新失败的源文件；关闭端的已保存绑定仍可读取，实际执行必须取得当前 active provider。

`invoke(operation, payload, invocation?)` 持有一次受理租约直到操作真正结束。多步工作可使用 `acquire(snapshot)` / `lease.call()` / `lease.release()`，并在 `finally` 释放；`runAcceptedWork()` 适合原 owner 子进程、回执或复合操作。停用后拒绝新工作，已受理请求保留原快照和租约；替换 activation 等待原 owner 完整退役后开放受理，不能自动重发或停止外部 Agent。

`agent-adapter.json` 的同步兼容投影由 `node scripts/generate-agent-plugin-metadata.mjs` 生成。它仅服务旧同步描述及 wire 兼容调用，不代表启用或就绪；运行中通过原 profile、原生服务和声明元数据解析。待这些同步消费者全部迁到声明读取端口并完成历史绑定回归后，删除生成投影及兼容导出。配置增量及共享 worker 的实际依赖边界见 [Agent 接入规范](../../../docs/agent-adapter-standard-requirements.md) 和 [publication 生命周期](../../../docs/plugin-publication-lifecycle.md)。
