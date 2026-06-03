# RabiRoute 架构说明

RabiRoute 的定位是 **多入口消息网关 + 策略路由 + 多 Agent 后端分发**。

它不做一个新的完整个人 Agent OS，也不把自己变成某个单一 Agent 的前端壳。RabiRoute 只负责把来自聊天平台、Webhook、定时器或本地工具的事件规范化，然后根据路由规则选择合适的后端 Agent / Workflow / Tool，并把上下文按模板包装后投递出去。

## 一句话定位

```text
RabiRoute 解决：消息该交给谁、怎么包装上下文、注入什么提示词、结果如何回到哪里。
Agent 后端解决：拿到上下文以后怎么思考、怎么执行、怎么调用工具。
```

## 不是什么

RabiRoute 不应该做成：

- `Hermes Lite`：不内置一个完整长期记忆、自主规划、技能生成、cron 和工具系统的大 Agent。
- `cc-connect Lite`：不重复实现完整的 coding agent project / provider / session 管理。
- `AstrBot Lite`：不把所有平台插件、LLM 插件、聊天人格和自动回复都塞进一个聊天机器人框架。
- `Dify / n8n Lite`：不做完整 workflow 平台。

这些系统可以成为 RabiRoute 的后端或集成对象。

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
  Target Driver Registry
        ↓
  Codex Desktop / cc-connect / Hermes Agent / AstrBot / Dify / n8n / Tool Runner
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

负责判断事件是否触发、触发哪个 route kind、交给哪个 target。

当前 QQ 群路由收敛为三类：

- `direct_at`：当前消息直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息。

私聊当前默认触发。

未来路由规则应扩展为可配置 Route DSL：

```yaml
routes:
  - name: code-task
    match:
      platform: qq
      route_kind: [direct_at, direct_reply]
      keywords: ["报错", "代码", "构建", "git"]
    prompt_profile: code-helper
    target: cc-codex

  - name: personal-agent
    match:
      platform: telegram
      chat_type: private
    prompt_profile: personal-assistant
    target: hermes-agent
```

### 4. Prompt / Context Template

负责把路由结果包装成目标 Agent 能理解的输入。

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
- 不同 target 可以有不同 prompt profile。

### 5. Target Driver Registry

负责把包装后的消息投递给不同后端。

当前内置：

- `codexDesktop`：通过 Codex Desktop IPC 投递到固定线程，支持 `start` 和运行中 `steer`。
- `codexApp`：旧 app-server 调试通道，作为旁路验证。

未来目标：

- `ccConnectProject`：把代码任务投递到 cc-connect 的某个 project/session。
- `hermesAgent`：把长期个人助手任务投递到 Hermes Agent。
- `astrbot`：把普通聊天或人格回复交给 AstrBot。
- `dify`：把知识库问答或流程编排交给 Dify。
- `n8n`：把自动化任务交给 n8n workflow。
- `webhook`：通用 HTTP target。
- `toolRunner`：本地脚本或 CLI。

### 6. Session / Turn Control

负责避免连续消息开出多个并行 Agent。

当前 Codex Desktop 规则：

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

- Agent 输出默认不能直接发 QQ 群。
- 群消息、文档写回、Issue 更新、自动化执行都先生成 draft / action。
- 用户确认后再 commit。
- 所有 commit 写 audit log。

## 与 Hermes Agent 的关系

Hermes Agent 更像：

```text
多聊天入口 → Hermes Gateway → Hermes 自己的 AIAgent
```

RabiRoute 应该是：

```text
多聊天入口 → RabiRoute → 多个外部 Agent / Workflow / Tool
```

所以 Hermes Agent 不是 RabiRoute 必须复制的对象，而是一个可以接入的 target：

```text
长期个人助手任务 → Hermes Agent
代码任务 → cc-connect / Codex
普通聊天 → AstrBot
知识库流程 → Dify
自动化 → n8n
```

## 与 cc-connect 的关系

cc-connect 更适合解决：

```text
聊天平台如何控制多个 coding agent project / provider / session / cron。
```

RabiRoute 更适合解决：

```text
一条消息该不该进 coding agent，进哪个 project，用什么 prompt profile，是否需要审批，结果回到哪里。
```

因此 RabiRoute 可以位于 cc-connect 上层或旁路，把 cc-connect 作为 coding target。

## 当前版本的真实架构

```text
NapCat WebSocket Client
  -> RabiRoute gateway
  -> group/private JSONL
  -> QQ route detector
       direct_at / direct_reply / indirect_reply / private
  -> editable templates
  -> forwarding target
       codexDesktop / codexApp
  -> Codex Desktop fixed thread
       start / steer
```

NapCat 插件不是业务核心，它只是控制面入口：

```text
NapCat plugin page
  -> RabiRoute manager API
  -> gateways.json
  -> start / stop / restart gateway process
```

## 后续演进顺序

推荐按这个顺序做，不要一口气做成大平台：

1. 抽象统一 `InboundMessage`，把 QQ / OneBot 事件从核心路由里解耦。
2. 抽象 `RouteDecision`，记录 route kind、target、prompt profile、priority、reason。
3. 抽象 target driver，把 `codexDesktop` 从默认实现变成一个 driver。
4. 增加 `webhook` target，验证非 Codex 后端。
5. 增加 route decision 日志和 replay 页面。
6. 做 Action Queue，所有外部发送和写入先进待审。
7. 再考虑 Hermes / cc-connect / AstrBot / Dify / n8n 等具体集成。

## 架构红线

- 不把平台插件做成全部业务核心。
- 不让 target driver 反向侵入 router。
- 不把 prompt 模板写死在 handler 里。
- 不让 Agent 直接群发或写外部系统，除非显式授权。
- 不把 WebUI 做成项目事实源；项目事实应进入文档、Issue、工单或数据库。
- 不为了一个 target 的需求破坏统一事件模型。
