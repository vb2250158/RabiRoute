<!-- docs-language-switch -->
<div align="center">
<a href="./code-architecture_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 代码架构

> 状态：当前代码地图。模块路径、Codex transport 和适配器成熟度已按仓库现状校准。

这份文档面向需要改代码的人。它不重复解释 RabiRoute 的产品定位；产品边界见 [架构说明](architecture.md)。这里主要说明代码里的 Module 怎么分工、一条消息怎么流动、改某类功能应该先看哪里。

## 事件驱动红线

业务状态变化默认必须由拥有者发出事件，再由 Route、人格、客户端或控制面响应；有可靠事件能力的链路禁止用固定间隔 HTTP 请求、全目录扫描或 JSONL 重读来发现“有没有变化”。cursor 只用于事件流断线后的补漏与幂等恢复，不是轮询节拍；settle、重试、超时和 Heartbeat 可以使用一次性定时事件，但定时器触发后必须处理明确工作，不能空转扫描。低层音频 stall watchdog 和 SSE/WS transport keepalive 不读取业务状态，属于连接安全机制。只有宿主或上游明确没有事件、SSE、WS 或变更通知，而且移除轮询会损坏现有功能时，才允许登记受控例外；例外必须限制生命周期和读取范围、使用长等待或分钟级低频、支持停止与退避，并在文档中写明原因。当前受控例外只有五类：Android 前台服务仅在系统已知离线时每五分钟检查一次 OS 当前网络，以覆盖少数厂商漏发默认网络回调，恢复后立即停止且不查询 Relay/消息/cursor；DashScope 远端异步会议 ASR 在请求 deadline 内查询任务终态；用户显式启用、上游没有推送接口的小米健康 ADB Companion；Rokid AIUI QuickJS 的 25 秒前台事件背书下行等待；以及 AIUI 页面可见时最低 60 秒一次、宿主没有变更事件的眼镜电量刷新。

## 总览

RabiRoute 的代码可以按运行角色分成以下主要区域：

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

apps/
  -> 可独立构建的 RabiLink Android 与 Rokid AIUI 客户端

packages/
  -> 供端侧应用复用的 Android SDK

examples/
  -> 可复制的配置、Hook、插件与协议样例

skills/
  -> Agent 使用指南
```

## 客户端应用与共享 SDK

- `apps/rabilink-android/`：同一工程内维护手机控制端和 `glass-app` 眼镜端模块。
- `apps/rabilink-aiui/`：面向 Rokid AIUI/灵珠生态的独立客户端工程。
- `packages/android-sdk/`：Android 客户端共享的 RabiRoute 事件、消息与状态契约。

这些目录是 RabiRoute 的端侧消费者，不是 Manager 配置或运行数据的事实源。可直接复制的小样例仍放在 `examples/`；新增完整产品时应进入 `apps/`，跨应用共享且有稳定接口的代码才进入 `packages/`。

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

- `napcatAdapter.ts`：接 OneBot / NapCat WebSocket，处理 QQ 群聊、私聊、回复链和 @ 识别；引用消息未落盘时，通过 `napcatReplyMessages.ts` 调用 `get_msg` 递归补齐并缓存，查询失败不阻塞当前路由。
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

这些文件保留入口协议和调试证据，但不再各自担任 Agent 最近上下文的唯一来源。QQ 自身回复、ASR/TTS、WeCom、Remote Agent、Role Panel、RabiLink 等入站/出站消息会同时归一到人格级双向账本。

### `src/messageContextStore.ts`

`messageContextStore` 是双向会话上下文的唯一实现，`src/messageContext.ts` 只是兼容 facade：

```text
data/roles/<RoleId>/conversation/current.jsonl
data/roles/<RoleId>/conversation/archive/<firstSequence>~<lastSequence>.jsonl
data/roles/<RoleId>/conversation/archive/index.json
```

- `current.jsonl` 没有条数上限，只按时间窗口归档。
- 归档检查发现任意记录超过 72 小时时，把连续前缀中已超过 24 小时的完整记录移入 `n~m.jsonl`；不按自然日删除。
- Agent 自动上下文只读 `current.jsonl`，归档保留给 Agent 显式查证。
- 查询必须同时匹配当前人格、逻辑消息端和会话；入站和出站合计占用同一条数额度。
- 附件只保留类型、文件名、MIME、大小等安全元数据，不存私有绝对路径。

### `src/forwarding.ts`

`forwarding.ts` 现在是消息主链路的编排器。

它负责：

- 在低信号过滤和规则判断前，先把入站事件写入所有相关人格的统一账本。
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
- 当前人格、逻辑消息端和会话最近双向消息如何从 `conversation/current.jsonl` 取得。
- 当前消息明确要求 Agent 处理多电脑人格同步时，如何只为本次任务注入同应用 peer 查询、当前人格同步和冲突终态合同；普通消息不携带该提示。Manager 的事件驱动自动对账器独立运行，不由 AgentPacket 创建或拥有。
- 当前消息询问全天/区间声纹、用户与他人发言或说话人身份时，如何注入当前人格的 `voice-transcripts` 查询和 `voice-identities` 追加修正合同；证据不足必须保持 unknown。

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

`src/routing/agentCapabilityHints.ts` 单独拥有这些按当前意图出现的能力提示和触发词。它只返回调用合同，不读取人格数据、不执行 HTTP，也不决定身份或同步目标；AgentPacket 负责把返回的行作为当前任务表现出来。这样新增能力提示不会继续把 packet 编排器变成另一套业务控制面。

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
- 已匹配的普通消息不经过另一层忙碌队列：Desktop owner 先尝试 `steer` 活跃 turn，只在没有活跃 turn 时 `start`。Heartbeat 的忙碌跳过和语音的关键词唤醒是各自消息端的显式例外。

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

`RABIROUTE_MANAGER_READ_ONLY=1` 是构建产物验收专用模式。它强制关闭 Gateway、Relay、LAN discovery、Route watcher 和人格文件 watcher 自动启动，跳过启动时的语音麦克风协调与配置目录迁移，并在 HTTP 入口拒绝 POST、PUT、PATCH、DELETE。`scripts/test-built-manager-readonly.mjs` 在临时回环端口启动当前 `dist/manager.js`，通过 stdout 就绪事件而非轮询等待，然后只读取 Gateway 摘要、人格同步 manifest/索引状态/冲突、主机通用语音消息，以及 manifest 中每个人格的声纹关系和语音会话视图。只读校准不写 manifest 缓存；证据只保存状态、索引模式、数量和构建哈希，不保存人格名、角色 ID、文件路径、转写正文、人物、token、Relay URL 或监听地址；现有 8790 Manager 不会被重启。

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

`src/roleKnowledgePresentation.ts` 只生成 Manager 对外的只读展示 DTO：派生“阻塞中 / 待QA测试”等显示状态，并统一计划与记忆排序。它不修改计划文件，也不进入 RouteDecision 或 Agent 上下文判断。WebGUI 和 Qt 必须消费 Manager 返回的 `presentation` 与列表顺序，不各自复制这套规则。

`src/planFeedback.ts` 拥有与 `planId/stepId` 关联的审批意见 JSONL、同 `feedbackId` 投递状态折叠和读取摘要。Manager 的 `/api/roles/:roleId/plans/:planId/feedback` 是唯一写入口：UI 提交时可复用角色面板链通知 Agent，Agent 记录 QQ 审批或处理结果时使用 `record_only`。该模块不修改计划 JSON；只有后续显式计划 PATCH 才能推进步骤或状态。

`src/context/rabiContextManager.ts` 是角色上下文触发的唯一归口。它把 `session_start`、`user_prompt`、`reasoning_pre_tool`、`reasoning_post_tool`、`message_delivery` 和无副作用 `preview` 映射为统一的召回、归档、`viewedAt` 与呈现策略，也是生产代码中 `roleKnowledgeSnapshot()` 的唯一调用方。

`AgentPacket` 把正常路由事件适配为 `message_delivery`；`manager/codexHookContext.ts` 把 Codex lifecycle Hook 适配为 session、prompt、推理期触发和计划任务 `Stop` 完成事件。上下文事件通过 `routing/roleKnowledgeContext.ts` 生成同一份“记忆与计划”视图；`Stop` 不进入召回，而是按 `roleKnowledge.ts` 保存的计划 `taskBinding` 精确匹配执行会话，并在私有状态中按 `sessionId + turnId` 去重。

计划完成提醒的实际交接由 `manager/planTaskCompletionDelivery.ts` 负责：选择同人格的唯一 gateway 或计划指定 gateway，拒绝未绑定目标 Codex 任务和源目标同会话，然后写角色面板 timeline 并调用控制面的 `triggerGatewayRolePanelMessage`。后续仍是现有 Forwarding、AgentPacket 和 Agent adapter 主链，目标 Desktop owner、模型、工具和审批没有第二真源。`manager/controlPlaneRoutes.ts` 只负责依赖接线和 HTTP 入口；插件只转发官方 Stop 字段，不能修改计划状态或读取 transcript 猜测完成。双真实 Desktop 任务验收前该能力保持实验状态。

注意：角色知识属于 Agent 上下文，不属于 RouteDecision。不要让路由是否命中依赖记忆内容。

## WebGUI

`ribiwebgui/` 是 Vue + Vuetify 前端。

关键位置：

- `src/stores/gatewayStore.ts`：调用 manager HTTP 接口并维护配置状态。
- `src/pages/RoleKnowledgePage.vue`：通过 `/api/roles/:roleId/plans` 和 `/memory` 展示当前人格计划与记忆；计划主体只读，Manager 声明的审批步骤可通过 plan feedback API 追加意见。
- `src/pages/OverviewPage.vue`：总览和运行状态。
- `src/pages/RouteConfigPage.vue`：Route 配置编辑。
- `src/pages/RuntimeLogPage.vue`：运行日志。
- `src/pages/PersonaTemplatePage.vue`：人格和模板相关页面。
- `src/components/PersonaAvatar.vue`：WebGUI 统一头像展示与首字回退；上传和文件安全由 Manager 负责。
- `src/utils/gatewayHelpers.ts`：前端配置辅助函数。
- `src/speech/speechControlClient.ts`：浏览器语音 HTTP Adapter；唯一知道 `/api/speech/*` 路径和 `{ code, data }` envelope 的前端 Module。
- `src/stores/speechStore.ts`：语音控制 read model、命令和共享事件流生命周期；RabiSpeech `/v1/events` 经 Manager `/api/speech/events` 推送麦克风、播放、音频流和记录落盘变化。每类事件只刷新自己的 read model，SSE 重连才做一次快照补漏，ASR 主机监视器与其他语音卡片不再周期请求后端。
- `src/i18n/index.ts`：唯一 locale 状态、浏览器偏好持久化、`<html lang>` 和切换事件。
- `src/i18n/catalog.ts`：人工校准的英文界面词条和动态文案规则。
- `src/i18n/domLocalizer.ts`：把已登记界面文案应用到 Vue / Vuetify DOM；跳过 `data-no-i18n`、代码块、输入正文和可编辑内容。
- `src/components/LocaleSwitcher.vue`：顶栏 `中 / EN` 切换入口。
- `src/pages/ProjectDocsPage.vue`：加载并渲染 `docs/user-guide/*.md`，提供双语任务导航、全文搜索、本页目录和可分享的 `?page=` 深链接；开发者 Markdown 通过仓库链接继续保持独立事实源。

前端可以做 UI 友好的默认值和展示转换，但配置不变量不要只存在前端。需要和后端一致的规则应进入 `src/shared/gatewayConfigModel.ts` 或由 manager 返回。

人格头像的文件读写、类型校验、内容寻址与原子配置切换集中在 `src/personaAvatar.ts`；`src/manager/personaAvatarRoutes.ts` 负责 `/api/roles/:roleId/avatar` 和表现 DTO，`controlPlaneRoutes.ts` 只注册路由。WebGUI 和 Qt 都通过 Manager HTTP 读取头像；Qt 不再通过本地 `RoleContextRepository` 读取人格目录。头像是人格展示元数据，不进入 AgentPacket，也不改变路由匹配或处理端投递。

语音控制链路采用明确的前后端分离：

```text
SpeechServicePage / SpeechHostMonitor
  -> frontend speech store
  -> frontend speech client Adapter
  -> Manager speech Interface
  -> manager/speechControl.ts
  -> localSpeechClient Adapter
  -> RabiSpeech Python implementation
```

`src/shared/speechControlContract.ts` 是 Manager 与 WebGUI 之间的稳定 camelCase Interface，也拥有 Route 语音默认值。`src/manager/speechControl.ts` 负责 Route policy、RabiSpeech payload 映射和 read model 正规化。`POST /api/speech/messages` 会等待 Gateway 子任务返回真实终态：Desktop owner `start/steer` 成功才是 `delivered`，关键词模式未命中则是 `recorded`，失败为 4xx/5xx；它不等 Agent 回答、Outbox 或 TTS 播放结束。Python 的 snake_case、模型进程状态和回环地址不能泄漏回 Vue 页面；RabiSpeech 仍是独立的回环 Provider Runtime，不合并进 Manager。本地 Provider 默认启用；外部 API Provider 必须在本机配置显式启用、从环境变量取密钥，并通过 capability 的 `local_only` / `relay_safe` 暴露边界。

`src/manager/speechEventProxy.ts` 单独拥有 Manager SSE 客户端与 RabiSpeech 上游流的一对一生命周期。浏览器或验收客户端断开时只中止对应的上游 fetch；由此产生的 `AbortError` 是正常终态，必须在代理层消费，不能变成未处理 Node stream error 或拖垮 Manager。上游不是 `text/event-stream` 时在写入 SSE 响应头之前失败关闭，不把旧 Manager/WebGUI HTML 冒充事件流。

Route 的 `speechPushMode` 是语音投递策略真源：`hot` 在每段 ASR 完成后立即进入普通 `start/steer` 链；`keyword` 仍写入 ASR 账本，仅命中人格 `speechTriggerKeywords` 时唤醒。空关键词不会回退热投递。

主机级波形、五段链路、计数器、运行事件和最近转写只放在“语音服务 → ASR”的 `SpeechHostMonitor`。Route 的“消息适配器 → 语音消息端”只显示该 Route 的订阅策略：热投递/人格关键词、人格 TTS 摘要、主机与人格职责说明、Agent 回复自动播放，以及单次 ASR 广播说明；不得再次嵌入主机监视器。

locale 只允许作为浏览器侧 UI 偏好缓存，键为 `rabiroute:webgui:locale`，不是正式项目存档。route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据属于用户配置或运行事实，必须保持原文；需要保护的动态区域使用 `data-no-i18n` 明确标注。

## Desktop Tray

`desktop/tray-task-window/` 是 Windows 托盘和任务窗口。

它主要负责：

- 启动 / 退出 manager。
- 打开任务窗口。
- 展示角色计划与记忆。
- 和 manager HTTP 接口通信。

它不是 RabiRoute 的事实源。任务、记忆、配置仍应落在 `data/` 和 manager 后端。

托盘和 RibiWebGUI 使用同一个 Manager 后端。Manager 先通过 `roleKnowledgePresentation.ts` 生成计划显示状态、审批能力及统一排序；两端只渲染 API DTO 和既有顺序。`DesktopRefreshService` 无 Qt 依赖，只通过 `ManagerClient` 调用 `/gateways?summary=1`、`/api/roles/:roleId/plans`、`/memory`、`/role-panel/messages` 和 `/avatar`，再生成 DTO；审批提交使用同一 `ManagerClient` 的 plan feedback API，并通过 `qt_async` 在后台等待。托盘正式运行链路不导入 `PlanRepository` 或 `RoleContextRepository`，不直接读取 `data/`。`qt_async` 是不含业务语义的通用线程池桥，`tray_app` 只负责 UI 组合、用户事件和缓存应用。隐藏面板不请求聊天/头像或重建 QWidget，菜单显示期间延迟应用刷新结果，未变化时不重建菜单或面板，超过 5 项的人格入口延迟到子菜单展开时创建。Windows 不注册隐式 `setContextMenu`；表现层 `TrayMenuController` 将左键 `Trigger` 和右键 `Context` 统一映射到已预热菜单的非阻塞 `QMenu.popup()`，双击不重复打开。短暂失败可保留并标记旧快照，Manager 真正离线时不得用缓存伪装在线。

## Plugin Adapters

语音原始消息把整段 RMS 与峰值作为 PCM 响度事实，从 RabiSpeech 贯穿 `SpeechIngressStore`、Route 事件、人格 `voice-transcripts.jsonl` 和 `conversation/current.jsonl`。两项字段只服务阈值、质量和故障诊断，不参与主机身份或“谁是用户”的判断；人格仍是声纹关系的唯一解释者。关闭前置缓冲也不改变音频归属：`pre_roll_ms=0` 时触发 VAD 的第一块 PCM 仍必须进入当前语段。

`plugin-adapters/` 放外部平台桥接示例：

- `napcat-rabiroute`
- `xiaoai-rabiroute`
- `rabi-speech`：独立回环 TTS / ASR Provider 服务插件；不属于消息端或 Agent 端，Manager 只代理其回环 HTTP API。Provider registry 可同时登记本地 worker、OpenAI 兼容 API 和 DashScope 原生 API；本地默认与显式云端选择不能混成自动回退。

RabiSpeech 的 `AudioTranscoder` 是所有 Provider、人格 TTS 与直接 HTTP 调用共用的成品音频准备入口。WAV 只改变采样率时使用 NumPy + SoundFile 本地重采样，不依赖宿主进程的 PATH；跨格式转换才调用显式配置或可发现的 ffmpeg。调用方与单个 Provider 不得各自维护第二套输出重采样规则。

RabiSpeech 的模型基准仍归插件自身：`scripts/benchmark_models.py` 按 TTS → WAV → ASR 顺序采集原始数据，`benchmarks/` 保存公开语料、功能元数据和无外部依赖的 HTML 模板，`skills/benchmark-rabispeech-models/` 固定操作与验收顺序。生成后的公开报告进入 `ribiwebgui/public/reports/`，由 Vite 复制到 WebGUI 静态产物；本机 Manager 和 RabiLink Relay 分别在本机根路径与已认证的远端 PC 前缀下提供 `reports/`。运行期 WAV、JSON、CSV 和日志不进入前端或仓库。

实时能力页归控制面：`src/manager/speechServiceStatus.ts` 只允许探测回环 RabiSpeech，并删去配置路径、模型目录等私有字段；`src/manager/speechControl.ts` 再把模型、麦克风、播放、音频流选择、持久化语音记录和消息命令统一映射到 `speechControlContract`。`GET /api/speech/status` 把规范化结果交给 frontend speech store。音频流默认使用本机声卡；启用局域网 `remote_audio` 后，`remote_audio.py` 通过独立鉴权 WebSocket 把远端客户端当成纯麦克风/喇叭，客户端不拥有 VAD、切句或模型，断线也不自动回退。主机播放音量由 RabiSpeech 持久化并通过播放状态返回，WebGUI 的全局播放队列卡只经 Manager 更新该 `0–100` 值；每条音频开始播放时冻结当时的音量，因此调整会从下一条开始播放的音频生效，不属于 Route 或人格。主机麦克风、ASR 模型、VAD 和切句参数同样只归 RabiSpeech，语音服务页经 Manager 统一维护；Route 页的语音消息端总开关只是订阅真源。Manager 对每段主机 ASR 只接收一次，然后广播给全部已订阅 Route；各 Route 独立执行热投递/人格关键词与回复播放策略。关闭一个 Route 只删除自身订阅，最后一个订阅关闭后 Manager 才停止麦克风。人格目录下的 `voice/voice-profile.json` 是 TTS 模型、声线、语言、语速和表达指令的唯一真源，旧 Route TTS 字段只作兼容读取。因此左侧“语音服务”显示当前电脑事实，项目文档和静态 HTML 则保留某次目标测试机基准，两者不能混成同一数据源。

RabiSpeech 的 `speech_records.py` 是 ASR/TTS 文本记录唯一真源，参考芬妮笔记按日追加运行文件。`tts_audio_store.py` 单独拥有可重建的 TTS 音频缓存：已解析人格的成品进入 `data/roles/<RoleId>/voice/cache/tts-audio/`，非人格直接调用进入 RabiSpeech 私有 fallback；两者默认按各自 mtime 保留 24 小时。Manager 的 read model 只允许 POSIX 风格安全相对引用，兼容旧记录的单文件名，并省略绝对路径、父级穿越和反斜杠路径。WebGUI 在 ASR 页面内嵌最近持久化双向记录，显示相对缓存位置和预计过期时间；它不把路径做成文件链接，也不提供独立会议记录、选择或导出工作流。缓存超过保留窗口不改变文本记录，ASR 原始录音仍默认不复制。

`speaker_profiles.py` 拥有主机共用的人物资料与 `recordId + speakerLabel` 人工绑定；`speaker_recognition.py` 独立拥有本地神经 embedding、已确认多原型和未知聚类。供应商的 `0/1` 绝不沿常驻麦克风 `sessionId` 继承，也不再拥有声纹采样分组解释权：同一 Provider 标签跨多个不连续时间 turn 时，原始值保留在 `speaker`，声纹层生成逐 turn `speakerLabel`、分别提取 embedding，再由不透明 cluster 判断这些 turn 是同一声音还是不同声音。这样错误标签不会把不同人的音频拼成一个样本，而真正同一声音仍会收敛到同一 voiceprint。WebGUI 下拉只修正当前录音 turn，但会把该 turn embedding 标为已确认原型；后续匹配同时要求有效语音时长、最高相似度和第一/第二名差距，低置信度保持 unknown。原始注册音频不复制，向量只写入 Git 忽略的 `output/speaker-embeddings.json` 且不进入公开 API。模型存在但本机阈值尚未验证时只开放聚类和候选提示；正式自动绑定同时要求 `validated=true`、`real_person_private` 数据集资格、完整 dataset/policy/model SHA-256 和通过的目标引擎门禁，任何缺失或不一致都会失败关闭并让 `voiceprint.supported=false`。模型由 `scripts/speaker_model_probe.py` 在独立进程先做真实推理；正式提取使用 ONNX Runtime + kaldi-native-fbank 的 16 kHz / 80-bin / global-mean 后端，避开 Windows sherpa native 对官方模型的格式误判。embedding 仓库分别限制人工确认原型和未确认样本，并拒绝低 RMS 或明显跨说话人重叠片段。

`src/speechIngressStore.ts` 是 RabiRoute 主机级语音原始消息真源。RabiSpeech 把一次 ASR 的稳定 record ID、采集开始/完成/接收时间、Provider、模型、语言、时长、峰值、采样率、声道、音频格式、通道、稳定来源设备、临时音频流 ID、完整说话人分段和可用的逐词时间/置信度一次性交给 Manager；`src/shared/speechTranscript.ts` 是 Python snake_case、HTTP 返回和人格账本共用的可移植分段/逐词规范化入口，`src/routing/speechIngressForwarding.ts` 则是主机原始记录转成 `speech/rabilink` Route 事件的唯一字段映射入口。Manager 会删除主机人物名称、资料 ID、候选资料 ID 和已验证人物标志，只保留不透明声纹/聚类 ID、分段标签、分数、判定证据和逐词时间，再追加 `data/speech/messages/YYYY-MM-DD.jsonl`；相同清洗会在写入和读取人格 `conversation/current.jsonl` 时再次执行，旧记录也不能把主机人物判断重新注入人格上下文。`recordId` 检查与原始消息追加共用跨进程锁，Route receipt 日文件也串行追加，保证并发补交不产生重复或交错 JSONL。ASR 处理链与消息端类型分离：本机麦克风或普通 Rabi 语音客户端生成 `messageAdapterType=speech`，Android 手机/眼镜通过 Relay 持续传有序 PCM，在主机完成 VAD/切句/ASR/声纹后生成 `messageAdapterType=rabilink`；Android 不保存第二套 ASR/VAD 真源。`sourceDeviceId` 是稳定回复目标，`sourceStreamId` 只表示本次 PCM 连接，不能参与下行设备寻址。流序号必须从 1 连续递增；Android 只在 PC 确认后推进序号，待确认块的稳定 `chunkId` 在临时流重建后仍不变。RabiSpeech 按每个稳定 `sourceDeviceId` 保留最后一个已接收 chunk 的 `chunkId + PCM SHA-256`，只保存标识与哈希；ACK 丢失后的跨流重发不会再次进入 VAD/ASR，后续新 chunk 则按新流序号继续推进。Android 的系统网络回调与既有 RabiLink SSE `ready` 事件会立即唤醒待确认 PCM，只有服务端暂时不可用时使用一次性退避；有界最新音频缓冲会丢弃长断网期间的过旧 PCM，使恢复后追上实时流而不是永久滞后。`start` 和每个成功 chunk 都重置一次性 15 秒到期事件，到期后才回收虚拟客户端并恢复之前的音频输入，不做固定间隔扫描。Manager 只投给启用了对应消息端的 Route。`routeProfileId` 是通用 Route 选择器，不是来源类型；来源身份由 `routeKind/adapterType` 决定，手机语音不能因带 `routeProfileId` 被解释成角色面板。`forwarding.ts` 继续负责每个 Route 的人格对应关系，因此不同人格分别写 `voice-transcripts.jsonl` 和 `conversation/current.jsonl`，同一人格目录不会因多 Route 重复记录；首次写入时先初始化/追加统一会话账本，再写兼容原始历史，避免当前事件被旧历史迁移重复导入。手机流以 `routeKind=rabilink` 进入 Agent，回复 API 默认按 `sourceDeviceId` 回原设备；声纹对应谁、谁是用户以及是否需要响应，都由各人格结合自己的关系和上下文解释。

移动端下行的事实拥有权同样分层：Relay 拥有消息、明确目标和设备回执；手机拥有 cursor、可靠队列、本机播放编排、“消息连接是否应在重启后恢复”的持久意图，以及用户请求的 `PAUSED / PHONE / GLASSES` 单一模式真源；前台 Service 拥有实际运行模式、采集和连接状态；眼镜只拥有自身外设状态与扬声器播放完成事实。切换模式时 Service 先释放旧采集端，眼镜连接事件到达前或断线后保持暂停，绝不静默启用双路麦克风。Activity 通过 `RUNTIME_UPDATED` 广播重建运行卡片，不轮询业务状态。明确主动性偏好作为 `rabilink.preference` observation 和来源元数据可靠传输；App 与 Relay 不拥有介入规则。手机私有文字、控制、媒体、回执和下行队列统一使用 fsync 后原子替换，启动清理临时文件并把坏 JSON、缺失二进制和孤立附件隔离为可见错误，单个毒化项不能阻塞后续队列。`/api/rabilink/events` 的 `outbox_available` 只作事件唤醒，Android 随后用持久 cursor 查询一次增量补漏。Android 已知断网时，SSE 连接和可靠队列发送阻塞在由系统 Connectivity callback 驱动的事件门，不再固定间隔重连；仅为防止厂商漏发已注册回调，前台服务在已知离线期间每五分钟只检查一次 OS 当前网络，恢复后立即停止并回到 SSE `ready → cursor` 单次补漏，不查询 Relay 业务状态。仅网络可用但服务端失败时使用一次性 1–30 秒退避。Relay 每 15 秒发送 SSE keepalive；Android 45 秒收不到任何 SSE 字节时触发传输层停滞 deadline，重建半开连接并回到同一单次 cursor 补漏，不增加业务轮询。消息连接恢复意图与持续聆听分离：已启动的文字/媒体/下行服务会在进程或设备重启后恢复 cursor 和可靠队列，明确停止才清除恢复意图。明确 `targetDeviceIds` 的 Outbox 消息在所有目标回 `delivered` 前不按 TTL 清理；广播和仅按设备类型的消息继续受有限 TTL 约束。`delivered` 不代表 `played`：手机和眼镜分别只在自己的 `AudioTrack` marker 到达后产生 `played`，回执先落手机私有磁盘队列再补传，Relay 只持久化和发布 `outbox_receipt`。眼镜的 BEGIN、PCM 与 END 共用有序 Classic BT，避免结束控制越过音频；播放线程会等主线程确认采集暂停后才接受 PCM，Activity 销毁时未完成播放回 `playback_failed`。旧无帧协议 PCM 可兼容播放，但不得生成成功回执。

`src/acceptance/speechIngressSeparation.ts` 与 `scripts/test-speech-ingress-separation.mjs` 把上述边界组合成构建产物隔离验收。工具在临时数据根中向同一个主机原始库写入一条 PC 麦克风记录和一条手机记录，再分别调用真实 `dist/index.js --speech-message` 子进程；它要求主机库恰好保留两个逻辑消息端、两个不同人格各写一次语音历史与统一会话、PC 上下文不出现手机目标、手机回复只使用稳定 `sourceDeviceId` 而不使用临时 `sourceStreamId`，并验证主机人物猜测没有进入人格文件。子进程只使用不打开窗口/剪贴板的隔离 Agent adapter，不连接真实 Manager、Desktop、QQ 或 Relay；完成后删除临时目录，只留下脱敏数量、哈希和终态证据。

`src/personaVoiceIdentities.ts` 拥有人格级声纹关系事件。主机语音消息与 AgentPacket 只提供 `sourceHostId/sourceHostName` 和不透明声纹证据；人格通过 `/api/roles/:roleId/voice-identities` 把自己的 `displayName/relationship/isUser/aliases/notes` 追加到 `voice/voice-identities.jsonl`。身份键由处理主机与声纹 ID 共同构成，避免多 PC 本地 cluster 碰撞。相同更新不重复追加，修正与删除使用新事件/tombstone，不产生 Manager 侧人物真源。新事件通过 `supersedes` 记录它收敛的当前事件头；多 PC 并发分支在 JSONL union 后仍同时存在，读取层派生冲突字段，后续人格 PUT 再显式收敛全部头，因此不会退化为文件顺序决定身份。

`src/personaVoiceTranscriptView.ts` 是人格语音关系的只读联结层，`src/manager/personaVoiceTranscriptRoutes.ts` 只负责稳定 HTTP 边界。`GET /api/roles/:roleId/voice-transcripts` 在查询时把会话账本的原始声纹证据与当前人格关系合成 `user/other/unknown/conflict` 分段视图；它支持时间、归档和说话人筛选，并从完整筛选集合派生分类时长、覆盖率和未解决声纹汇总，明细 `limit` 不截断 `matchedCount` 或 summary。该层不回写任何派生名称、`isUser` 或统计，因此原始消息与人格解释继续保持各自唯一真源。

RibiWebGUI 通过 `personaVoiceIdentityClient.ts` 复用这两个 API，不新增浏览器声纹仓库。人格页的最近 24 小时面板使用 `includeDetails=false`，只接收 summary 和独立关系列表，不接收转写正文；加载、按钮忙碌、错误和提示属于短暂表现状态。`personaVoiceConfirmation.ts` 只维护一次用户主动确认会话的开始时间、开始时未解决声纹的 `lastSeenAt` 基线、等待/找到状态和候选复合键；候选来自下一次语音记录事件后相对基线新出现或再次出现、且有稳定主机标识的未解决声纹，只改变排序与标记，不产生或保存身份结论。页面进入、人格切换和人工操作后查询一次，并监听 RabiSpeech `records_changed`、Manager `persona_voice_identity_changed` 与 `persona_sync_manifest_changed` 事件。SSE 重连只补查一次，不运行覆盖率轮询。

`src/personaSync.ts` 只负责本地人格文件读取、归档、合并与显式冲突解决；`src/personaSyncManifestIndex.ts` 拥有可重建的持久化 manifest 索引、启动一次性校准和运行期递归文件事件。校准以大小、mtime、ctime 和文件标识复用未变化 SHA-256，明确文件事件只重算单路径；索引变化经 Manager SSE 发出 `persona_sync_manifest_changed`。manifest 查询只读索引，只有宿主无法提供可靠文件事件时才在查询前做一次校准，不运行固定周期扫描。`src/personaSyncCoordinator.ts` 负责 peer 发现、传输编排和已解决版本发布；`src/personaSyncAutoReconciler.ts` 只拥有事件调度和 `auto-sync-state.json` 待对账标记，不复制任何合并规则。它把本机文件变化、Relay `ready` 和 `persona_sync_peer_changed` 当作唤醒信号，短时间事件合并后调用 Coordinator 做一次全量或单人格 manifest 对账；peer 离线时等待下一事件，在线临时失败时只做有界一次性退避。`src/manager/personaSyncRoutes.ts` 维护受控 HTTP 合同，并通过仅回环 `index-status/auto-status` 暴露不含正文的诊断；`src/manager/personaSyncLanServer.ts` 是默认绑定私有 IPv4 的独立数据面 listener，只允许远端访问 manifest、file 和 merge，不暴露完整 Manager/WebGUI。同步器优先访问 Relay 登记的这个专用 LAN URL，失败后调用 Relay 的 `/api/rabilink/persona-sync/proxy`，复用全局 worker 把受限请求送到目标 PC 回环 Manager。Relay 不保存主人格。JSONL 使用集合合并，普通文件使用按应用 token 哈希作用域与稳定 peer GUID 分域的共同哈希做快进；已有共同基线的单边缺失作为删除双向传播并先归档旧文件，删除与编辑并发则携带 `remoteDeleted`、peer 和基线哈希进入 `data/persona-sync/conflicts/`。列表、证据读取与 `keep_local/use_remote/use_merged` 解决 API 只允许回环访问；解决时校验当前本地哈希，`use_remote` 对删除冲突表示确认删除，旧证据与元数据进入 `resolved-conflicts/` 并留下审计记录。随后 Coordinator 以冲突远端哈希为新发布基线，把解决结果经 LAN/Relay 发回来源 peer；远端或本地已变化时返回 `not_published`，保留新的待对账标记而不声称收敛。同 peer/人格并发同步 single-flight，文件与基线状态锁定后原子写。`conversation/` 合并复用消息上下文锁，语音记录和人格声纹关系复用各自文件锁，避免同步覆盖与在线追加交错。读取和 merge 检查完整父路径链并拒绝符号链接/Windows junction。锁、manifest 索引、临时文件和可再生 TTS 缓存不参与同步。

`ribiwebgui/src/components/PersonaSyncCard.vue` 只维护页面加载、预览、按钮忙碌、提示等可重建表现状态。它通过 `personaSyncClient.ts` 读取 peer、索引、自动状态与冲突，并提交显式同步或基础解决命令；同步、删除、冲突、重试和最终收敛含义仍全部由后端拥有。页面监听 `persona_sync_manifest_changed`、`persona_sync_auto_status`、Relay/LAN 状态事件后各补查一次，不设置业务轮询。

`src/acceptance/personaSyncDualNode.ts` 与 `scripts/test-persona-sync-dual-node.mjs` 使用两个临时人格根、真实 Relay Server、真实目标 worker/Manager 数据面和专用 LAN listener 验收该编排。它先证明 LAN-first 的 JSONL/普通文件/删除/声纹语义冲突与解决发布，再只撤掉可达的 peer URL 以强制真实 Relay fallback；报告不保存 token、端口、人格或正文。Relay stdout 与 worker SSE 状态事件拥有就绪时序，不用轮询服务状态。

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
