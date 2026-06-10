# RabiRoute 架构说明

RabiRoute 的定位是 **多入口消息网关 + 消息分诊台 + 策略调度层**。

它不做一个新的完整个人 Agent OS，也不把自己变成某个单一工具或某一类执行系统的前端壳。RabiRoute 只负责把来自聊天平台、Webhook、定时器或本地工具的事件规范化，判断这条消息是什么类型、该进哪条处理通道、需要带哪些上下文、是否需要审批，然后把它交给合适的处理端。

比较准确的比喻是：

```text
RabiRoute 像分诊台 / 调度台 / 转运中心。

它不亲自治病、不亲自写代码、不亲自跑流程。
它负责接收来件、识别类型、补齐资料、贴上路由单、送到正确窗口，并记录流转过程。
```

## 一句话定位

```text
RabiRoute 解决：消息是什么、该走哪条通道、要带什么上下文、是否需要审批、结果回到哪里。
处理端解决：拿到上下文以后怎么思考、怎么执行、怎么调用工具。
```

## 不是什么

RabiRoute 不应该做成：

- `完整个人 Agent OS Lite`：不内置一个完整长期记忆、自主规划、技能生成、cron 和工具系统的大 Agent。
- `执行桥 Lite`：不重复实现完整的执行项目、provider、session 和 cron 管理。
- `聊天机器人框架 Lite`：不把所有平台插件、LLM 插件、聊天人格和自动回复都塞进一个聊天机器人框架。
- `工作流平台 Lite`：不做完整 workflow 平台。
- `某个具体 AI 工具的外壳`：不把某个处理端当作产品本体。

这些系统都可以成为 RabiRoute 的处理端或集成对象，但它们不是 RabiRoute 的定义。

## 是什么

RabiRoute 应该保持为：

```text
QQ / 微信 / 飞书 / Discord / Slack / Email / Webhook / Scheduler
        ↓
  Platform Adapter
        ↓
  Event Normalize / Store
        ↓
  Route Policy
        ↓
  Prompt / Context Template
        ↓
  Agent Adapter / Handler Registry
        ↓
  Agent / Workflow / Script / Human Queue / External API
        ↓
  Action Queue / Approval / Reply Route
        ↓
  Chat Platform / External System
```

## 核心分层

### 1. Platform Adapter

负责接入外部平台，只处理平台协议和轻量配置发现。

当前实现：

- NapCat / OneBot WebSocket Client 接收 QQ 事件。
- NapCat HTTP Server 用于主动调用 OneBot API。
- NapCat 插件只负责页面入口、配置桥接和启动 manager。

未来可扩展：

- 微信、飞书、Discord、Slack、Telegram、Email、HTTP Webhook。

### 2. Event Store

负责保留原始事件和规范化消息，方便回放、审计和补上下文。

当前实现：

- `data/group-messages.jsonl`
- `data/private-messages.jsonl`
- `data/codex-notifications.jsonl`

未来应补齐：

- `raw-events.jsonl`
- `route-decisions.jsonl`
- 附件缓存索引
- 身份映射和回复链索引

### 3. Router / Policy Engine

负责判断事件是否触发、触发哪个 route kind、交给哪个 Agent 端适配器。

当前 QQ 群路由收敛为三类：

- `direct_at`：当前消息直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息，或继续回复一条已经触发过路由的群聊回复链；是否回应由角色路由和 Agent 自己判断。

私聊当前默认触发。

未来路由规则应扩展为可配置 Route DSL：

```yaml
routes:
  - name: technical-task
    match:
      platform: qq
      route_kind: [direct_at, direct_reply]
      keywords: ["报错", "代码", "构建", "git"]
    prompt_profile: technical-helper
    agent_adapter: workbench-agent

  - name: personal-request
    match:
      platform: telegram
      chat_type: private
    prompt_profile: personal-assistant
    agent_adapter: personal-agent

  - name: risky-action
    match:
      intent: [send_message, write_external_system]
    agent_adapter: human-review
```

### 4. Prompt / Context Template

负责把路由结果包装成处理端能理解的输入。

当前实现：

- 直接 @ 模板。
- 直接回复模板。
- 间接回复模板。
- 私聊模板。

模板变量包含：

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{message} {rawMessage} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {dataDir} {groupLogPath} {privateLogPath}
```

原则：

- 模板不要硬编码在消息 handler 里。
- 用户可见模板直接写清触发语义，不依赖抽象的 `routeReason`。
- 不同处理端可以有不同 prompt profile。

### 5. Agent Adapter / Handler Registry

负责把包装后的消息投递给不同处理端。当前代码里这层叫 Agent 端适配器；处理端可以是 Agent，也可以是 workflow、script、human queue 或 external API。

当前内置：

- `codex`：通过 Codex Desktop IPC 投递到固定线程，支持 `start` 和运行中 `steer`；旧 app-server 通道只作为内部 fallback / 调试能力保留。

未来 Agent 端适配器类型：

- `agent`：把消息交给某个 AI Agent 或 Agent 平台。
- `workflow`：把消息交给自动化流程。
- `script`：调用本地脚本、CLI 或工具函数。
- `humanQueue`：转成人工待处理事项。
- `externalApi`：调用外部系统 API。
- `webhook`：通用 HTTP Agent adapter。
- `toolRunner`：本地脚本或 CLI。

### 6. Session / Turn Control

负责避免连续消息开出多个并行 Agent。

当前 Codex 规则：

- 固定线程名，例如 `QQ 消息监听`。
- 空闲时 `start` 新 turn。
- 运行中用 `steer` 追加引导。
- 短时间多条消息先合并，再投递。
- 如果 `steer` 失败且 active turn 已结束，自动回退到 `start`。

这是 RabiRoute 很重要的边界：它控制“投递时机和会话形态”，但不替 Agent 决定具体答案。

### 7. Action Queue / Approval

负责外部写入和回复发送的安全门。

当前只保留基础发送 API 和 `/ping` 类简单命令。

未来应明确：

- 处理端输出默认不能直接发 QQ 群。
- 群消息、文档写回、Issue 更新、自动化执行都先生成 draft / action。
- 用户确认后再 commit。
- 所有 commit 写 audit log。
- 外发失败时不要只看平台健康状态。像 NapCat `get_status` 仍为 online/good、但 `send_group_msg` 在 QQ 内核 `sendMsg` 阶段返回 `EventChecker Failed` / `1006514` 的情况，应把待发内容保留为 draft，记录失败原因，修复登录态或时间同步后再补发，并记录返回的 `message_id`。

## 与完整个人 Agent OS 的关系

完整个人 Agent OS 更像：

```text
多聊天入口 → 自己的 Gateway → 自己的长期 Agent
```

RabiRoute 应该是：

```text
多聊天入口 → RabiRoute → 多个处理端
```

所以这类系统不是 RabiRoute 必须复制的对象，而是可以接入的处理端：

```text
长期个人助手任务 → 个人 Agent 平台
技术任务 → 工作台 / 执行器通道
普通聊天 → 聊天机器人通道
知识库流程 → 知识库/工作流通道
自动化 → 自动化流程通道
高风险动作 → 人工审批队列
```

## 与执行桥 / 工作台系统的关系

执行桥或工作台系统更适合解决：

```text
具体任务如何运行、如何维护 session、如何调用 provider、如何管理 cron。
```

RabiRoute 更适合解决：

```text
一条消息该不该进入某个处理端，进哪个通道，用什么上下文模板，是否需要审批，结果回到哪里。
```

因此 RabiRoute 可以位于这些系统上层或旁路，把它们作为处理端。

## 当前版本的真实架构

```text
NapCat WebSocket Client
  -> RabiRoute gateway
  -> group/private JSONL
  -> QQ route detector
       direct_at / direct_reply / indirect_reply / private
  -> editable templates
  -> agent adapter
       codex
  -> Codex fixed thread
       start / steer
```

NapCat 插件不是业务核心，它只是控制面入口：

```text
NapCat plugin page
  -> RabiRoute manager API
  -> data/route/*/adapterConfig.json + data/roles/*/personaConfig.json
  -> start / stop / restart route process
```

## 后续演进顺序

推荐按这个顺序做，不要一口气做成大平台：

1. 抽象统一 `InboundMessage`，把 QQ / OneBot 事件从核心路由里解耦。
2. 抽象 `RouteDecision`，记录 route kind、agent adapter、prompt profile、priority、reason。
3. 扩展 Agent adapter / handler driver，把当前内置投递方式从默认实现变成可插拔处理端。
4. 增加 `webhook` Agent adapter，验证非固定 Agent 的处理端。
5. 增加 route decision 日志和 replay 页面。
6. 做 Action Queue，所有外部发送和写入先进待审。
7. 再考虑具体 Agent 平台、执行桥、聊天机器人框架、知识库和工作流系统集成。

## 架构红线

- 不把平台插件做成全部业务核心。
- 不让 Agent adapter / handler driver 反向侵入 router。
- 不把 prompt 模板写死在 handler 里。
- 不让处理端直接群发或写外部系统，除非显式授权。
- 不把 WebUI 做成项目事实源；项目事实应进入文档、Issue、工单或数据库。
- 不为了某个处理端的需求破坏统一事件模型。
