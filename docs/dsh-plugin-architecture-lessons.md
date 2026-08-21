<a href="./dsh-plugin-architecture-lessons_en.md">English</a> | 简体中文

# RabiRoute 从 DSH 学习的插件化设计理念

> 状态：架构调研与实施总结。26 个内置 Manager 插件迁移完成，配置对账、受控表现贡献和独立进程扩展合同已经落地；统一验证已于 2026-08-21 通过。
>
> 主要读者：RabiRoute 维护者、消息端与 Agent 端接入开发者。

## 判断

RabiRoute 适合学习 DeepSeek Harness（DSH）的运行时组合原则，并采用“面向产品的能力皆可插件化”的长期目标，但不立即照搬 DSH 的完整实现。

当前最有价值的改造方向有四项：

1. 可替换能力通过稳定接口注册，不让入口文件认识每个具体实现。
2. 每次注册、监听、定时、端口占用和子进程启动都同时登记撤销动作。
3. 插件声明自己提供和依赖的能力，由宿主决定何时启动、停止或重新激活。
4. 配置描述“希望运行什么”，宿主负责把运行状态调整到该配置，并在失败时恢复原状态。

这四项可以减少接入新平台时对 `src/index.ts`、Adapter 类型联合、Manager 扫描和 WebGUI 目录的同步修改，也能避免重载后残留监听器、重复定时器和旧注册项。

## 资料快照

本次调研基于以下官方版本：

- [DeepSeek Harness `528c682e06`](https://github.com/deepseek-ai/deepseek-harness/tree/528c682e061696f5a160f363f236ecbf53cbd006)，对应 `dsh@0.1.1-rc.1`，提交时间为 2026-08-21 14:21:44 +08:00。
- [《A Programming Paradigm for Spatiotemporal Composability》v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf)，提交日期为 2026-08-13。
- [DSH 架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/architecture.zh.md)与 [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/528c682e061696f5a160f363f236ecbf53cbd006/docs/cordis-primer.zh.md)。

DSH 仍处于开发者预览阶段。本文采用其设计思想，不把当前 API 视为 RabiRoute 必须兼容的标准。

## DSH 的插件化设计

### 1. 共享上下文只暴露能力

Cordis 把运行环境表示为共享上下文。插件提供服务，其他插件按稳定的能力 key 声明依赖，不直接导入某个实现。

DSH 的模型适配器、工具注册、会话日志、Agent 循环、持久化和界面都通过同一种组合机制挂载。宿主负责组合，业务插件负责自己的能力。

### 2. 依赖决定生命周期

插件通过 `inject` 声明所需服务。依赖未满足时保持未激活；依赖出现后启动；依赖提供者被替换或移除时，相关消费者按依赖关系停止并重新解析。

加载顺序因此来自能力关系，不再依赖入口文件中的人工启动顺序。

### 3. 副作用必须可撤销

Cordis 将注册操作视为带撤销动作的副作用。事件监听器、服务、工具、提示词片段和 Provider 都由安装它们的插件 Fiber 持有。

Cordis 同一 Fiber 中的多个 disposer 通过 `Promise.all(...)` 并行执行。它不保证多个 `ctx.effect()` 按登记逆序串行卸载。需要顺序的插件必须在一个 disposer 内执行 `unregister → stop accepting → drain → stop resources → await exit`。

论文把可撤销的内部修改称为时间可组合性：组件退出后，它在系统内部留下的修改应被清除。

### 4. 配置是期望状态

DSH 用 profile、组合包和 patch 形成插件树。每个配置项有稳定 ID、插件入口、配置、隔离信息和启用状态。Loader 对比配置与现有实例，只替换受影响的部分。

热更新建立在同一机制上：先撤销旧实例，再载入新实例；新模块失败时恢复旧模块和旧实例，避免系统停在只更新了一半的状态。

### 5. 插件边界不等于安全沙箱

DSH 的普通 profile 插件通过 Node ESM 进入主进程，属于受信任代码。Cordis `isolate` 只改变服务实例的解析 realm，不限制进程、文件系统或网络。

DSH 对模型生成的 Host 动态插件使用同进程 `node:vm` 和受限 Context façade，但源码明确说明这只约束协作代码，不构成安全封闭；浏览器动态插件也在当前页面执行。DSH 的操作系统沙箱保护 Bash、PowerShell 等工具子进程，不会自动包住普通 Cordis 插件。

因此，RabiRoute 对未知或高风险插件采用独立进程，是在 DSH 组合模型之上增加的安全设计。完整证据见[DSH 如何使用 Cordis：运行时、界面与隔离分析](dsh-cordis-runtime-analysis.md)。

### 6. 外部发送不能靠卸载撤销

监听器、端口、定时器和本机注册通常可以撤销。已经发出的 QQ 消息、远端 API 写入和设备指令已进入系统外部，卸载插件不能恢复原状。

论文将这类动作放在可恢复系统边界之外，要求发送前延迟提交，或提供业务补偿。RabiRoute 现有 Outbox、发送规则、幂等键和投递记录应继续拥有这类外部副作用。

## RabiRoute 当前基础

当前实现已经落地以下边界：

- Manager 和 Gateway 使用独立 Cordis 根 Context。
- `builtinManagerPlugins.ts` 声明 26 个内置 Manager 实例，`controlPlaneRoutes.ts` 为 26 个实例逐一提供 hook。
- 表现 Contribution Catalog 只发布 `page`、`navigation`、`settings-section`、`status-card`、`command`、`tray-menu`、`hotkey` 和 `theme`；业务 HTTP 路由由 Manager 插件的 `apply` hook 注册到 `ManagerPluginRouteRegistry`。
- 中央 HTTP 链只保留局域网鉴权、只读写门禁、插件路由分发、Manager SSE、插件目录/对账、静态资源、控制路径 JSON 404，以及其他路径 WebGUI HTML 回退。
- 7 个 Manager 插件贡献页面、导航、设置区、状态卡、命令、快捷键、托盘菜单或主题；19 个插件只提供运行能力。
- WebGUI 和 Desktop 消费同一受控贡献目录，不维护第二套扩展事实。
- 插件关键卸载顺序放在单一 disposer 中，使用 `ManagerPluginRequestTracker` 撤销路由、拒绝新请求并 drain。
- 独立进程协议只用于未知、不可信或高风险扩展；可信内置插件在 Manager 主进程运行。

Route、消息记录、路由判断、`AgentPacket`、Outbox、计划、记忆和消息处理记录仍由原业务模块拥有。统一验证已于 2026-08-21 通过。

## 适合 RabiRoute 的原则

### 原则一：核心事实继续由稳定模块拥有

以下事实不应分散到插件中：

- 收到的消息与事件记录；
- Route 配置、路由判断和 `AgentPacket`；
- 处理端投递记录与来源；
- Outbox 发送规则、审批、幂等和回传证据；
- Manager 的配置持久化与进程状态。

插件只能通过公开命令、查询、事件或注册接口使用这些事实，不能维护平行副本。

### 原则二：可选或可替换能力进入插件

优先插件化以下能力：

- 消息端 Adapter；
- Agent Adapter；
- 外部回复端与设备端连接器；
- 上下文片段、模板变量和诊断贡献项；
- 可替换的语音、存储或远端调用 Provider。

Manager 和 Gateway 保留最小组合内核，WebGUI 和 Desktop 保留最小表现宿主。页面、设置、命令、导航、状态和生命周期入口由插件贡献；插件不能反向定义 RabiRoute 的路由或 Outbox 边界。

### 原则三：服务用于直接能力，事件用于已发生的事实

直接调用使用服务接口，例如“投递给目标 Agent”“写入事件记录”“提交 Outbox”。

事件用于通知，例如“Route 配置已变更”“投递已完成”“Provider 已上线”。策略拦截必须有明确顺序、短路语义和最终责任主体。

### 原则四：所有生命周期资源由一个作用域持有

每个激活插件的生命周期作用域持有：

- 服务和 Adapter 注册；
- 事件监听器；
- HTTP、WebSocket 和 IPC 入口；
- 定时器和一次性 deadline；
- 文件 watcher；
- 子进程和临时目录；
- 状态与诊断贡献项。

Cordis 会并行执行同一 Fiber 的多个 disposer。插件内部存在先后依赖时，只登记一个关键 disposer，并按以下顺序完成：

```text
unregister routes
→ stop accepting new requests
→ drain accepted requests
→ stop plugin-owned resources
→ await resource exit
```

缺少 disposer 的资源不能参与局部重载。

### 原则五：插件声明能力，不声明人工启动顺序

插件清单至少应描述：

```ts
type RabiPluginManifest = {
  id: string;
  apiVersion: string;
  kind: "message-adapter" | "agent-adapter" | "endpoint" | "context" | "provider";
  scope: "manager" | "gateway" | "route";
  provides: string[];
  requires: string[];
  optional?: string[];
  trust: "in-process" | "process";
};
```

`requires` 未满足时显示具体缺失能力。Provider 替换时，只重新激活依赖该 Provider 的实例。

### 原则六：配置与运行状态分开

配置文件是期望状态，运行时目录记录实际状态。至少需要分别显示：

- 已发现；
- 等待依赖；
- 激活中；
- 运行中；
- 停用中；
- 失败；
- 已停用。

每个实例使用稳定 ID 做对账。配置更新失败时保留原实例，并返回失败阶段和恢复结果。

### 原则七：WebGUI 读取统一目录

插件 ID、显示名、成熟度、配置 Schema、需要的外部依赖、诊断动作和当前状态由 Manager 的插件目录统一提供。

WebGUI 只负责展示、编辑和保存配置。它不维护第二份 Adapter 列表，也不推断后端能力。

### 原则八：测试必须证明撤销和真实组合

插件测试至少覆盖：

1. 激活后能力可见；
2. 停用后注册、监听器、端口和定时器全部消失；
3. 重复启停不会重复注册；
4. 缺少依赖时保持等待并显示缺失项；
5. Provider 替换只影响真实依赖者；
6. 激活中途失败会撤销已完成操作；
7. 外部发送仍经过 Outbox 与幂等检查；
8. 使用真实组合配置启动，而不只在单元测试里手工拼对象。

## 建议的宿主结构

```text
Manager / Gateway Host
├─ Plugin Composer       读取期望配置，维护实例状态
├─ Service Registry      发布和解析稳定能力
├─ Event Bus             广播类型化事实与受控策略事件
├─ Lifecycle Scope       持有插件 disposer；顺序清理由插件内部完成
├─ Plugin Catalog        向 Manager API 与 WebGUI 提供统一目录
└─ Core Services
   ├─ Route Config
   ├─ Event Store
   ├─ Forwarding
   ├─ Agent Delivery
   ├─ Outbox
   └─ Diagnostics

Plugins
├─ Message Adapters
├─ Agent Adapters
├─ Reply / Device Endpoints
├─ Context Contributors
└─ Replaceable Providers
```

插件上下文可以采用如下概念接口：

```ts
interface RabiPluginContext {
  provide<T>(key: string, service: T): Dispose;
  require<T>(key: string): T;
  on<T>(event: string, listener: (event: T) => void): Dispose;
  effect(setup: () => Dispose | Promise<Dispose>): Promise<Dispose>;
  diagnostics: RabiPluginDiagnostics;
}
```

所有辅助注册方法最终都应进入同一个生命周期作用域。

## 当前采用情况

1. Agent Adapter 和 Message Adapter 已进入受控注册与组合边界。
2. Manager 已有 26 个内置插件 definition 与对应 hook，并通过配置对账局部启停。
3. WebGUI 与 Desktop 通过宿主拥有的可信注册表消费表现贡献，并可注册新的 renderer、route、handler 和 resource contract；未知或未注册贡献失败关闭。HTTP 路由不属于表现贡献。
4. 未知、不可信或高风险第三方扩展必须使用独立进程和版本化协议；这属于 RabiRoute 的安全增强，不是 DSH 普通插件的默认运行方式。
5. 第三方自定义表现代码仍需受控 Extension Host 和更明确的权限边界。
6. 统一验证已于 2026-08-21 通过。

## 不采用的做法

- 不先重写整个 Manager 或 `forwarding.ts`。
- 不把 Route 事实、计划、记忆或 Outbox 状态交给插件保存。
- 不把任意前端代码直接作为第一阶段插件能力；第一阶段先支持声明式界面贡献，可信自定义代码在合同稳定后进入受控 Extension Host。
- 不把进程内依赖声明宣传为安全沙箱。
- 不在缺少撤销测试和投递排空机制时启用热重载。
- 不要求每段代码都成为可替换插件；面向产品的页面、菜单、命令、设置、状态、主题和设备能力进入插件或贡献合同，最小宿主与业务事实所有者保留稳定边界。

## 后续工作

- 为第三方自定义 Web/Desktop 代码建立受控 Extension Host 和权限模型。
- 对 26 个 Manager 插件一次性执行卸载顺序、请求 drain、资源退出和真实组合验证。
- 统一验证已于 2026-08-21 通过。
