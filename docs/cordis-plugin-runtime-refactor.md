<a href="./cordis-plugin-runtime-refactor_en.md">English</a> | 简体中文

# RabiRoute 基于 Cordis 的插件运行时重构设计

> 状态：已选设计方向。阶段 0 和阶段 1 的首个运行时切片已实施，Manager/Gateway 全量迁移仍在进行。
>
> 主要读者：RabiRoute 维护者、Manager/Gateway 开发者、WebGUI/Desktop 开发者与插件作者。

## 设计决定

RabiRoute 采用“Cordis 组合内核 + Rabi 业务适配层 + 多宿主扩展协议”：

- Manager 和 Gateway 使用 Cordis 管理插件依赖、Fiber 生命周期和副作用撤销。
- RabiRoute 提供自己的服务 key、事件、插件清单、配置和状态目录，不让业务代码直接依赖 Cordis API。
- WebGUI 与 Desktop 保留最小宿主，但页面、状态卡片、命令、菜单、设置项、主题和其他产品能力都可以由插件贡献。
- Route、事件记录、路由判断、`AgentPacket`、投递证据和 Outbox 继续由稳定模块拥有。
- 现有能力按 Agent Adapter、消息端生命周期、Gateway 组合、Manager 目录、表现端扩展、配置对账的顺序迁移。

设计来源见[从 DSH 学习的插件化设计理念](dsh-plugin-architecture-lessons.md)。

## “一切皆插件”的含义

“一切皆插件”不等于“系统没有宿主”。插件必须由一个最小内核完成启动、验证、加载、卸载、权限控制和故障恢复。

RabiRoute 的最小宿主只负责：

1. 启动进程或应用；
2. 验证插件清单、版本、来源和权限；
3. 创建插件运行上下文；
4. 提供生命周期和能力访问；
5. 加载基础组合包；
6. 在插件失败时隔离、回退和报告。

路由、Adapter、设置页、状态页、托盘菜单、快捷键、主题和设备能力属于可组合产品能力，应逐步变成内置插件或插件贡献项。

无法做成插件的只有“负责加载插件的最小内核”及操作系统/运行时边界。

## 依赖基线

截至 2026-08-21，初始验证使用：

- [`cordis@4.0.0-rc.8`](https://github.com/cordiverse/cordis/tree/main/packages/core)，MIT、ESM；
- RabiRoute 当前 Node ESM 与 TypeScript 工程；
- 本机最小验证确认 `Context` 可以挂载插件，`ctx.effect()` 登记的撤销动作会在 Fiber 销毁时执行。

Cordis 4 仍是预发布版本。后续升级或引入 Loader 前必须重新核对最新版本、变更记录和 Loader API，并继续使用精确版本和锁文件。

DSH 使用固定、改名并带本地修改的 Cordis 源码。RabiRoute 不依赖 DSH 的 `@deepseek-ai/cordis`，也不复制其补丁。初始迁移使用上游 `cordis`，所有调用封装在 `src/runtime/`；上游缺陷阻塞生产需求时，优先提交上游修复，其次才维护最小补丁。

## 目标与非目标

### 目标

- 新增插件时减少中心入口、扫描表、类型表和界面目录的重复修改。
- 让监听器、端口、定时器、文件 watcher 和子进程拥有统一撤销路径。
- 让依赖关系决定插件何时启动、等待、停止和重新激活。
- 让 Manager 提供唯一插件目录，WebGUI 与 Desktop 从目录生成对应入口。
- 保持消息路由、投递和外部发送的现有业务语义。
- 支持后续配置对账、局部重载、树外插件和独立进程插件。

### 非目标

- 不在第一阶段重写 `src/forwarding.ts` 的路由规则。
- 不把计划、记忆、人格或 Route 事实交给插件保存。
- 不在第一阶段改变 `adapterConfig.json`、环境变量或公开 Manager API。
- 不把进程内 Cordis Context 当作安全沙箱。
- 不把任意第三方代码直接加载到 Manager、Gateway、浏览器或 Desktop 进程。
- 不保证已发送消息、远端写入或设备指令可以撤销。

## 产品宿主与插件范围

| 宿主 | 最小内核 | 可插件化能力 |
|---|---|---|
| Manager | HTTP 启动、实例锁、插件加载、安全和配置持久化入口 | API 路由、Gateway 管理、扫描、诊断、知识、计划、语音、同步等能力 |
| Gateway | 进程启动、配置读取、根 Context 和退出处理 | 消息端、Agent 端、上下文贡献、Provider、回复端和路由扩展 |
| WebGUI | Vue 应用壳、登录/连接、扩展加载、安全渲染和错误边界 | 页面、导航、设置区、状态卡片、命令、表单、主题和资源 |
| Desktop | 桌面应用壳、Manager 连接、扩展目录、安全边界和窗口生命周期 | 托盘菜单、快捷键、命令、设置区、状态卡片、选择菜单、通知和主题 |

基础发行版也通过“基础组合包”挂载内置插件。用户可以替换、停用或增加可扩展能力，但启动内核、安全入口和事实所有者不能被普通插件覆盖。

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

第一阶段沿用“一条 Route 对应一个 Gateway 子进程”。Gateway 根 Context 已隔离 Route，不增加无用的 Route 子 Context。

WebGUI 是独立 JavaScript 运行时，可以在后续阶段拥有客户端 Extension Host。Desktop 当前是独立 Python/Qt 运行时，不强行移植 Cordis；它通过与 Manager 共享的插件清单和贡献协议实现相同组合语义。

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
  | { kind: "navigation"; id: string; labelKey: string; target: string }
  | { kind: "settings-section"; id: string; schema: JsonSchema; endpoint: string }
  | { kind: "status-card"; id: string; query: string; renderer: BuiltinRenderer }
  | { kind: "command"; id: string; labelKey: string; action: ManagerAction }
  | { kind: "tray-menu"; id: string; commandId: string }
  | { kind: "hotkey"; id: string; commandId: string; defaultBinding?: string }
  | { kind: "theme"; id: string; resourceRoot: string };
```

WebGUI 和 Desktop 读取同一个 Manager Contribution Catalog，再按各自平台能力渲染。插件卸载后，相应页面入口、菜单、快捷键和状态卡片自动消失。

### 自定义界面代码

当声明式贡献无法满足需求时，后续支持 `web-extension` 或 `desktop-extension`：

- 扩展包声明入口、版本、哈希、权限和兼容范围；
- 可信扩展由用户显式启用；
- Web 扩展通过受控 bridge 调用 Manager，不直接读取本机文件和凭据；
- Desktop 扩展优先独立进程或受控脚本 Runtime；
- 插件 API 只暴露已声明能力；
- 加载失败时保留宿主壳和其他扩展；
- 第三方扩展不能覆盖登录、安全、更新和故障恢复入口。

DSH 的普通 profile 插件实际以 Node ESM 进入主进程；其 `isolate` 是服务 realm，模型动态 Host 插件使用的 `node:vm` 也明确不是安全封闭。这里的独立进程策略是 RabiRoute 对未知或高风险代码增加的安全设计，证据见[DSH 如何使用 Cordis：运行时、界面与隔离分析](dsh-cordis-runtime-analysis.md)。

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

插件不单独实现 `stop()`。所有需要停止的资源在激活时登记 disposer，由 Fiber 统一销毁。外部进程的终止和协议关闭也属于 effect。

## 服务、事件与贡献项

- 服务处理需要明确返回值的动作，例如写事件、执行路由、投递 Agent、提交 Outbox。
- 事件通知已经发生的事实，例如配置提交、Gateway 状态变化、投递完成、Fiber 状态变化。
- 贡献项描述宿主应该增加的入口和表现，例如页面、菜单、设置区、状态卡片和主题。

事件必须声明观察、并行等待、串行决策或短路策略中的一种语义。Cordis 不引入固定间隔业务轮询。

## 外部副作用

Fiber 可以撤销服务注册、监听器、端口、定时器、watcher、子进程和插件独占临时资源。

Fiber 无法撤销已经发送的消息、远端 API 写入、设备指令或其他系统已读取的数据。这些操作继续经过 Outbox、幂等 reservation、投递 receipt 和业务补偿。

插件停用前停止接收新工作，并等待当前投递进入明确终态。disposer 只清理本机生命周期资源。

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

## 迁移阶段

### 阶段 0：Cordis 边界验证

新增 `src/runtime/` 和真实组合测试，不接入生产启动。验证精确版本、effect 撤销、依赖等待、Provider 替换和根 Fiber 退出。

当前状态：已完成。Cordis 运行时兼容、Context 创建、插件挂载和根 Fiber 销毁集中在 `src/runtime/`；生命周期测试已覆盖单个 Fiber 和根 Context 的撤销。

退出条件：Cordis API 只出现在 `src/runtime/` 和测试中。

### 阶段 1：Agent Adapter 注册表

合并 Adapter 创建、`deliver()`、能力、Manager 扫描、显示名、成熟度和诊断动作。保留 `createAgentAdapter(type)` 兼容入口，`forwarding.ts` 的路由判断和模板不改。

`codex`、`dsh`、`copilotCli`、`marvis` 和 `astrbot` 已进入同一个 Cordis 注册表。`createAgentAdapter(type)` 已改为兼容入口，消息渲染与真实投递函数保持原路径。Manager 扫描、配置枚举和贡献目录仍需改为读取同一清单。

退出条件：新增内置 Agent Adapter 只增加插件与清单。

### 阶段 2：消息端完整生命周期

先迁移通用 Webhook，证明端口、监听器、状态和失败回退均由 Fiber 持有。随后迁移 Heartbeat、NapCat 和其他消息端。

退出条件：首个消息端可以重复启停且没有资源残留。

### 阶段 3：Gateway Host

`src/index.ts` 只负责读取配置、创建 Context、挂载基础组合包、等待运行和销毁根 Fiber。具体 Adapter 不再由入口直接导入和判断。

退出条件：现有 Gateway 行为和记录保持一致。

### 阶段 4：Manager Plugin/Contribution Catalog

Manager 汇总清单、实例状态、缺失依赖、安装要求、诊断动作以及 WebGUI/Desktop 贡献项。现有扫描 API 先保持兼容。

退出条件：后端、WebGUI 和 Desktop 不再维护独立 Adapter 与扩展目录。

### 阶段 5：WebGUI 与 Desktop 声明式扩展

WebGUI 支持导航、页面模板、设置区、状态卡片、命令和主题。Desktop 支持托盘菜单、快捷键、命令、设置区、状态卡片和主题。

退出条件：安装一个后端插件后，其声明入口可以在支持的平台自动出现并在卸载后消失。

### 阶段 6：配置对账与局部重载

接入稳定实例 ID 和 Loader。第一版支持配置驱动的启用、停用和重新创建，不支持源代码 HMR。

退出条件：配置失败恢复旧实例，不产生重复监听或发送。

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
- 未迁移消息端继续使用旧启动路径；
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

当前已完成第 1、2、3、4、7 项中的运行时部分：精确依赖、Cordis 包装、Agent Adapter Registry、五个内置 Adapter、兼容创建入口和 Fiber 生命周期测试已经存在。第 5、6 项以及静态类型/配置目录收敛仍待完成。

这个切片不修改消息模板、Desktop IPC、DSH 投递、Route 配置、Outbox 或现有界面交互。

## 完成标准

- Cordis 版本和来源已记录；
- Rabi 服务、事件、贡献项和插件清单通过评审；
- 核心事实所有者没有变化；
- WebGUI 与 Desktop 的扩展入口已纳入长期设计；
- 第一阶段兼容入口和验收矩阵已固定；
- 未关联工作区修改保持不变。
