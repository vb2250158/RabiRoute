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

先在 Grok Bot 中登录。Windows 发现只读当前 active 账号的受保护资料，使用原 Windows 用户解密；凭据仅在客户端内存中用于原服务请求，不写回 profile，不输出到日志或扫描结果。

| Route 字段 | 环境变量 | 用途 |
| --- | --- | --- |
| `grokBotProfilePath` | `GROK_BOT_PROFILE_PATH` | 登录资料目录；省略时使用当前用户的 `%APPDATA%/Grok Bot` |
| `grokBotBackendUrl` | `GROK_BOT_BACKEND_URL` | 原生 cloud owner 的完整 HTTP(S) 地址 |
| `grokBotAgentId` | `GROK_BOT_AGENT_ID` | 当前账号拥有的 Bot owner ID |
| `grokBotSessionId` | `GROK_BOT_SESSION_ID` | 扫描返回的完整会话 ID |
| `grokBotSessionName` | `GROK_BOT_SESSION_NAME` | 会话显示名称，不承担身份 |

当前安装版合同的默认 cloud API 地址是 `https://api2.cursor.sh/`，可显式配置已验证的服务地址。这是产品 backend 地址，与 Rabi Manager 地址不同。Manager 地址仍从当前 Host/READY 发现并核对 `/meta`，不固定端口。

显式扫描已有 Bot 和会话：

```http
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot
GET <managerBaseUrl>/api/scan/agents/grokBot
GET <managerBaseUrl>/api/scan/agents?agentAdapter=grokBot&grokBotAgentId=<URL编码的owner ID>&grokBotLimit=100&grokBotOffset=0&grokBotQuery=<URL编码的Bot名称>
```

从 `agents.grokBot.sessions` 选择原会话，保存 `id` 与 `name`。`sessionPage.hasMore/nextOffset` 用于继续分页，参数是 `grokBotOffset`，不使用 `cursor`。扫描不会创建 Bot、会话或 routine；空列表时回到 Grok Bot 核对原账号和已有会话。

普通会话的完整 ID为 `grokBot:` 加 `base64url(JSON([ownerAgentId,nativeSessionId]))`；原生默认主会话使用 `base64url(JSON([ownerAgentId,{"defaultMain":true}]))`，同样带 `grokBot:` 前缀。底层空会话 ID仅在默认主会话显式标记、真实 owner 列表和聊天记录核验后使用；公共 `sourceThreadId` 和 `messageSource.sessionId` 始终必须是非空的完整 ID。接入方只复制扫描返回值，不自行编码、拼接或猜测标识。Route 的 `grokBotAgentId` 必须与该 ID内的 owner 一致。

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

已有会话支持发现、读取和精确投递。当前原生 API没有 create、rename 或 open 操作，对应请求明确失败；必须选择真正已有的会话。计划协助会话、消息处理 Agent 池、记忆整理、Hooks 和自动回执恢复能力均未声明。

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

## 会话复用与未知结果

有效会话 ID直接复用。创建、消息受理和回答完成分别记录，不因第一轮投递超时创建替代会话。重复请求保留原投递 ID及完整载荷；同 ID不同载荷应拒绝。

HTTP 202 或 `delivery_unconfirmed` 保留原请求。调用 `reconcile_delivery` 查询同一 owner 的原投递证据，不再次启动 Bot turn。无可读取证据时保留未确认状态。

调用方的 `deliveryId` 是幂等键；Manager 会按真实来源生成 `agent-<64位小写十六进制>` 投递编号。回传与核销使用响应中的原编号，不用自行重算。Codex Desktop 保留结构化消息里的该编号。历史消息若额外带有单个 UUID 投递尾段，恢复仍须匹配原结构化编号、完整正文哈希、目标 owner 和认证代次；正文改动、引用文本及重复尾段不能成为回执。

验收记录分别确认：Rabi 受理、Grok owner 受理、Bot 完成回答、Rabi 回传受理和目标收到结果。单次 HTTP 成功只证明对应一段。

## 验收要求

- 连续两次投递复用同一个真实 Bot 会话；目标名称变化不改变会话身份。
- Bot 使用自己的来源身份向 Codex 投递，并按原请求返回正式回复。
- QQ 消息经 Route 到 Bot，再经原 NapCat 实例返回正确群/私聊并引用原消息。
- 同投递 ID的重复请求只受理一次；载荷冲突、错会话、错 owner 和错回复 request 被拒绝。
- 超时、重启和迟到回执保留原请求；Bot 或 Desktop 离线时失败关闭。
- 匹配测试、构建及受管运行版本核验完成后，保存实际验收范围；真实往返缺项时保持实验成熟度。

外部消息测试使用已明确授权的原目标。没有具体群、私聊或持久任务目标授权时，先用本地测试端验证请求、拒绝和恢复合同。
