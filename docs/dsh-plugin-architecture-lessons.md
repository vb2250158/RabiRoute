<a href="./dsh-plugin-architecture-lessons_en.md">English</a> | 简体中文

# RabiRoute 从 DSH 学习的插件化设计理念

> 状态：架构调研与分阶段实施。Cordis 组合根、Adapter Registry、Manager Plugin Runtime 和受控表现贡献已实现；配置对账、第三方表现代码和独立进程插件仍在后续阶段。
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

- [DeepSeek Harness `141eb6f`](https://github.com/deepseek-ai/deepseek-harness/tree/141eb6fef83422698aef7a981029e843e8161534)，对应 `dsh@0.1.0-rc.8`，提交日期为 2026-08-19。
- [《A Programming Paradigm for Spatiotemporal Composability》v8](https://github.com/cordiverse/paper/blob/948a07b369c62adb3b12e102458be5c18dfb69b9/paper.pdf)，提交日期为 2026-08-13。
- [DSH 架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/architecture.zh.md)与 [Cordis 入门](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/cordis-primer.zh.md)。

DSH 仍处于开发者预览阶段。本文采用其设计思想，不把当前 API 视为 RabiRoute 必须兼容的标准。

## DSH 的插件化设计

### 1. 共享上下文只暴露能力

Cordis 把运行环境表示为共享上下文。插件提供服务，其他插件按稳定的能力 key 声明依赖，不直接导入某个实现。

DSH 的模型适配器、工具注册、会话日志、Agent 循环、持久化和界面都通过同一种组合机制挂载。宿主负责组合，业务插件负责自己的能力。

### 2. 依赖决定生命周期

插件通过 `inject` 声明所需服务。依赖未满足时保持未激活；依赖出现后启动；依赖提供者被替换或移除时，相关消费者按依赖关系停止并重新解析。

加载顺序因此来自能力关系，不再依赖入口文件中的人工启动顺序。

### 3. 副作用必须可撤销

Cordis 将注册操作视为带撤销动作的副作用。事件监听器、服务注册、工具、提示词片段和 Provider 都由当前插件的生命周期持有。插件停止时，宿主按逆序撤销这些操作。

论文把这一点称为时间可组合性：组件退出后，它在系统内部留下的修改应被清除。

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

RabiRoute 已具备适合继续演进的边界：

- `src/forwarding.ts` 持有路由判断、上下文组装和处理端投递主流程。
- `src/adapters/`、`src/agentAdapters/` 与 `src/messageEndpoints/` 已按接入类型分目录。
- `src/manager/controlPlaneRoutes.ts` 持有配置、进程和控制面。
- JSONL 记录、Outbox 与 delivery replay 已区分事实、发送请求和投递结果。
- `scripts/check-event-driven-architecture.mjs` 已要求业务状态通过拥有者事件更新。

当前扩展仍依赖多个静态入口同步修改：

| 位置 | 当前表现 | 插件化后应由谁提供 |
|---|---|---|
| `src/adapters/messageAdapter.ts` | 消息端类型是固定联合 | 消息端插件清单 |
| `src/index.ts` | 直接导入并创建各消息端 | Gateway 插件组合器 |
| `src/agentAdapters/agentAdapter.ts` | `if` 分支选择具体 Agent 端 | Agent Adapter 注册表 |
| `src/agentAdapters/managerApi.ts` | 扫描结果按已知类型组装 | 插件目录与能力报告 |
| WebGUI 类型与文案 | 新接入常需同步添加目录项 | Manager 返回的受控插件目录 |
| `MessageAdapter` | 只有 `start()` 合同 | 统一的激活与撤销生命周期 |

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

Manager、Gateway、WebGUI 和 Desktop 仍是产品宿主。插件不能反向定义 RabiRoute 的路由边界。

### 原则三：服务用于直接能力，事件用于已发生的事实

直接调用使用服务接口，例如“投递给目标 Agent”“写入事件记录”“提交 Outbox”。

事件用于通知，例如“Route 配置已变更”“投递已完成”“Provider 已上线”。策略拦截必须有明确顺序、短路语义和最终责任主体。

### 原则四：所有生命周期资源由一个作用域持有

插件激活时获得自己的生命周期作用域。作用域统一持有：

- 服务和 Adapter 注册；
- 事件监听器；
- HTTP、WebSocket 和 IPC 监听；
- 定时器与一次性 deadline；
- 文件 watcher；
- 子进程和临时目录；
- 状态页与诊断目录贡献项。

停用、配置替换或启动失败时，作用域按逆序撤销已完成的操作。未登记撤销动作的资源不能用于支持热重载。

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
├─ Lifecycle Scope       收集并逆序执行撤销动作
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

## 分阶段采用

### 阶段 1：内部注册表

先保持内置编译与现有配置格式，将 Agent Adapter 的创建、扫描、能力和显示信息合并到一个注册表。随后选择一个消息端补全 `stop/dispose`，验证监听器、端口和定时器可以完全撤销。

成功标准：新增内置 Agent Adapter 不再修改多个中心 `if`、扫描表和 WebGUI 枚举。

### 阶段 2：统一插件合同

增加 manifest、生命周期作用域、服务注册表和插件目录 API。现有 Adapter 逐个接入，不改变 `forwarding.ts`、Route 配置和 Outbox 的所有权。

成功标准：Manager 能报告每个插件的来源、依赖、作用域、状态和失败阶段。

### 阶段 3：配置对账与局部重载

把内置插件实例写成带稳定 ID 的期望配置。配置变更只替换受影响实例；失败时恢复旧实例。

成功标准：同一 Gateway 连续启用、停用、改配置和恢复失败插件，不产生重复监听或重复发送。

### 阶段 4：外部插件与隔离

稳定合同后再支持树外包。不可信或高风险插件默认运行在独立进程，通过版本化协议访问最小能力集合。

成功标准：插件升级、崩溃和协议不兼容不会让 Manager 或其他 Route 一起退出。

## 不采用的做法

- 不先重写整个 Manager 或 `forwarding.ts`。
- 不把 Route 事实、计划、记忆或 Outbox 状态交给插件保存。
- 不把任意前端代码直接作为第一阶段插件能力；第一阶段先支持声明式界面贡献，可信自定义代码在合同稳定后进入受控 Extension Host。
- 不把进程内依赖声明宣传为安全沙箱。
- 不在缺少撤销测试和投递排空机制时启用热重载。
- 不要求每段代码都成为可替换插件；面向产品的页面、菜单、命令、设置、状态、主题和设备能力进入插件或贡献合同，最小宿主与业务事实所有者保留稳定边界。

## 推荐起点

首个实施切片应同时验证两类价值：

1. 用统一 Agent Adapter 注册表消除创建、扫描、能力和界面目录的重复事实源。
2. 为一个内置消息端增加完整生命周期作用域，证明启停后没有残留监听器、端口或定时器。

这两个切片通过后，再决定是否引入配置树、动态包加载和热更新。

已选实施方向见[基于 Cordis 的插件运行时重构设计](cordis-plugin-runtime-refactor.md)。
