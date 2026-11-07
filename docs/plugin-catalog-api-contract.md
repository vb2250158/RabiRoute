简体中文 | [English](./plugin-catalog-api-contract_en.md)

# 插件目录 API 合同

这组合同提供插件目录、协调状态与 Web 模块的五个可执行操作。core 通过原注册批次调用相应 owner；协调保留原 invocation、队列与内核发布事务。安装版状态按对应发布验收记录核对。

| Operation ID | 方法与路径 |
| --- | --- |
| `manager.plugins.catalog.read` | `GET /api/plugins/catalog` |
| `manager.plugins.reconciliation.read` | `GET /api/plugins/reconciliation` |
| `manager.plugins.reconciliation.run` | `POST /api/plugins/reconciliation` |
| `manager.plugins.modules.list` | `GET /api/plugins/modules` |
| `manager.plugins.modules.read` | `GET /api/plugins/modules/:id/:rev/:relativePath`，尾路径允许多段 |

目录仍由原 `GenerationRuntime` 和源码补丁 presentation 生成；`host` 取首值，空值表示全部。模块仍由原 `WebPluginModuleRegistry` 与 `WebPatchService` 读取，`webRelease` 取首值；URL、保留 revision、MIME、immutable cache 与 nosniff 均保留。原模块 GET 忽略 Range，未在此添加 CSP 或 HEAD。JSON 错误经过既有错误表现层。

已鉴权、没有 Agent/人格绑定的连接可调用这些公共操作。read-only 模式拒绝协调写入。协调等待原生产者的队列、发布和清理完成；成功响应中的 readiness、active/waiting/failed 与 diagnostics 来自实际当前 generation，未变化时不宣称新发布。接口未增加幂等键或自动重放保证。

请求在消费正文前捕获原连接 lease、application/Manager 身份、source root 和 owner 引用，异步完成及披露前复核。协调已交给原 owner 后发生撤权、换代、取消或来源变化时，可信 `mutationOutcome=unknown` 保留，业务数据不披露。超时/断连不会提前释放尚未完成的 producer 租约。

## 目录局部错误与刷新

目录表现按单个 contribution 生成 JSON。某项 getter、循环引用或序列化失败时，响应保留健康贡献，并在 `data.partial: true` / `data.diagnostics` 标明 `PLUGIN_CONTRIBUTION_PRESENTATION_FAILED` 及原实例、插件、kind 和 ID。Web 解析器也逐行隔离无效插件记录，使用 `PLUGIN_CATALOG_ITEM_INVALID` 与行索引定位；整个响应结构不可信时仍按刷新失败处理。

Web 刷新临时失败时继续显示最近有效目录，并单独记录刷新错误。实际 HTTP 401/403 会清除当前目录、立即撤回原模块注册并取消其初始化；迟到工作和释放仍由原模块等待完成。之后明确发起的新目录读取可恢复健康模块，无须等待无关旧模块退出。模块初始化与真实退出边界见[启动与插件生命周期](startup-and-plugin-lifecycle.md#web-模块的独立初始化与退出)。

模块 URL 继续按其原合同解码一次：本组 `pathTails` 在共享参数解析器中解码，资源注册器不再次解码。声明为 `pathRemainder` 的原始资源尾则原样交给对应资源 owner，由该 owner 完成一次解码；不在公共分发层提前解码这类尾路径。

## 总接线要求

1. `controlPlaneRoutes.ts` 的 `handlePluginCatalogApi` import 和原直接分支（从 `if (handlePluginCatalogApi(request, requestUrl, response, {` 到其 `return`/闭括号）全部删除。不要保留布尔 dispatcher。
2. `controlPlaneRoutes.ts` 通过原 core 服务提供工厂及原生 context；core 插件在自身 `registerOperationsAsync` 批次注册这五个操作，并返回原 registration 的 disposer。协调继续使用原队列、invocation 围栏及真实候选清理；不再实施此前草案中的独立 `manager:plugin-catalog-owner` 注册，也不新增监听。
3. 工厂传入稳定的 context 与 `managerReadOnly`，`runtime` 用现有 `managerPluginKernel`，`root:()=>rootDir`；`renderCatalog(input,host,invocation)` 在调用 `managerSourcePatches.invoke("manager.plugin-catalog","renderPluginCatalog",[input,host])` 前后执行 `invocation?.assertCurrent()`。
4. `webModules.list(webRelease,invocation)` 调用 `managerWebPatches.modules(webPluginModules.list(),webRelease)` 前后复核。`read(id,rev,path,invocation)` 依次尝试原 `managerWebPatches.module` 和 `webPluginModules.read`；每个 await 后、fallback 前及返回前复核。不可捕获新请求或重新取得 lease。
5. `reconciliation.reconcile(invocation)` 传给原 `reconcileManagerPlugins("manual API request",{invocation})`。原函数在进入 tail 队列前、出队后、`loadPluginProfile` 后、改变 `loadedManagerPluginProfile` 前、内核 switch 后、module/status/event 发布前复核。返回实际 `managerPluginKernel.current()`。不得把队列接受当完成；原 native profile、候选选择和失败恢复规则继续生效。
6. 正式内核接口为 `GenerationSwitchOptions.beforePublish?:()=>void`；controller 与专属 fixture 均向 `switch()` 传入 `beforePublish:()=>invocation.assertCurrent()`。回归实际加载临时包，阻塞候选 effect commit，期间撤销真实连接，再继续候选。内核在同步 publication 事务内拒绝，旧 generation/services/contributions 保持原引用，候选 publication/afterPublish 均未执行；候选 disposer 未完成前 HTTP 和请求租约均不结束。该测试覆盖真实内核发布点，不只检查外层 wrapper。共享 controller 运行与 core 自身退役的生命周期仍由统一验收覆盖。

原 reconciliation 只在 switch 抛错时恢复旧 profile；若 switch 已发布而随后 assertion 失败，不能恢复成旧 profile 或假称未写入。应先保存/同步已发布的本机原生状态，再阻止响应披露，并保持 `unknown`。本地状态恢复与外部返回必须分开处理。

## 验证范围

专属测试使用临时插件包/Profile、原 `loadPluginProfile` / `GenerationRuntime` / `WebPluginModuleRegistry`、实际注册快照和 loopback HTTP；覆盖空绑定远端成功、禁用 Profile、readiness/失败候选、原生字节与缓存、撤权/来源更换、候选等待期间撤权及发布后未知结果。真实子进程 stdout 在断连/期限到达后被结束，并在进程 close 与 owner 清理完成前保持请求租约。共享完整构建、最终 controller 路由与安装版由统一验收执行。未操作生产插件、下载安装、真实平台消息或真实 Agent 投递。

客户端按操作合同生成多段模块尾路径，保留原入口的编码语义。共享参数解析器对非法编码或非法 `pathTails` 返回 400；普通缺失文件和不合法 revision 保留 404。原始资源 `pathRemainder` 的错误仍由对应资源 owner 处理。

本分片验证：`node --test-concurrency=1 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/pluginCatalogOperations.test.ts src/manager/pluginCatalogRoutes.test.ts src/manager/webPluginModules.test.ts`，24 项通过。六个本分片 TS 文件的独立 `tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --esModuleInterop` 检查通过；该检查不包含共享 controller。
