简体中文 | [English](./plugin-catalog-api-contract_en.md)

# 插件目录 API 合同

本分片提供五个可执行操作和原生功能 owner。共享源码现已删除 controller 旧直接分支并从 core 注册这些操作，原队列也已传递 invocation；接线与完整构建仍待统一冻结验收。内核 `beforePublish` 已接入专属 fixture 并通过真实候选等待期间撤权回归。本页不声称安装版已更新或全局覆盖已完成。

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

远端既有入口会拒绝单段中的编码斜杠；本分片保留该行为，成功远端模块测试采用普通多段 URL。WebGUI 原生入口另测完整编码尾路径。统一 parser 对非法尾路径返回 400；普通缺失文件和不合法 revision 保留 404。

本分片验证：`node --test-concurrency=1 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/pluginCatalogOperations.test.ts src/manager/pluginCatalogRoutes.test.ts src/manager/webPluginModules.test.ts`，24 项通过。六个本分片 TS 文件的独立 `tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --esModuleInterop` 检查通过；该检查不包含共享 controller。
