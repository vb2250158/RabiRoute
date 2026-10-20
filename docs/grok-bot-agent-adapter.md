<!-- docs-language-switch -->
<div align="center">
<a href="./grok-bot-agent-adapter_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Grok Bot Agent 端接入

面向接入开发者和本机运维者。`grokBot` 是消息路线（Route）的处理端：RabiRoute 把消息交给已有 Grok Bot 服务，服务在自己的会话中回答，再通过 Rabi 接口回传。

**状态：实验实现。** 已在 Grok Bot 0.70.2 的安装版服务合同中核对原生 cloud owner，并通过当前登录状态完成真实 Agent 列表只读查询。真实双向消息、同会话复用、超时恢复和目标运行版本分别验收；能力声明保持 `experimental`。

## owner 与传输选择

会话的实际执行者（owner）是已有 Grok cloud 服务。RabiRoute 使用同一 owner 的原生 HTTP API 精确读取和投递会话，不创建第二个 Grok Runtime，也不把 Grok 会话声明为 Codex Desktop 任务。

Grok 的 routine webhook 会启动 routine run，不能指定原会话继续一轮，因此不承担本接入的精确会话投递。接入使用现有登录和会话服务，不以新建 routine 或 webhook key 代替会话身份。

原生服务 API 依赖安装版合同，升级后须复核发现、认证、会话读取和投递响应。账号、Bot 标识、会话 ID、受保护登录资料和消息正文只保存在本机运行数据，公开示例使用占位值。

## 配置与发现

先启动并登录 Grok Bot。Windows 发现只读当前 active 账号的受保护资料，使用原 Windows 用户解密；凭据仅在客户端内存中用于原服务请求，不写回 profile，不输出到日志或扫描结果。

| Route 字段 | 环境变量 | 用途 |
| --- | --- | --- |
| `grokBotAgentId` | `GROK_BOT_AGENT_ID` | 当前账号拥有的 Bot owner ID |
| `grokBotSessionId` | `GROK_BOT_SESSION_ID` | 扫描返回的完整会话 ID |
| `grokBotSessionName` | `GROK_BOT_SESSION_NAME` | 会话显示名称，不承担身份 |

服务地址由原生接入合同自动取得（`https://api2.cursor.sh/`），不再提供编辑入口。资料目录自动使用当前 Windows 用户的 Grok Bot 目录，并以只读信息显示。旧 Route、查询参数和环境变量中的连接覆盖值不再用于发现或投递；保存规范化会移除旧地址和目录字段。这是产品 backend 地址，与 Rabi Manager 地址不同。Manager 地址仍从当前 Host/READY 发现并核对 `/meta`，不固定端口。

在 Route 的 Agent 设置中选择“主角色 Bot”，RabiRoute 会绑定该 Bot 已发现的默认主会话，并将 Grok Bot 设为主控 Agent；无需填写会话 ID 或目录。桌面应用必须保持运行，只有残留登录文件不能完成鉴权。进入设置时自动发现一次；稍后才启动或登录时，点击“刷新 Grok Bot”。发现只读登录资料，不替 Grok Bot 写入或刷新凭据。

显式扫描已有 Bot 和会话：

```http
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot
GET <managerBaseUrl>/api/scan/agents/grokBot
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot&grokBotAgentId=<URL编码的owner ID>&grokBotLimit=100&grokBotOffset=0&grokBotQuery=<URL编码的Bot名称>
```

从 `agents.grokBot.sessions` 选择原会话，保存 `id` 与 `name`。`sessionPage.hasMore/nextOffset` 用于继续分页，参数是 `grokBotOffset`，不使用 `cursor`。扫描不会创建 Bot、会话或 routine；空列表时回到 Grok Bot 核对原账号和已有会话。

普通私聊会话的完整 ID为 `grokBot:` 加 `base64url(JSON([ownerAgentId,nativeSessionId]))`；原生默认主会话使用 `base64url(JSON([ownerAgentId,{"defaultMain":true}]))`，同样带 `grokBot:` 前缀。默认主会话须经真实 roster 核验；Temporal 私聊还需聊天记录核验，ROOM 群地址由 roster 直接证明，不借用私聊会话。公共 `sourceThreadId` 和 `messageSource.sessionId` 始终必须是非空的完整 ID。接入方只复制扫描返回值，不自行编码、拼接或猜测标识。Route 的 `grokBotAgentId` 必须与该 ID内的 owner 一致。

已保存的群身份地址也可以是同前缀的 `base64url(JSON([senderAgentId,groupId]))`，不带 `defaultMain`。这是 **roster-backed 群地址**，不是 `listSessions(sender)` 返回的私聊 session。`deliveryType=group` 时，原生 roster 必须证明 `groupId` 是 ROOM、`senderAgentId` 是真实 AGENT 且属于该群，并与显式 `fromAgentId` 一致。发送调用 `SendGrokBotAgentMessage`，原生 `toAgentId=groupId`、`fromAgentId=senderAgentId`；journal 回执保留原 sender/group tuple，核销将该 tuple 映射到群原生主地址查询同一 messageId。失败不向 sender 私聊发送，也不改回默认会话。

列表请求可携带已保存的 `threadId`。通过 roster 成员校验后，群行保留这个完整 ID，`nativeAgentId/nativeAgentName` 仍描述群的真实 ID/名称，`kind/memberAgentIds` 原样提供；列表展示不能把该地址改写成私聊或默认主会话。扫描提供的群 owner/defaultMain 形式仍兼容。以上协议单测与真实群投递验收分别记录。

Route 配置片段：

```json
{
  "agentAdapter": "grokBot",
  "grokBotAgentId": "<scan返回的owner ID>",
  "grokBotSessionId": "<scan返回的完整grokBot会话 ID>",
  "grokBotSessionName": "Integration Bot session"
}
```

## 能力与操作边界

| 元数据 | 当前值 |
| --- | --- |
| `type` | `grokBot` |
| `maturity` | `experimental` |
| `transport` | `{ "protocol": "http", "mode": "grok-bot-owner" }` |
| `host` | `{ "name": "Grok Bot cloud owner", "required": true }` |
| `capabilities.managedTasks` | 仅 `agentThreads=true` |

已有会话支持发现、读取和精确投递。当前原生 API没有 create、rename 或 open 操作，对应请求明确失败；必须选择真正已有的会话。这只限制 Grok Bot 自己的会话。已核验的 Bot 来源可以创建 Codex 或 DSH 会话：`action=create`，顶层 `agentAdapter` 为 `codex` 或 `dsh`，`messageSource` 使用 `type=agent`、`agentAdapter=grokBot`，`sessionId` 与 `sourceThreadId` 都等于扫描返回的完整 Bot 会话 ID。Manager 用 owner 名称覆盖提交的 `sessionName`。不能用线程桥新建、重命名或打开一个 Grok 会话。计划协助会话、消息处理 Agent 池、记忆整理、Hooks 和自动回执恢复能力均未声明。

服务端点使用 `kind=service`。Owner 接入、状态和认证读取不自动遍历全部会话；只有显式扫描或精确会话操作读取对应列表。Bot owner 及当前账号变更后必须重新核对原会话，不把同名对象或新账号当作原请求的继任者。

## 来源与回传

顶层 `agentAdapter` 和 `threadId` 选择接收方；`messageSource.agentAdapter`、`messageSource.sessionId` 与 `sourceThreadId` 描述真实发送方。Bot 发起请求时使用 `type=agent`、`agentAdapter=grokBot`，来源 ID必须由 Bot owner 确认。

会话 ID是完整的不透明标识。原样保存 owner 返回值，不截断，不从格式推测 provider，不借用接收方 Codex ID，不以名称或显示标题代替身份。已鉴权请求上下文带有来源身份时，正文声明必须与该身份一致。

两类回传分别使用已有 Rabi 接口：

| 原消息 | 回传接口 | 必须保留 |
| --- | --- | --- |
| QQ → Grok Bot | `POST /api/agent/send`，`channel=napcat` | 原 Route、NapCat 实例、群/私聊目标、引用消息和稳定投递 ID |
| Codex → Grok Bot | `POST /api/agent/threads`，`action=send` | 原 Codex 任务、Bot 自己的来源会话，正式回复的 `inReplyToRequestId/result/nextAction` |

`/api/agent/send` 发送消息渠道，不提供 `channel=grokBot`。完整请求、正式回复和来源失败说明见 [Rabi Agent 接口](rabi-agent-interfaces.md)。

Codex → Bot 的精确投递示例：

```json
{
  "action": "send",
  "agentAdapter": "grokBot",
  "threadId": "<scan返回的目标Bot完整会话 ID>",
  "deliveryId": "codex-to-bot-check-001",
  "prompt": "请确认收到本次接入复测消息。",
  "sourceThreadId": "<真实来源Codex完整会话 ID>",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "<真实来源Codex完整会话 ID>",
    "sessionName": "Integration check task"
  },
  "responsePolicy": "none"
}
```

需要 Bot 正式回传时，将 `responsePolicy` 改为 `required` 并填写 `responseInstruction`。Bot 回复时交换原双方目标/来源，来源使用扫描返回的 Bot 完整 ID，带回原 `inReplyToRequestId/result/nextAction`。调用方仍使用同一已鉴权 Rabi 连接，不能用消息正文建立第二层认证。

Bot 发起 Codex 会话的 `create` 示例：

```json
{
  "action": "create",
  "agentAdapter": "codex",
  "title": "Bot 发起的任务",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "prompt": "请处理这件新任务。",
  "sourceThreadId": "<scan 返回的来源 Bot 完整会话 ID>",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "grokBot",
    "sessionId": "<scan 返回的来源 Bot 完整会话 ID>",
    "sessionName": "任意旧名称，会被 owner 名称覆盖"
  }
}
```

DSH 目标使用 `"agentAdapter": "dsh"`，来源字段相同。完整合同见 [Rabi Agent 接口](rabi-agent-interfaces.md)。

## 会话复用与未知结果

### 规则动作中的私聊、群与发送身份

状态：源码实现；安装版须完成兼容热补丁及运行验收后才能使用。部署基线不支持时，不绕过补丁兼容检查；用户明确要求先迁移配置文件时，分别报告文件回读与运行生效结果。

指定身份的群地址也可保存为 `grokBot:` + `base64url(JSON([发送Bot的ID,群ID]))`。它由当前原生群目录与成员关系验证，不冒充该 Bot 的私聊会话；发送时将群 ID 用作 `toAgentId`、发送 Bot 用作 `fromAgentId`，核销仍寻址同一个群。界面只保留 Manager 核验后的完整地址，不自行从显示名推算。

选择“自定义”投递目标后，配置顺序为：Grok Bot Agent → 会话类型（私聊 / 群）→ 目标会话或群 → 发送方式（直接发送 / 通过指定身份发送）→ 身份。群和身份均来自当前账号原生目录；名称不替代 ID。

`action.target` 保持 `kind=session`、`agentTargetId`、`agentAdapter=grokBot`、完整 `sessionId`、`sessionName` 和空 `workspace`，增加 `deliveryType=private|group`、`sendMode=direct|identity`。指定身份额外保存 `senderAgentId`、`senderAgentName`；直接发送不保留身份字段。切换类型或目标后重新核对身份。

此显式模式把规则模板渲染结果作为正文，不附加角色提示词或控制块。例如 `{sender}({userId}) : {message}` 生成 `Example(123) : hello`。指定身份通过 `SendGrokBotAgentMessage` 直接寻址目标群，不先通知 Bot 默认私聊。缺少目标、身份失效或结果未知时不回退默认会话。

`POST /api/agent/threads` 的 `send` / `reconcile_delivery` 请求携带 `grokBotDelivery: {deliveryType, sendMode, senderAgentId?}`、原 `threadId` 和稳定 `deliveryId`。结果未知时核对原回执，不换键重发。保存、服务受理及目标群显示分别验收；真实双向链路未验收前保持实验状态。

公共服务投递桥也必须核验群地址与成员关系，并将发送方式、身份保存到每次投递的不可变执行选项及其摘要中；不能只在发现列表或独立发送 helper 中支持这些字段。原生群地址有效但公共入口返回 `GROK_BOT_SESSION_NOT_FOUND` 时，检查公共投递桥是否仍把群 ID 当成发送 Bot 的私聊会话。不要改回默认私聊，也不要用定时通知 Bot 再转发作为补偿。

反向消息使用已有 NapCat 渠道的 QQ 群目标。上述选项不会自动创建 Grok 入站订阅；必须另行核对 Grok 来源、群过滤、QQ 目标及防回环，不能用 Bot 私聊转发指令代替直通。

有效会话 ID直接复用。创建、消息受理和回答完成分别记录，不因第一轮投递超时创建替代会话。重复请求保留原投递 ID及完整载荷；同 ID不同载荷应拒绝。

HTTP 202 或 `delivery_unconfirmed` 保留原请求。调用 `reconcile_delivery` 查询同一 owner 的原投递证据，不再次启动 Bot turn。无可读取证据时保留未确认状态。

普通 Agent 端点互投中，调用方的 `deliveryId` 是幂等键；Manager 会按真实来源生成 `agent-<64位小写十六进制>` 投递编号。显式原生投递模式的 `delivery.deliveryId` 保留调用方原键，`messageId` 是对应的原生幂等编号。回传与核销使用所属模式响应中的原编号，不用自行重算或混用。Codex Desktop 保留结构化消息里的该编号。历史消息若额外带有单个 UUID 投递尾段，恢复仍须匹配原结构化编号、完整正文哈希、目标 owner 和认证代次；正文改动、引用文本及重复尾段不能成为回执。

验收记录分别确认：Rabi 受理、Grok owner 受理、Bot 完成回答、Rabi 回传受理和目标收到结果。单次 HTTP 成功只证明对应一段。

## 验收要求

- 连续两次投递复用同一个真实 Bot 会话；目标名称变化不改变会话身份。
- Bot 使用自己的来源身份向 Codex 投递，并按原请求返回正式回复。
- QQ 消息经 Route 到 Bot，再经原 NapCat 实例返回正确群/私聊并引用原消息。
- 同投递 ID的重复请求只受理一次；载荷冲突、错会话、错 owner 和错回复 request 被拒绝。
- 超时、重启和迟到回执保留原请求；Bot 或 Desktop 离线时失败关闭。
- 匹配测试、构建及受管运行版本核验完成后，保存实际验收范围；真实往返缺项时保持实验成熟度。

外部消息测试使用已明确授权的原目标。没有具体群、私聊或持久任务目标授权时，先用本地测试端验证请求、拒绝和恢复合同。
