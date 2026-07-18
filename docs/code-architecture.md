<!-- docs-language-switch -->
<div align="center">
<a href="./code-architecture_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 代码架构

> 状态：当前代码地图。模块路径、Codex transport 和适配器成熟度已按仓库现状校准。

这份文档面向需要改代码的人。它不重复解释 RabiRoute 的产品定位；产品边界见 [架构说明](architecture.md)。这里主要说明代码里的 Module 怎么分工、一条消息怎么流动、改某类功能应该先看哪里。

## 总览

RabiRoute 的代码可以按运行角色分成六块：

```text
src/index.ts
  -> 启动消息端 Adapter
  -> 接收入口事件
  -> 写入 history
  -> forwarding
       -> RouteDecision
       -> AgentPacket
       -> Agent Adapter

src/manager.ts
  -> manager/controlPlaneRoutes.ts
       -> 配置读写
       -> Gateway 进程启停
       -> Adapter 扫描和修复
       -> WebGUI 静态文件和 HTTP 控制面

ribiwebgui/
  -> 浏览器配置界面

desktop/tray-task-window/
  -> Windows 托盘和任务窗口

plugin-adapters/
  -> 外部平台插件/桥接示例

examples/ 和 skills/
  -> 开源示例数据与 Agent 使用指南
```

## 后端入口

### `src/index.ts`

`index.ts` 是单个 Gateway 子进程的入口。

它负责：

- 读取 `config.ts` 解析出的运行时配置。
- 根据 `MESSAGE_ADAPTER_TYPE` / `MESSAGE_ADAPTER_TYPES` 创建消息端 Adapter。
- 处理 `--manual-trigger` 这类一次性手动触发。
- 更新基础 `gateway-status.json`。

它不负责：

- 管理多个 Gateway。
- 编辑配置文件。
- 拼 Agent prompt。
- 决定 WebGUI 返回什么。

多 Gateway 场景由 manager 启动多个 `index.ts` 子进程完成。

### `src/config.ts`

`config.ts` 是 Gateway 子进程的环境变量配置入口。manager 会把每条 Route 的 `adapterConfig.json` 转成环境变量，再启动 `index.ts`。

这里的原则是：

- `config.ts` 只面向单个 Gateway 子进程。
- 跨 Gateway 的配置归一化不要继续塞进这里。
- Route 配置文件的 normalize / validate 应优先放在 `src/shared/gatewayConfigModel.ts`。

## 消息主链路

### Platform Adapter

消息端 Adapter 在 `src/adapters/`。RabiLink Relay 例外：它是由 Manager 持有的系统级转接服务，不是消息端；眼镜端经它收发，当前内部仍保留 `rabilink` 兼容键：

- `napcatAdapter.ts`：接 OneBot / NapCat WebSocket，处理 QQ 群聊、私聊、回复链和 @ 识别。
- `wecomAdapter.ts`：接企业微信智能机器人 WebSocket 长连接，处理企业微信群聊消息、写企业微信消息日志，并把回传目标交给 outbox。当前成熟度仍是 experimental，企业微信群聊字段尽量对齐 NapCat，专用字段只作为补充。
- `webhookAdapter.ts`：接通用 Webhook、小爱及旧 FenneNote 兼容回调，并转成语音转写事件；显式命中 record-first 白名单时交给 `rabilinkObservationRecorder.ts` 写统一观察账本，不逐句投递 Agent。新本机语音入口使用 RabiSpeech。
- `rabilinkAdapter.ts` / `rabilinkRelayWorker.ts`：本地兼容入口与 Relay worker；observation 可先写统一会话账本，主动下行走独立消息流。
- `heartbeatAdapter.ts`：定时触发心跳消息。
- `messageAdapter.ts`：消息端 Adapter 的最小 Interface。

`rolePanel` 和 `remoteAgent` 出现在 MessageAdapter 类型中，但它们的真实入口由 Manager 提供：角色面板走 Manager/托盘 timeline，Remote Agent v3 由 RabiGUI 主动扫描连接远端 bridge。Gateway 子进程只上报对应状态，不另开网络 listener。

Adapter 的职责是协议翻译和轻量入口判断。它们应该把事件转成 RabiRoute 内部 record，然后交给 `forwarding.ts`。Adapter 不应该知道 prompt 怎么拼，也不应该知道处理端怎么投递。

每个消息端的接收/发送权限由 `GatewayDefinition.messageAdapterPolicies` 表达。旧的 `messageInputsDisabled` 和 `messageAdaptersDisabled` 只作为兼容字段保留；新逻辑应该通过 shared helper 读取 policy，不要在某个 adapter 或 manager 路由里手写第二套判断。

### History / Event Store

`src/history.ts` 管 JSONL 事件记录：

- 群聊：`group-messages.jsonl`
- 私聊：`private-messages.jsonl`
- 心跳：`heartbeat-events.jsonl`
- 手动触发：`manual-trigger-events.jsonl`
- 语音转写：`voice-transcripts.jsonl`
- 企业微信：`wecom-messages.jsonl`
- Agent 投递记录：`agent-packets.jsonl`
- Adapter 日志：`*-adapter.log.jsonl`

这里是当前的轻量 Event Store。未来如果要做 replay，应该优先补 `route-decisions.jsonl`，而不是从 Agent prompt 反推。

### `src/forwarding.ts`

`forwarding.ts` 现在是消息主链路的编排器。

它负责：

- 遍历启用的 RouteProfile。
- 调用 RouteDecision 判断是否命中规则。
- 按角色数据目录补写事件记录。
- 调用 AgentPacket 构造处理端消息。
- 写 `agent-packets.jsonl`。
- 调用 Agent Adapter 投递。

它不再负责：

- 具体规则匹配。
- 模板变量生成。
- 角色记忆和计划注入。
- replyContext 构造细节。

这些已经拆到 `src/routing/`。

## Routing Module

### `src/routing/routeDecision.ts`

`RouteDecision` 是“分诊单”。

它回答：

- 当前 RouteProfile 是否命中。
- 命中了哪些 notification rules。
- route kind 是什么。
- 用于匹配的 route variables 是什么。
- 原始消息转换后的 route text 是什么。
- 回复消息转换后的 replied route text 是什么。

它不读角色文件，不拼 prompt，不投递 Agent。

适合在这里加的能力：

- `route-decisions.jsonl`
- decision replay
- 更完整的 route reason
- 规则匹配测试

不适合在这里加的能力：

- 角色记忆召回。
- Agent prompt 文案。
- 外部发送。

### `src/routing/agentPacket.ts`

`AgentPacket` 是“转运包”。

它回答：

- 处理端最终收到什么消息。
- 模板变量如何展开。
- 角色路径、计划、记忆、日志路径如何注入。
- `replyContextJson` 如何构造。

它依赖 RouteDecision，但不重新决定路由。

适合在这里加的能力：

- packet log
- prompt profile
- 不同处理端的 packet format
- Agent 上下文注入测试

不适合在这里加的能力：

- RouteProfile 是否命中。
- NapCat / Webhook 协议判断。
- Manager 控制面 HTTP 逻辑。

### `src/routing/types.ts`

这里放 forwarding / decision / packet 共享的类型，例如：

- `ForwardRouteKind`
- `ForwardRecord`
- `ForwardTemplateValues`
- `ForwardLogKind`

如果一个类型只属于某个具体 Module，不要放到这里。

## Agent Adapter

Agent 端 Adapter 在 `src/agentAdapters/`：

- `agentAdapter.ts`：根据类型创建处理端 Adapter。
- `types.ts`：Agent Adapter 类型与 normalize。
- `managerApi.ts`：manager 用于扫描、安装、登录、打开处理端的控制面能力。
- `astrbotAdapter.ts`：AstrBot 投递实现。

其他处理端在根目录还有：

- `codexRuntime.ts`：Codex 业务适配层，负责固定线程身份、thread/turn 选择、运行中 steer 和运行状态上报。
- `codexDesktopBridge.ts`：从 Desktop 状态只读发现任务，并通过 Desktop IPC 向目标任务 owner start/steer。
- `codexAppServerClient.ts`：仅供创建、命名空任务的短生命周期元数据驱动；不得执行真实 prompt。
- `copilotCli.ts`
- `marvis.ts`

Agent Adapter 的职责是“把 AgentPacket 的消息投给处理端”。不要让它反向定义 RabiRoute 的路由语义。

### Codex adapter 的内部边界

```text
AgentPacket
  -> codexRuntime.ts             task identity / delivery policy
  -> codexDesktopBridge.ts       Desktop IPC transport
  -> Codex/ChatGPT Desktop       target task owner
  -> visible task + turn
```

- Provider 是 OpenAI；adapter 不复制 provider 的账号、鉴权或模型目录。
- Agent/runtime 是 Codex；稳定 adapter id 仍是 `codex`。
- Transport 是 Codex Desktop IPC；Desktop webview 是目标任务实际轮次的 owner。RabiRoute 不为消息执行另启 app-server，也没有备用 transport。
- Host 是必需的 Codex/ChatGPT Desktop。任务未加载时只允许通过 `codex://threads/<id>` 唤醒 Desktop；加载失败就停止投递。
- Model、工具、沙箱和审批由目标 Desktop 任务拥有。兼容字段 `agentModel` 不再覆盖 Desktop 任务设置。

`codexDesktopBridge.ts` 必须保持 transport-only：它不读取 route rule、不拼 AgentPacket、不决定业务外发。`codexAppServerClient.ts` 只保留“创建空任务、恢复用户名称”的元数据能力，不得接收真实 prompt 或执行 turn；元数据操作完成后立即退出。

Desktop 任务审批与 `src/outbox.ts` 的 Action Gate 是两道不同边界：前者控制 Agent 执行权限，后者控制 QQ、文档、设备和外部 API 等业务动作。任何代码都不能把一次任务审批传播成业务外发授权。

## Outbox / Action Gate

`src/outbox.ts` 处理 Agent 回传。

当前重点是聊天消息 reply：

- 解析 Agent 回传请求。
- 找原始 source message。
- 检查 pipeline 是否允许自动回复。
- NapCat 群聊在 `replyToSource=true` 且存在源 `messageId` 时，由 Outbox 统一补 OneBot reply 段；人格和处理端不需要手写 CQ reply，并会避免重复添加。
- NapCat 本地群文件必须位于 `messageAdapterPolicies.napcat.allowedFileRoots`，Outbox 校验真实路径和普通文件类型后调用 `src/napcat.ts` 的 `upload_group_file` 封装；可选说明文本在上传成功后单独发送，避免文本失败导致重复上传大文件。
- 允许时调用对应消息端发送封装，例如 NapCat HTTP 或企业微信智能机器人 SDK。
- 不允许时返回 `blocked` 并附带 draft 数据；发送失败时返回 `failed` 并保留 draft 数据；未选择外部输出时可以返回 `draft` 或把结果保留在 Agent 会话。

当前 Outbox 已是 QQ、WeCom、RabiLink 和角色面板的真实回传层，并为旧 FenneNote Route 保留兼容，但还没有通用持久化审批中心。长期方向是把它深化为通用 Action Gate：

```text
Agent output
  -> action request
  -> draft / approval
  -> send adapter
  -> external system
```

也就是说，QQ reply 只是 Action Gate 的一个 Adapter，不应该成为所有外部动作的唯一形状。

## Manager 控制面

### `src/manager.ts`

`manager.ts` 只是入口：

```ts
import { startManager } from "./manager/controlPlaneRoutes.js";

startManager();
```

不要再把控制面逻辑塞回这个文件。

### `src/manager/controlPlaneRoutes.ts`

这是当前 manager 的 HTTP 控制面主文件。它仍然比较大，但已经开始接入更深的 Module。

它负责：

- 启动 manager HTTP server。
- 提供 `/gateways`、`/api/scan/*`、`/api/message/*`、`/api/agent/*` 等控制面路径。
- 启停 Gateway 子进程。
- 服务 WebGUI 静态文件。
- 聚合 runtime status。

它已经接入：

- `ManagerConfigRepository`
- `RuntimeRegistry`
- `statusPayload`
- `agentAdapters/managerApi`
- `agentThreads`：为缺少 Codex Desktop 连接器工具的后台 Agent 提供受限的正式线程查询、读取、创建和续投能力。
- `messageEndpoints/*`
- `outbox`
- `roleKnowledge`

后续收敛方向：

- 新 endpoint 优先放到专门 Module，再由 `controlPlaneRoutes.ts` 接线。
- 避免在这里新增配置 normalize / validate。
- 避免在这里新增具体平台扫描细节。

### `src/manager/configRepository.ts`

管理 Route 配置与 manager 配置。

职责：

- 读取 `data/manager.json`。
- 确定 `routeRoot` / `rolesRoot`。
- 初始化示例数据目录。
- 读取和写入 `data/route/*/adapterConfig.json`。
- fallback 读取 `personaConfig.json` 里的 notification rules。
- 调用 shared config model 做 normalize / port assignment / conflict validation。

### `src/shared/gatewayConfigModel.ts`

Gateway 配置的事实源 Module。

职责：

- `GatewayDefinition` / `RouteProfileDefinition` / `NotificationRuleDefinition` 类型。
- config name / role id sanitize。
- message adapters normalize。
- NapCat instances normalize。
- template / rule normalize。
- GatewayDefinition normalize。
- 端口冲突校验。
- 自动分配端口。

凡是“Route 配置不变量”，优先放这里。

### `src/manager/runtimeRegistry.ts`

管理 Gateway runtime 的集合和日志。

职责：

- 保存 `GatewayRuntime`。
- 根据 id 查找 runtime。
- 删除缺失 runtime。
- 截断 runtime log。

不要让控制面散落多个 `Map<string, GatewayRuntime>`。

### `src/manager/statusPayload.ts`

负责拼 manager 总状态 payload。

当前较薄，但它是状态 read model 的落点。后续如果 WebGUI 状态结构继续复杂化，应优先深化这里，而不是把 payload 拼接继续堆在 HTTP handler 里。

## Message Endpoint 管理

`src/messageEndpoints/` 放消息端的管理和扫描能力。

- `napcatManager.ts`：NapCat Shell 准备、WebUI token、OneBot 配置、健康检查、启动/停止、扫描。
- `webhookLikeScans.ts`：Webhook / XiaoAi 与旧 FenneNote 兼容 HTTP callback 端点扫描。
- `wecomManager.ts`：企业微信主动 WebSocket 长连接的扫描 read model，检查 SDK、bot id/secret、连接认证状态和最近消息。
- `remoteAgentManager.ts`：远端 Agent 设备发现、密码挑战、连接、任务、事件和文件回传。

这些 Module 面向 manager 控制面，不参与 Gateway 子进程的实时消息处理。

## Role Knowledge

`src/roleKnowledge.ts` 管角色计划和记忆：

- active plans
- recent memories
- consolidated memories
- memory consolidation runs
- role skills
- Agent 上下文快照

`AgentPacket` 会读取它生成“记忆与计划”上下文。`manager/controlPlaneRoutes.ts` 也暴露对应 HTTP 接口。

注意：角色知识属于 Agent 上下文，不属于 RouteDecision。不要让路由是否命中依赖记忆内容。

## WebGUI

`ribiwebgui/` 是 Vue + Vuetify 前端。

关键位置：

- `src/stores/gatewayStore.ts`：调用 manager HTTP 接口并维护配置状态。
- `src/pages/OverviewPage.vue`：总览和运行状态。
- `src/pages/RouteConfigPage.vue`：Route 配置编辑。
- `src/pages/RuntimeLogPage.vue`：运行日志。
- `src/pages/PersonaTemplatePage.vue`：人格和模板相关页面。
- `src/utils/gatewayHelpers.ts`：前端配置辅助函数。
- `src/speech/speechControlClient.ts`：浏览器语音 HTTP Adapter；唯一知道 `/api/speech/*` 路径和 `{ code, data }` envelope 的前端 Module。
- `src/stores/speechStore.ts`：语音控制 read model、命令和共享轮询生命周期；语音页与 Route 监视器不再各自请求后端。
- `src/i18n/index.ts`：唯一 locale 状态、浏览器偏好持久化、`<html lang>` 和切换事件。
- `src/i18n/catalog.ts`：人工校准的英文界面词条和动态文案规则。
- `src/i18n/domLocalizer.ts`：把已登记界面文案应用到 Vue / Vuetify DOM；跳过 `data-no-i18n`、代码块、输入正文和可编辑内容。
- `src/components/LocaleSwitcher.vue`：顶栏 `中 / EN` 切换入口。
- `src/pages/ProjectDocsPage.vue`：加载并渲染 `docs/user-guide/*.md`，提供双语任务导航、全文搜索、本页目录和可分享的 `?page=` 深链接；开发者 Markdown 通过仓库链接继续保持独立事实源。

前端可以做 UI 友好的默认值和展示转换，但配置不变量不要只存在前端。需要和后端一致的规则应进入 `src/shared/gatewayConfigModel.ts` 或由 manager 返回。

语音控制链路采用明确的前后端分离：

```text
SpeechServicePage / SpeechRouteMonitor
  -> frontend speech store
  -> frontend speech client Adapter
  -> Manager speech Interface
  -> manager/speechControl.ts
  -> localSpeechClient Adapter
  -> RabiSpeech Python implementation
```

`src/shared/speechControlContract.ts` 是 Manager 与 WebGUI 之间的稳定 camelCase Interface，也拥有 Route 语音默认值。`src/manager/speechControl.ts` 负责 Route policy、消息异步受理、RabiSpeech payload 映射和 read model 正规化。Python 的 snake_case、模型进程状态和回环地址不能泄漏回 Vue 页面；RabiSpeech 仍是独立本机模型 Runtime，不合并进 Manager。

locale 只允许作为浏览器侧 UI 偏好缓存，键为 `rabiroute:webgui:locale`，不是正式项目存档。route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据属于用户配置或运行事实，必须保持原文；需要保护的动态区域使用 `data-no-i18n` 明确标注。

## Desktop Tray

`desktop/tray-task-window/` 是 Windows 托盘和任务窗口。

它主要负责：

- 启动 / 退出 manager。
- 打开任务窗口。
- 展示角色计划与记忆。
- 和 manager HTTP 接口通信。

它不是 RabiRoute 的事实源。任务、记忆、配置仍应落在 `data/` 和 manager 后端。

## Plugin Adapters

`plugin-adapters/` 放外部平台桥接示例：

- `napcat-rabiroute`
- `xiaoai-rabiroute`
- `rabi-speech`：独立本机 TTS / ASR 服务插件；不属于消息端或 Agent 端，Manager 只代理其回环 HTTP API。

RabiSpeech 的模型基准仍归插件自身：`scripts/benchmark_models.py` 按 TTS → WAV → ASR 顺序采集原始数据，`benchmarks/` 保存公开语料、功能元数据和无外部依赖的 HTML 模板，`skills/benchmark-rabispeech-models/` 固定操作与验收顺序。生成后的公开报告进入 `ribiwebgui/public/reports/`，由 Vite 复制到 WebGUI 静态产物；运行期 WAV、JSON、CSV 和日志不进入前端或仓库。

实时能力页归控制面：`src/manager/speechServiceStatus.ts` 只允许探测回环 RabiSpeech，并删去配置路径、模型目录等私有字段；`src/manager/speechControl.ts` 再把模型、麦克风、播放和消息命令统一映射到 `speechControlContract`。`GET /api/speech/status` 把规范化结果交给 frontend speech store。因此左侧“语音服务”显示当前电脑事实，项目文档和静态 HTML 则保留某次目标测试机基准，两者不能混成同一数据源。

这些目录可以有自己的运行脚本和 README，但不要把真实 token、QQ 号、Cookie、本机路径写进公开示例。

## 测试结构

当前后端测试集中在：

- `src/shared/gatewayConfigModel.test.ts`
- `src/manager/configRepository.test.ts`
- `src/routing/routeDecision.test.ts`

新增测试优先按 Interface 打：

- 配置规则：测 `gatewayConfigModel`。
- 配置文件读写：测 `ManagerConfigRepository`。
- 路由命中：测 `RouteDecision`。
- Agent prompt / replyContext：测 `AgentPacket`。
- 出站安全策略：测 `outbox`。

不要为了测试越过 Module Interface 去测内部 helper，除非 helper 本身已经是稳定 Interface。

## 常见修改入口

### 新增消息入口

优先新增：

```text
src/adapters/<name>Adapter.ts
```

然后在 `src/index.ts` 创建 Adapter，并在 `src/shared/gatewayConfigModel.ts` / WebGUI 类型中补配置类型。

不要把新平台逻辑塞进 `napcatAdapter.ts`。

### 新增处理端

优先新增或修改：

```text
src/agentAdapters/types.ts
src/agentAdapters/agentAdapter.ts
src/agentAdapters/<name>Adapter.ts
src/agentAdapters/managerApi.ts
```

处理端只接收 AgentPacket 生成的消息，不反向定义 RouteDecision。

### 修改路由规则

优先看：

```text
src/routing/routeDecision.ts
src/shared/gatewayConfigModel.ts
docs/routing-configuration.md
```

如果只是 prompt 文案或上下文包，不要改 RouteDecision。

### 修改 Agent 收到的消息格式

优先看：

```text
src/routing/agentPacket.ts
docs/agent-context-injection.md
docs/rabi-agent-interfaces.md
```

不要在 Adapter 里拼 prompt。

### 修改配置界面

优先看：

```text
ribiwebgui/src/stores/gatewayStore.ts
ribiwebgui/src/pages/RouteConfigPage.vue
ribiwebgui/src/types.ts
src/shared/gatewayConfigModel.ts
```

前后端共享的不变量要回到 shared model。

### 修改 manager 控制面

优先看：

```text
src/manager/controlPlaneRoutes.ts
src/manager/configRepository.ts
src/manager/runtimeRegistry.ts
src/manager/statusPayload.ts
src/agentAdapters/managerApi.ts
src/messageEndpoints/
```

新增大块能力时，先建专门 Module，再接到 `controlPlaneRoutes.ts`。

## 架构红线

- 不把 RabiRoute 做成完整 Agent OS。
- 不让 Agent Adapter 反向定义路由语义。
- 不把 prompt 模板写死在平台 Adapter 里。
- 不把 WebGUI 做成配置事实源。
- 不把所有 manager HTTP 逻辑重新堆回 `manager.ts`。
- 不让外部写入绕过 Outbox / Action Gate。
- 不把 NapCat、FenneNote、小爱等外部工具自身能力纳入 RabiRoute 控制面；RabiRoute 只管自己是否接收消息，以及自己是否允许 Agent 通过 RabiRoute 回传/代发。
- 不把运行期 `data/`、日志、token、真实账号写进仓库。
- 不混淆 OpenAI provider、Codex agent、Desktop IPC transport、Desktop task owner 和具体 model。
- 不为 Codex 实际消息增加独立 app-server、共享 4510 或其他备用投递路径。
- 不在 RabiRoute 中硬编码或覆盖模型；由目标 Desktop 任务决定。

## 当前优先演进

当前已经有 `AgentPacket` 审计和 `delivery-replay-ledger.jsonl`。建议按这个顺序继续：

1. 实现无副作用 RouteDecision / AgentPacket dry-run 预览。
2. 继续把 manager 控制面的大 endpoint 群拆到专门 Module。
3. 抽出统一状态 read model，减少 `gateway-status.json`、adapter log 和 WebGUI 硬编码之间的漂移。
4. 在 `outbox.ts` 现有发送与 policy 基础上增加持久化 Action Queue / approval 状态机。
5. 为 experimental adapter 建立真实端到端验收和成熟度升级条件。

## 暂存设计提醒

### 消息端权限语义收窄

刚加入的 `messageAdapterPolicies` 需要后续再收一次语义。它不应该表达“RabiRoute 管理外部工具能不能发送”，而应该表达：

- RabiRoute 是否接收某个消息端进入的消息。
- RabiRoute 是否允许 Agent 通过 RabiRoute 自己的 outbox / Action Gate 回传或代发。

因此 WebGUI 文案后续建议从“启用消息发送”收窄为“允许 Agent 通过 RabiRoute 回传/代发”。NapCat、FenneNote、小爱自己的发送能力不属于 RabiRoute 的控制面；除非某个 endpoint 明确被定义为 RabiRoute 的 Agent 回传通道，否则不要把外部工具原生能力纳入 policy。
