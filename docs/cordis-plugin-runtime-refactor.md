<a href="./cordis-plugin-runtime-refactor_en.md">English</a> | 简体中文

# RabiRoute 基于 Cordis 的插件运行时重构设计

> 状态：26 个内置 Manager 插件迁移和统一验证均已完成。业务 HTTP 路由由插件注册，WebGUI/Desktop 作为最小扩展宿主消费声明式贡献；第三方任意表现代码的受控 Extension Host 属于后续路线。
>
> 主要读者：RabiRoute 维护者、Manager/Gateway 开发者、WebGUI/Desktop 开发者与插件作者。

## 设计决定

RabiRoute 采用“Cordis 组合内核 + Rabi 业务适配层 + 多宿主扩展协议”：

- Manager 和 Gateway 使用 Cordis 管理插件依赖、Fiber 生命周期和副作用撤销。
- RabiRoute 提供自己的服务 key、事件、插件清单、配置和状态目录，不让业务代码直接依赖 Cordis API。
- WebGUI 与 Desktop 是最小宿主；插件贡献页面、设置区、命令、导航、状态卡、生命周期入口、菜单、快捷键和主题。宿主只负责连接、目录装载、安全渲染、页面/窗口外壳和固定恢复入口，不加载目录提供的任意第三方表现代码。
- Route、事件记录、路由判断、`AgentPacket`、投递证据和 Outbox 继续由稳定模块拥有。
- 内置能力已按 Agent Adapter、消息端生命周期、Gateway 组合、Manager 目录、表现端扩展和配置对账的顺序完成迁移。

设计来源见[从 DSH 学习的插件化设计理念](dsh-plugin-architecture-lessons.md)。

## 当前 Manager 实现

- 正式启动只有 `startManager()` 一条初始化路径：根 Context 先持有共享 Worker/Persistence，再挂载唯一 Manager Plugin Runtime，合成 definition 与业务 `apply` hook 后首次对账。
- definition 通过 `provides`、`requires` 和 `optional` 建立能力图。缺少必需能力时进入 `waiting_dependency`；可选 Provider 存在时参与排序；依赖 revision 递归包含直接与传递 Provider，因此上游 revision 或启停变化会沿能力链重启全部真实消费者；重复 Provider 拒绝对账。
- 生产业务路由声明稳定 `routeId` 和真实 `exact` 或 `prefix` matcher；`dynamic` 只保留为扩展合同。Registry 拒绝重复 ID，以及 method 重叠时的 `exact/exact`、`exact/prefix` 和 `prefix/prefix` 路径冲突。
- Manager 根 Context 持有插件 Runtime 与共享资源 Runtime。退出和启动失败回收显式串行执行 `managerPluginRuntime.unmount() -> managerSharedResourcesRuntime.unmount() -> managerCordisRoot.dispose()`，避免 Cordis 同层 disposer 并发时共享 Worker/Persistence 先于消费者停止。共享资源停止会取消排队/共享请求、flush 写入、终止 Worker 并等待退出；任一停止失败时仍继续清理其余资源。RabiLink 停止会等待 LAN listener、Socket、Relay、SSE、WebGUI 和 Speech drain。
- `PluginCatalog.refreshDeclaration()` 在重载前更新 manifest 与 `missingCapabilities`，允许同一实例经历 `active -> waiting_dependency -> active`，目录不会保留旧声明。
- WebGUI 使用可信 command/renderer 注册表。Desktop 使用冻结 Registry 解析 lifecycle 与 panel action。合同绑定 `pluginId + instanceId`，跨插件目录引用失败关闭。`manager:desktop` 的 `settings-section` 负责系统划词、系统截图、剪贴板贴图快捷键和登录启动设置；活动插件决定快速配置、保存、系统监听、目录操作和手动触发是否存在。
- AstrBot 必须配置 `ASTRBOT_SESSION_ID`，并只调用 `POST /api/chat/send`。旧插件回退、部署接口和部署脚本已经删除。
- 兼容 API 已收敛到 `GET/POST /api/plugins/reconciliation`、`/api/scan/agents`、`/api/scan/agents/dsh` 和 `/api/fennenote/playback`。

## “一切皆插件”的含义

“一切皆插件”不等于“系统没有宿主”。插件必须由一个最小内核完成启动、验证、加载、卸载、权限控制和故障恢复。

RabiRoute 的最小宿主只负责：

1. 启动进程或应用；
2. 验证插件清单、版本、来源和权限；
3. 创建插件运行上下文；
4. 提供生命周期和能力访问；
5. 加载基础组合包；
6. 在插件失败时隔离、回退和报告。

路由、Adapter、设置页、状态页、托盘菜单、快捷键、主题和设备能力属于可组合产品能力；所有可扩展入口通过内置插件或受控插件贡献点提供。

无法做成插件的只有“负责加载插件的最小内核”及操作系统/运行时边界。Desktop/WebGUI 不维护第二套扩展事实；它们作为宿主，只渲染插件贡献目录中声明并受当前平台支持的入口。

## 依赖基线

截至 2026-08-21，初始验证使用：

- [`cordis@4.0.0-rc.8`](https://github.com/cordiverse/cordis/tree/main/packages/core)，MIT、ESM；
- RabiRoute 当前 Node ESM 与 TypeScript 工程；
- 本机最小验证确认 `Context` 可以挂载插件，`ctx.effect()` 登记的撤销动作会在 Fiber 销毁时执行。

Cordis 4 仍是预发布版本。后续升级或引入 Loader 前必须重新核对最新版本、变更记录和 Loader API，并继续使用精确版本和锁文件。

DSH 使用固定、改名并带本地修改的 Cordis 源码。普通 DSH 插件由 Loader 导入同一 Node 进程并挂载为 Fiber；Cordis `isolate` 只改变服务查找作用域。子进程与 Worker 由 subprocess、workflow 等专用能力显式创建，不是所有插件的默认运行方式。RabiRoute 不依赖 DSH 的 `@deepseek-ai/cordis`，也不复制其补丁；上游缺陷阻塞生产需求时，优先提交上游修复，其次才维护最小补丁。

## 目标与非目标

### 目标

- 新增插件时减少中心入口、扫描表、类型表和界面目录的重复修改。
- 让监听器、端口、定时器、文件 watcher 和子进程拥有统一撤销路径。
- 让依赖关系决定插件何时启动、等待、停止和重新激活。
- 让 Manager 提供唯一插件目录，WebGUI 与 Desktop 从目录生成对应入口。
- 保持消息路由、投递和外部发送的现有业务语义。
- 配置对账、局部重载和独立进程合同已经落地；树外插件和第三方任意表现代码的受控 Extension Host 属于后续路线。

### 非目标

- 不在第一阶段重写 `src/forwarding.ts` 的路由规则。
- 不把计划、记忆、人格或 Route 事实交给插件保存。
- 不在第一阶段改变 `adapterConfig.json`、环境变量或公开 Manager API。
- 不把进程内 Cordis Context 当作安全沙箱。
- 不把任意第三方代码直接加载到 Manager、Gateway、浏览器或 Desktop 进程。
- 不保证已发送消息、远端写入或设备指令可以撤销。

## 产品宿主与插件范围

| 宿主 | 最小内核 | 插件贡献 |
|---|---|---|
| Manager | HTTP server、局域网鉴权、只读写门禁、插件路由分发、Manager SSE、插件目录/对账、静态资源、控制路径 JSON 404、其他路径 WebGUI HTML 回退和进程级关闭 | 业务 API、Gateway 控制、扫描、诊断、知识、计划、语音、同步和生命周期入口 |
| Gateway | 进程启动、配置读取、根 Context 和退出处理 | 消息端、Agent 端、上下文贡献、Provider、回复端和路由扩展 |
| WebGUI | Vue 应用壳、Manager 连接、目录装载、安全渲染和恢复页 | 页面、导航、设置区、状态卡、命令、表单、主题和资源 |
| Desktop | Qt 应用壳、Manager 连接、目录装载、宿主可信 handler/resource 注册表、窗口生命周期和恢复入口 | 托盘菜单、快捷键、命令、设置区、状态、选择菜单、通知和主题 |

Desktop/WebGUI 不是固定业务入口。表现 Contribution Catalog 只发布 `page`、`navigation`、`settings-section`、`status-card`、`command`、`tray-menu`、`hotkey` 和 `theme`；HTTP 路由由 Manager 插件的 `apply` hook 注册到 `ManagerPluginRouteRegistry`。宿主拥有的可信注册表可以注册新的 renderer、route、handler 和 resource contract，未知或未注册贡献失败关闭。

当前 26 个 Manager 实例均有 hook。7 个实例有表现贡献，19 个实例只提供运行能力。实例清单以 `src/manager/builtinManagerPlugins.ts` 为真源，生命周期接线以 `src/manager/controlPlaneRoutes.ts` 为当前组合根。

基础发行版也通过内置插件挂载可扩展能力。启动内核、安全入口和业务事实所有者保留稳定边界，普通插件不能覆盖。

## 进程与运行时模型

Manager 和每个 Gateway 子进程分别创建独立的 Cordis 根 `Context`。Context 不跨进程共享。

```text
Desktop / WebGUI
       │
       ▼
Manager Process
└─ Manager Cordis Context
   ├─ Manager Core Bundle
   ├─ Plugin Catalog
   ├─ Gateway Runtime Registry
   ├─ UI Contribution Registry
   └─ Manager Plugins
       │
       ├─ Gateway A Process
       │  └─ Gateway Cordis Context
       └─ Gateway B Process
          └─ Gateway Cordis Context
```

第一阶段沿用“一条 Route 对应一个 Gateway 子进程”。每个常驻 Gateway 只创建一个根 Context，并在同一根下挂载 Agent Adapter Registry、Message Adapter Registry、Contribution Registry 和 Gateway 性能上报 Fiber，不再为这些运行时创建彼此独立的 Host。性能采样与上报由根 Context Fiber 持有；根 Context 销毁时通过 effect disposer 撤销 reporter 资源。

WebGUI 是独立 JavaScript Runtime，Desktop 是独立 Python/Qt Runtime，两者不强制移植 Cordis。Manager 通过 `GET /api/plugins/catalog` 发布共享 Plugin/Contribution Catalog，并支持 `host=web|desktop` 筛选；WebGUI 与 Desktop 通过宿主拥有的可信注册表解析页面、命令、快捷键、主题、状态卡和设置区。内置功能与明确安装并信任的扩展使用同一注册入口；未注册合同失败关闭。

## Rabi 适配层

业务模块不直接接收 Cordis `Context`。所有 Cordis 导入集中在：

```text
src/runtime/
├─ cordisHost.ts
├─ pluginContext.ts
├─ pluginManifest.ts
├─ pluginCatalog.ts
├─ pluginState.ts
├─ serviceKeys.ts
├─ eventKeys.ts
├─ contributionRegistry.ts
├─ coreServices.ts
└─ builtin/
   ├─ agentAdapters/
   ├─ messageAdapters/
   ├─ endpoints/
   ├─ contextContributors/
   └─ uiContributors/
```

### 服务 key

```ts
export type RabiServiceKey<T> = {
  readonly id: string;
  readonly apiVersion: number;
  readonly _type?: T;
};

export const RABI_SERVICES = {
  eventStore: serviceKey<RabiEventStore>("rabi.event-store", 1),
  forwarding: serviceKey<RabiForwarding>("rabi.forwarding", 1),
  agentAdapters: serviceKey<AgentAdapterRegistry>("rabi.agent-adapters", 1),
  outbox: serviceKey<RabiOutbox>("rabi.outbox", 1),
  contributions: serviceKey<ContributionRegistry>("rabi.contributions", 1),
  diagnostics: serviceKey<RabiDiagnostics>("rabi.diagnostics", 1)
};
```

业务 API 版本属于 Rabi 合同，不跟随 Cordis 包版本变化。

### 服务 realm 与 Provider 所有权

每个服务实现由注册它的 Fiber 持有。同一 realm 不允许重复 Provider，只有服务拥有者 Fiber 可以修改服务值。插件作用域服务必须留在自己的 realm，不能意外发布为宿主全局服务；宿主全局服务只能由明确的 Manager/Gateway 组合根提供。

Cordis `isolate` 只改变服务解析 realm，不是安全沙箱。DSH Agent preset 会检查服务是否泄漏到 root realm，并要求 preset 服务位于 `isolate` realm 或移到宿主组合层。RabiRoute 保留同类所有权和泄漏检查规则。

### 插件清单

```ts
export type RabiPluginManifest = {
  id: string;
  apiVersion: 1;
  displayName: string;
  kind:
    | "manager-feature"
    | "message-adapter"
    | "agent-adapter"
    | "endpoint"
    | "context-contributor"
    | "provider"
    | "web-extension"
    | "desktop-extension";
  scope: "manager" | "gateway" | "route" | "web" | "desktop";
  maturity: "verified" | "experimental" | "placeholder";
  provides: string[];
  requires: string[];
  optional?: string[];
  trust: "builtin" | "trusted" | "process" | "sandbox";
};
```

清单描述身份和合同，不保存运行时状态。

### 插件上下文

```ts
export interface RabiPluginContext {
  readonly manifest: RabiPluginManifest;
  provide<T>(key: RabiServiceKey<T>, service: T): Dispose;
  require<T>(key: RabiServiceKey<T>): T;
  optional<T>(key: RabiServiceKey<T>): T | undefined;
  on<T>(event: RabiEventKey<T>, listener: RabiEventListener<T>): Dispose;
  contribute<T>(slot: RabiContributionSlot<T>, value: T): Dispose;
  effect(setup: () => Dispose | Promise<Dispose>): Promise<Dispose>;
  report(patch: RabiPluginStatusPatch): void;
}
```

`provide`、`on`、`contribute` 和项目辅助方法全部进入当前 Fiber 的 effect 作用域。

## 表现端扩展模型

### 声明式贡献

第一版开放受控的声明式贡献，不执行第三方前端代码：

```ts
type RabiUiContribution =
  | { kind: "page"; routeId: string; rendererId: string }
  | { kind: "navigation"; routeId: string }
  | { kind: "settings-section"; rendererId: string; schemaId: string }
  | { kind: "status-card"; rendererId: string }
  | { kind: "command"; handlerId: string }
  | { kind: "tray-menu"; commandId: string }
  | { kind: "hotkey"; commandId: string; defaultBinding?: string }
  | { kind: "theme"; themeId: string };
```

Schema v2 不发布任意 `target`、`endpoint`、`query`、`body` 或 `resourceRoot`。Plugin manifest 与 Contribution 由 Registry 按公开字段重新构造；额外运行时字段不会进入目录。引用必须解析到同一插件实例和注册批次。

Manager 通过 `GET /api/plugins/catalog` 发布同一个 Plugin/Contribution Catalog，并可按 `web` 或 `desktop` 返回表现贡献。WebGUI 与 Desktop 通过宿主拥有的可信注册表解析 renderer、route、handler 和 resource contract；每个合同记录 `pluginId + instanceId`，目录引用必须解析到同一插件实例和注册批次。未知、未注册、跨插件或宿主不支持的贡献失败关闭。目录不可用或刷新失败时撤销旧贡献，只保留固定恢复入口。第三方任意表现代码的受控 Extension Host 属于后续路线。

### 自定义界面代码

当声明式贡献无法满足需求时，后续支持 `web-extension` 或 `desktop-extension`：

- 扩展包声明入口、版本、哈希、权限和兼容范围；
- 可信扩展由用户显式启用；
- Web 扩展通过受控 bridge 调用 Manager，不直接读取本机文件和凭据；
- 当前可信 Python entry point 在 Desktop 进程内执行并接收完整 Registry；owner-scoped registrar、权限模型和更强进程隔离由后续 Extension Host 提供；
- 插件 API 只暴露已声明能力；
- 加载失败时保留宿主壳和其他扩展；
- 第三方扩展不能覆盖登录、安全、更新和故障恢复入口。

DSH 的普通 profile 插件通过 Node ESM 在主进程内运行；Cordis `isolate` 隔离服务作用域，不提供进程隔离，模型动态 Host 插件使用的 `node:vm` 也不是安全沙箱。RabiRoute 要求未知或高风险第三方扩展在独立进程运行，证据见[DSH 如何使用 Cordis：运行时、界面与隔离分析](dsh-cordis-runtime-analysis.md)。

这样保留“一切产品能力皆可扩展”，同时避免第一阶段把任意代码注入关键宿主。

## 核心事实所有权

| 事实 | 所有者 | 插件使用方式 |
|---|---|---|
| Route 配置 | 现有配置模型和 Repository | 查询或提交受控命令 |
| 消息与事件记录 | Event Store / history | 调用服务追加 |
| 路由判断 | `forwarding.ts` 与 `routing/*` | 调用稳定服务或贡献受控策略 |
| Agent 投递 | Agent Delivery Registry | 注册 Provider |
| Outbox 与回传 | RabiRoute Outbox | 唯一外部发送入口 |
| 插件实例状态 | Cordis Fiber + Plugin Catalog | Manager 投影和查询 |
| 页面、菜单与命令目录 | Contribution Registry | 插件贡献，表现宿主渲染 |

Cordis Context 只保存可重建的运行时组合状态。持久事实仍进入现有配置、JSONL、数据库或专门存储。

## 生命周期

```text
discovered
   ├─ missing dependency ─► waiting_dependency
   └─ ready ──────────────► activating
                              ├─ success ─► active
                              └─ failure ─► failed
active ── config/provider change ─► deactivating
 deactivating ── disposed ────────► inactive / activating
```

插件目录至少报告实例 ID、插件 ID、宿主、作用域、状态、缺失能力、开始/停止时间和安全错误摘要。

Fiber 顶层的多个 effect disposer 会按登记逆序取出，再由 `Promise.all(...)` 启动并等待，因此异步清理可以并发。单个 `ctx.effect()` 内返回的多个 disposer 也按登记逆序处理，但通过 Promise 链串行执行。多个 effect 只表达彼此独立的清理；有先后依赖的停止流程必须放进一个关键 effect/disposer：

```text
unregister routes
→ stop accepting new requests
→ drain accepted requests
→ stop plugin-owned workers/processes/timers/sockets/services
→ await resource exit
```

`ManagerPluginRequestTracker` 同时等待 HTTP response 和通过 `trackOperation()` 登记的实际业务 Promise；即使客户端提前断开，插件停用也不会越过已接受的发送、任务、配置写入或扫描操作。Remote Agent 停用会取消回调信号并等待回调真正结束，FenneNote 会等待转发任务，NapCat 会在启动后和健康检查后各记录一次实例 PID。RabiLink 第一次停止期间可以接收一个待重启配置；第二次 `stop()` 会先清除目标 signature，再返回已有停止 Promise，从而取消该排队重启。配置 watcher 的 `afterReload` 和 Rabi 身份配置 PATCH 都等待异步 Relay 同步完成。动态批量对账先按当前激活顺序逆序停用整批变化，再按期望定义顺序启动；激活失败时卸载本批新实例并恢复旧批次。当前 26 个 Manager hook 已按单一关键 disposer 组织。Manager 宿主另外显式串行卸载插件 Runtime、共享资源 Runtime 和根 Context，避免两类顶层资源并发销毁。`PluginCatalog.refreshDeclaration()` 在重载时刷新 manifest 与缺失能力，使实例可以从 `active` 进入 `waiting_dependency`，依赖恢复后再回到 `active`。统一验证已完成。

## 统一验证

2026-08-21 完成统一验证：

- `git diff --check`：通过；
- `npx tsc -p tsconfig.json --noEmit`：通过；
- `npm run build:backend`：通过，Codex Desktop 投递合同和事件驱动架构检查通过；
- `npm test`：TypeScript 测试 1360 项，1359 项通过、1 项跳过；脚本合同测试 55 项全部通过；
- `npm run webgui:build`：通过；
- `npm run check:config`：通过；
- `.\.venv-tray\Scripts\python.exe -m unittest discover -s desktop\tray-task-window\tests -p test_*.py`：202 项全部通过。

## 服务、事件与贡献项

- 服务处理需要明确返回值的动作，例如写事件、执行路由、投递 Agent、提交 Outbox。
- 事件通知已经发生的事实，例如配置提交、Gateway 状态变化、投递完成、Fiber 状态变化。
- 贡献项描述宿主应该增加的入口和表现，例如页面、菜单、设置区、状态卡片和主题。

事件必须声明观察、并行等待、串行决策或短路策略中的一种语义。Cordis 不引入固定间隔业务轮询。

## 外部副作用

Fiber 可以撤销服务注册、监听器、端口、定时器、watcher、子进程和插件独占临时资源。

Fiber 无法撤销已经发送的消息、远端 API 写入、设备指令或其他系统已读取的数据。这些操作继续经过 Outbox、幂等 reservation、投递 receipt 和业务补偿。

插件停用前停止接收新工作，并等待当前投递进入明确终态。`/manager` 和所有 `/manager/*` 始终属于控制路径；未知或拼错路径返回 Manager JSON 404，不进入 WebGUI HTML 回退。disposer 只清理本机生命周期资源。

## 配置模型

第一阶段沿用现有 `adapterConfig.json` 和环境变量，由当前配置模型生成内置插件组合。

```text
adapterConfig.json
      ▼
existing normalize / validate
      ▼
Rabi base bundle + selected built-in plugins
      ▼
Cordis Context
```

后续显式插件配置使用稳定实例 ID：

```yaml
plugins:
  - id: agent-codex
    plugin: builtin:agent-adapter/codex
    enabled: true
    config: {}

  - id: custom-status-page
    plugin: package:example/rabi-status-extension
    enabled: true
    config: {}
```

`id` 是实例身份，`plugin` 是实现身份。显示名、数组位置和文件路径不能代替实例 ID。

## 继续重构前检查

每次上下文压缩后或开始新的实施切片前，重新读取以下最小证据集：

DSH：

- `deepseek-harness/AGENTS.md`
- `deepseek-harness/docs/architecture.md`
- `deepseek-harness/packages/boot/app-boot/src/index.ts`
- `deepseek-harness/packages/core/scope/README.zh.md`

RabiRoute：

- `docs/dsh-plugin-architecture-lessons.md`
- `docs/cordis-plugin-runtime-refactor.md`
- `docs/code-architecture.md`
- `docs/project-function-map.md`

继续修改前确认四项：

1. 新插件拥有的监听器、定时器、端口、进程和注册项是否都能随实例撤销。
2. Route、消息记录、路由判断、`AgentPacket`、Outbox、计划反馈和消息处理记录是否仍各自只有一个业务拥有者。
3. Cordis scope 或 isolate 是否被误写成进程、文件系统、网络或权限隔离。
4. 新能力是否通过公开服务、事件、命令或查询接口协作，而不是直接修改其他模块的内部状态。

## 迁移阶段

### 阶段 0：Cordis 边界验证

新增 `src/runtime/` 和真实组合测试，不接入生产启动。验证精确版本、effect 撤销、依赖等待、Provider 替换和根 Fiber 退出。

当前状态：已完成。Cordis 运行时兼容、Context 创建、插件挂载和根 Fiber 销毁集中在 `src/runtime/`；生命周期测试已覆盖单个 Fiber 和根 Context 的撤销。

退出条件：Cordis API 只出现在 `src/runtime/` 和测试中。

### 阶段 1：Agent Adapter 注册表

合并 Adapter 创建、`deliver()`、能力、Manager 扫描、显示名、成熟度和诊断动作。保留 `createAgentAdapter(type)` 兼容入口，`forwarding.ts` 的路由判断和模板不改。

`codex`、`dsh`、`copilotCli`、`marvis` 和 `astrbot` 已进入同一个 Cordis 注册表。`createAgentAdapter(type)` 已改为兼容入口，消息渲染与真实投递函数保持原路径。类型解析、Gateway 配置枚举、Manager 扫描元数据和快速配置输入已读取同一 manifest；Contribution Registry 合同也已建立。

退出条件：新增内置 Agent Adapter 只增加插件与清单。

### 阶段 2：消息端完整生命周期

通用 Webhook、FenneNote、XiaoAI、RabiLink、Heartbeat、NapCat、WeCom、Weixin 和 Feishu 已通过 `MessageAdapterDefinition` 与 manifest 注册到 `MessageAdapterRegistry`。FenneNote 和 XiaoAI 复用通用 Webhook 的 listener 生命周期，但保留各自的端口、路径、事件类型、消息记录和 Route 来源。RabiLink Fiber 同时持有 HTTP listener 与 Relay worker 租约；最后一个租约释放时取消 SSE、任务领取、附件下载、完成确认和重连等待。Wearable 不再创建 Gateway Adapter，也不再启动共享 Relay worker；健康数据入口继续由 Manager API 持有。Webhook Fiber 持有 HTTP listener；Heartbeat Fiber 持有全部定时器；NapCat Fiber 持有多实例 OneBot WebSocket listener 和已连接客户端；WeCom Fiber 持有入站 SDK 客户端；Weixin Fiber 持有二维码请求、长轮询、等待和入站媒体下载的取消信号；Feishu Fiber 持有独立事件回调 listener 和现有连接。卸载会释放或中止对应资源、阻止迟到结果继续写状态、消息记录或投递，并写入 `disabled`；启动中途失败会回滚已创建资源并写入 `error`。`src/index.ts` 只挂载注册为 Gateway 插件的消息端。`speech`、`rolePanel`、`wearable` 和 `remoteAgent` 继续由 Manager/Desktop 业务入口处理，不再创建占位 Adapter 或空 Gateway 子进程。

测试已覆盖 Webhook 和 Feishu 的端口生命周期、Heartbeat 的定时器生命周期、NapCat 的多实例资源回收、WeCom 的 SDK 客户端生命周期，以及 Weixin 的长轮询取消、迟到结果失效和重复挂载。Feishu 还覆盖 listener 就绪、端口冲突、未完成请求卸载、缺少配置和同端口重新挂载。真实 `dist/index.js` 进程已验证 Webhook 的 `ready -> SIGINT -> disabled` 和端口释放、Weixin 的 `not_requested -> Ctrl+C -> disabled`，Feishu 的 `listening -> Ctrl+C -> disabled` 和端口释放，以及 FenneNote/XiaoAI 同时挂载后的 `running -> Ctrl+C -> disabled` 和双端口释放。RabiLink 的定向测试已覆盖 listener 端口生命周期、端口冲突、禁用 Relay、共享租约、最后释放取消、停止重连、迟到事件失效和重新取得 worker。真实 `dist/index.js` 进程已验证 `ready -> Ctrl+C -> disabled`、`relayWorker=disabled` 和端口释放。阶段 2 已完成消息入口宿主类型拆分。下一步建立单一 Gateway 根 Context，并让 Agent、Message 与 Contribution Registry 由同一组合入口管理。

### 阶段 3：Gateway Host

`src/index.ts` 只负责读取配置、创建 Context、挂载基础组合包、等待运行和销毁根 Fiber。具体 Adapter 不再由入口直接导入和判断。

退出条件：现有 Gateway 行为和记录保持一致。

### 阶段 4：Manager Plugin/Contribution Catalog

当前状态：已实现。`src/runtime/managerPluginRuntime.ts` 在 Manager 根 Context 下提供 Plugin Catalog 与 Contribution Registry 服务，记录插件 manifest、宿主、作用域、生命周期状态、缺失能力和脱敏错误，并在 Fiber 卸载时撤销贡献。`src/manager/builtinManagerPlugins.ts` 将现有 WebGUI 导航、设置区、状态卡片和 Desktop 设置入口声明为内置插件贡献。`GET /api/plugins/catalog` 返回统一快照；`host=web|desktop` 只筛选表现贡献，插件实例清单保持完整。失败或已卸载实例可复用同一实例 ID 重新激活。Manager 启动使用统一失败回滚，端口监听失败或后续初始化失败都会停止已启动资源、关闭 HTTP/SSE、移除信号监听并销毁 Manager 根。现有扫描 API 保持兼容。

退出条件：Manager 只通过一个 API 发布插件与贡献目录。该条件已完成；表现端移除固定目录属于阶段 5。

### 阶段 5：WebGUI 与 Desktop 声明式扩展

当前状态：表现 Contribution Catalog 发布八类声明式贡献。WebGUI 与 Desktop 通过宿主拥有的可信注册表解析新的 renderer、route、handler 和 resource contract；未知、未注册、跨插件或宿主不支持的贡献失败关闭。目录不可用时保留恢复入口；第三方任意表现代码的受控 Extension Host 属于后续路线。

当前切片退出条件：目录可控制宿主内置入口出现或消失，失败时保留恢复入口，Manager 重启后不会永久保留旧目录。允许第三方插件提供新的页面组件、主题资源或命令处理器属于阶段 7。

### 阶段 6：配置对账与局部重载

当前状态：配置驱动的启用、停用、revision 重建和失败回滚已实现，不支持源代码 HMR。26 个内置 Manager 实例共享同一目录和对账器；7 个实例有表现贡献，19 个实例只提供运行能力。

这里的配置对账与 DSH Loader Entry transaction 属于期望状态更新：销毁旧 Fiber、启动新 Fiber，失败时恢复旧实例。源码 HMR 是独立机制，需要备份和恢复 ESM/CJS cache。两条路径只共享 Fiber 销毁与重新挂载语义。

26 个 definition 均有对应 hook。业务 HTTP 路由由插件 `apply` hook 注册到 `ManagerPluginRouteRegistry`；中央 HTTP 链只保留局域网鉴权、只读写门禁、插件路由分发、Manager SSE、插件目录/对账、静态资源、控制路径 JSON 404，以及其他路径 WebGUI HTML 回退。Desktop 生命周期与设置、诊断、Gateway 管理、扫描、Agent 控制、Remote Agent、NapCat、消息处理、计划反馈和后台服务都随所属实例启停。

每个 hook 使用一个关键 disposer 执行 `unregister → stop accepting → drain → stop resources → await exit`。Cordis 会并行执行同一 Fiber 的多个 disposer，因此有顺序依赖的步骤不拆到多个 `ctx.effect()`。

剩余工作是第三方自定义表现代码的受控 Extension Host 与权限边界。

### 阶段 7：树外代码插件与隔离

合同稳定后支持自定义 Web/Desktop 代码扩展和独立进程后端插件。未知包不自动安装，不可信代码不进入关键宿主进程。

退出条件：插件崩溃、升级或协议不兼容不会终止其他 Route 或宿主。

## 验证合同

### 生命周期

- 激活后 Provider 和贡献项可见；
- 销毁后 Provider、页面、菜单、快捷键、监听器、端口和定时器消失；
- 激活中途失败不留下部分注册；
- 重复启停不增加句柄或重复入口；
- Provider 下线前依赖者先停止；
- 无关 Provider 变化不重启消费者。

### 业务一致性

- 相同输入产生相同事件记录、RouteDecision、`AgentPacket` 和投递目标；
- 消息模板、Desktop IPC、DSH session 投递和 Outbox 语义保持不变；
- 配置是期望状态，Plugin Catalog 是实际状态；
- WebGUI 与 Desktop 从同一贡献目录读取事实。

### 安全

- 插件错误不包含凭据、私有消息和敏感路径；
- 第三方代码需要显式信任和能力授权；
- 不可信代码运行在独立进程或更强隔离中；
- 外部发送继续经过幂等和投递证据。

### 性能

对比迁移前后的 Manager/Gateway 冷启动、首次和热态投递、Context 查询开销、句柄数量、内存和多 Gateway 并发。

## 回退策略

每阶段保留兼容壳：

- `createAgentAdapter()` 可以切回旧工厂；
- 旧配置中的 `disabled` 哨兵继续在读取边界规范化，不进入插件注册表或运行时；
- Cordis Gateway Host 通过受控配置启用；
- Manager API 在统一目录成为事实源前保留旧响应；
- WebGUI/Desktop 扩展目录失败时仍显示基础恢复界面。

回退只切换运行时路径，不维护两套业务事实。

## 首个实施切片

1. 引入精确版本 Cordis 和 `src/runtime/` 适配层；
2. 建立 Gateway 内部 Agent Adapter Registry Service；
3. 将 `codex` 与 `dsh` 注册为内置插件；
4. 保留 `createAgentAdapter()`；
5. 让 Manager Agent 扫描读取同一清单；
6. 定义 Contribution Registry 合同，但不改 WebGUI/Desktop；
7. 增加真实 Context 组合、销毁和重复挂载测试。

当前七项均已完成：精确依赖、Cordis 包装、Agent Adapter Registry、五个内置 Adapter、兼容创建入口、统一扫描元数据、声明式 Contribution Registry 合同和 Fiber 生命周期测试已经存在。后续切片已让 Manager API 发布目录，WebGUI 与 Desktop 也已消费第一批受控入口。

这个切片不修改消息模板、Desktop IPC、DSH 投递、Route 配置、Outbox 或现有界面交互。

## 第二个实施切片：通用 Webhook 生命周期

1. 定义 Message Adapter manifest、Definition 和 Registry；
2. 让通用 Webhook `start()` 在 listener 成功后返回可等待的关闭动作；
3. 由 Cordis Fiber 持有启动和关闭动作；
4. Gateway 入口优先挂载已注册消息端，未迁移消息端保留兼容创建入口；
5. 验证重复挂载、端口占用、监听后初始化失败、进程退出状态和端口释放。

这个切片保持 Webhook payload、记录、Forwarding 和 HTTP 响应合同不变。

## 第三个实施切片：Heartbeat 定时器生命周期

1. 将 Heartbeat 注册为 `timer` 类型的 Message Adapter Definition；
2. 让每个实例 Fiber 持有该实例创建的全部定时器；
3. 卸载时清除定时器和 `nextTickAt`，并阻止已经排队的旧回调执行或重新安排；
4. 启动中途失败时清理已创建的定时器并写入 `error`；
5. 重复挂载和卸载不增加定时器数量，正常停止写入 `disabled`。

定时触发后的 Route、Forwarding、AgentPacket、脚本执行和投递证据继续由原业务模块处理。Fiber 只停止未来调度，不撤销已经开始的远端动作。

## 第四个实施切片：NapCat 多实例 WebSocket 生命周期

1. 将 NapCat 注册为 `websocket` 类型的 Message Adapter Definition；
2. 启动等待所有启用实例的 listener 就绪后才报告 `running`；
3. 一个实例启动失败时关闭已创建的其他 listener，并写入 `error`；
4. Fiber 卸载时终止已连接客户端、关闭全部 listener、释放端口并写入 `disabled`；
5. 同一端口可以在卸载后重新挂载，不累积连接和监听器。

QQ 消息解析、回复链、媒体保存、Route 判断、Forwarding 和 Outbox 继续由现有 NapCat 业务模块拥有。

## 第五个实施切片：WeCom SDK WebSocket 生命周期

1. 将 WeCom 注册为 `websocket` 类型的 Message Adapter Definition；
2. 每次 Fiber 挂载创建一个入站 SDK 客户端，调用一次 `connect()`；
3. Fiber 卸载时调用 `disconnect()`、写入 `disabled`，并让迟到的连接、认证和消息事件失效；
4. `connect()` 同步失败时断开已创建客户端并写入 `error`；
5. 缺少 Bot ID 或 secret 时保持失败关闭，不创建 SDK 客户端。

企业微信消息解析、消息记录、Route 判断、Forwarding 和 Outbox 继续由现有业务模块拥有。`src/wecom.ts` 的出站客户端缓存仍服务于 Outbox，不并入入站 Fiber。

## 第六个实施切片：Weixin 登录与长轮询生命周期

1. 将 Weixin 注册为 `http` 类型的 Message Adapter Definition；
2. 每次 Fiber 挂载创建独立的取消信号和消息去重集合；
3. 二维码请求、二维码状态轮询、消息长轮询、等待和入站图片下载都接收同一取消信号；
4. Fiber 卸载时中止当前请求并等待循环退出，迟到结果不能写会话状态、消息记录或触发 Forwarding；
5. 正常停止清除二维码展示状态并写入 `disabled`，重新挂载创建新的长轮询。

个人微信的安全会话、登录请求、同步游标、消息解析、媒体解密、Route 判断、Forwarding 和 Outbox 继续由现有业务模块拥有。Fiber 只管理运行循环和可撤销副作用。

## 第七个实施切片：Feishu HTTP listener 生命周期

1. 将 Feishu 注册为 `http` 类型的 Message Adapter Definition；
2. `start()` 等待 listener 成功后才完成，端口冲突会拒绝 Cordis 挂载；
3. Fiber 卸载先使生命周期失效，再关闭现有连接和 listener，并写入 `disabled`；
4. 卸载期间未完成的请求不能写状态、消息记录或触发 Forwarding；
5. 缺少应用凭据、Verification Token、Encrypt Key 或事件订阅确认时保持 `blocked`，不创建 HTTP server；
6. 状态和 Adapter 日志写入该实例的 `dataDir`，消息记录写入 `memoryDataDir`。

飞书签名校验、URL challenge、加密回调解密、`event_id` 持久去重、来源 `chat_id`、Route 判断、Forwarding 和 Outbox 继续由现有业务模块拥有。Fiber 只管理事件入口和可撤销副作用。

## 第八个实施切片：FenneNote 与 XiaoAI Webhook profile

1. 将 FenneNote 和 XiaoAI 分别注册为 `http` 类型的 Message Adapter Definition；
2. 两个消息端复用通用 Webhook 的 listener 就绪、端口冲突回滚、关闭连接和同端口重新挂载能力；
3. Gateway 入口删除 FenneNote、XiaoAI 和通用 Webhook 的兼容创建分支；
4. manifest 保留各自显示名，配置继续使用各自的 path 和 port；
5. FenneNote 的常驻记录优先策略和 XiaoAI 的转写事件合同保持不变。

## 第九个实施切片：RabiLink Relay 租约生命周期

1. 将 RabiLink 注册为 `http` 类型的 Message Adapter Definition；
2. RabiLink Fiber 在 HTTP listener 就绪后取得 Relay worker 租约，listener 启动失败时不创建 worker；
3. 首个租约启动 SSE、任务领取和重连循环，后续租约只增加引用；
4. 最后一个租约释放时取消 SSE、claim、附件下载、完成确认和重连等待，等待进行中的 drain 退出并删除 worker；
5. worker 固定使用 RabiLink profile 处理普通任务，防止其他入口改变事件类型、记录来源或 Route kind；
6. Wearable 删除 Gateway Adapter 和共享 worker 启动副作用，健康数据继续由 Manager API 与现有健康规则模块处理。

RabiLink 的消息解析、会话记录、健康观察、Route 判断、Forwarding、投递去重和远端完成确认继续由原业务模块拥有。Fiber 与租约只管理 listener、SSE、请求、等待和销毁顺序。

## 第十个实施切片：消息入口宿主类型拆分

1. `MessageEndpointType` 表示 Route、记录、规则、扫描和一次性投递可使用的全部消息入口；
2. `GatewayMessageAdapterType` 只包含由常驻 Gateway Fiber 挂载的九种消息端；
3. `disabled` 只作为旧配置读取哨兵，不能注册、挂载或写成新运行时 Adapter 类型；
4. Gateway 入口删除占位工厂、兼容创建工厂和 `legacyDisposers`，只组合 `MessageAdapterRegistry` 中的定义；
5. Manager 只在 Route 含 Gateway 插件时启动子进程；Route 改为纯 Manager/Desktop 入口时停止原子进程；
6. 一次性 `speech`、`rolePanel`、`wearable` 和 Remote Agent 投递仍读取完整 Route 入口与策略。

该拆分固定“消息来源事实”与“常驻插件生命周期”两个不同合同。WebGUI 使用同一 Gateway 类型判断，不再把 Wearable 状态误判为等待 Gateway 进程。

## 第十一个实施切片：单一 Gateway 根 Context 与命令分发

1. `src/index.ts` 只识别调用类型并动态加载对应模块，不再同时承担一次性命令和常驻 Gateway 生命周期；
2. 常驻 Gateway 使用单一 Cordis 根 Context，在同一根下挂载 Agent Adapter Registry、Message Adapter Registry 和 Contribution Registry；
3. 一次性告警、回放、手动触发、角色面板、计划反馈、语音和 Direct Agent Envelope 命令直接进入命令实现，不能启动 Message Adapter Runtime 或 Contribution Runtime；
4. 常驻 Gateway 的正常退出和启动失败都销毁整个根 Context，由各 Registry Fiber 撤销自身监听器、定时器和注册项；
5. Gateway 性能采样与上报已迁入根 Context Fiber，根 Context 销毁时由 effect disposer 停止 reporter；
6. WebGUI 与 Desktop 是最小宿主。当前贡献目录只控制宿主预先注册的页面、操作、状态和设置；第三方表现代码待合同与隔离边界稳定后接入。

`create-gateway-host` 已完成。

## 第十二个实施切片：Manager Plugin Runtime 与统一目录

1. Manager 根 Context 挂载 `PluginCatalog`、`ContributionRegistry` 和 26 个内置 Manager 插件；
2. 每个插件使用独立 Fiber，激活失败回滚自身贡献，卸载只清理自身注册；
3. `GET /api/plugins/catalog` 返回实例状态和表现贡献；
4. 表现目录只包含八类 contribution，业务 HTTP 路由由插件 `apply` hook 注册。

`create-manager-contribution-catalog` 已完成。

## 第十三个实施切片：Schema v2 与表现端目录消费

1. WebGUI 与 Desktop 使用宿主拥有的可信注册表解析新的 renderer、route、handler 和 resource contract；
2. 同实例、同批次引用必须可解析；未知、未注册、跨插件和不支持的贡献失败关闭；
3. 目录不携带任意 URL、请求正文或资源路径；
4. 第三方任意表现代码的受控 Extension Host 属于后续路线。

`extend-webgui-desktop` 已完成。

## 第十四个实施切片：配置对账与局部重载

1. `data/manager.json.managerPlugins` 只接受已注册内置实例和布尔 `enabled`；`manager:core` 必须启用；
2. Manager watcher 同时跟踪 `manager.json`、Route 配置和人格配置；
3. `ManagerPluginReconciler` 串行比较期望 revision；依赖 revision 递归包含直接和传递 Provider，因此上游变化会把全部真实下游消费者纳入重启批次；
4. 新定义激活失败后恢复旧定义，回滚失败保留 `rollback_failed`；
5. 26 个内置 Manager 插件的 HTTP、服务和后台副作用跟随各自实例活动状态；
6. `GET/POST /api/plugins/reconciliation` 提供状态与手动对账；
7. WebGUI 监听 `plugin_catalog_changed`，不增加业务轮询。

该切片已完成。

## 第十五个实施切片：独立进程插件合同

1. 独立进程使用版本化 JSON Lines 交换 manifest、握手、请求、响应、健康和停止消息；
2. 当前只授权 `ui.contributions`，贡献继续经过现有字段、宿主和引用校验；
3. 超时、协议错误、异常退出和 stderr 使用脱敏错误；
4. Windows 停止通过可测试的进程树清理器终止子进程；
5. `processManagerPlugin.ts` 将通过握手的进程挂到普通 Manager Plugin Fiber，卸载先撤销贡献再停止进程；
6. `manager.json` 不接受命令、路径、包名、URL 或环境变量。独立进程实例只能由受信任的宿主组合代码创建。

该切片已完成。

## 完成标准

- Cordis 版本和来源已记录；
- Rabi 服务、事件、贡献项和插件清单通过评审；
- 核心事实所有者没有变化；
- WebGUI 与 Desktop 的扩展入口已纳入长期设计；
- 第一阶段兼容入口和验收矩阵已固定；
- 统一验证已按本页合同执行并通过；
- 未关联工作区修改保持不变。
