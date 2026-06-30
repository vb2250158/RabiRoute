# 企业微信接入

企业微信接入优先面向群聊机器人场景。RabiRoute 计划使用企业微信智能机器人 WebSocket 长连接 SDK，把企业微信群聊消息接入为和 NapCat 类似的双向消息端：本地 gateway 主动连接企业微信，收到群消息后写入日志、路由给 Agent，Agent 再通过 RabiRoute outbox 回发到原企业微信群聊或明确指定的企业微信会话。

这个接入不使用传统企业微信自建应用 HTTP 回调验签方案。传统回调需要公网 URL、签名校验、XML/密文解包，更适合企业内部应用事件；RabiRoute 这里需要的是类似 NapCat 的本地常驻消息网关，因此使用 `@wecom/aibot-node-sdk` 的 WebSocket 长连接路线。

## 接入形态

```text
企业微信群聊
  -> 企业微信智能机器人 WebSocket
  -> RabiRoute wecom adapter
  -> wecom-messages.jsonl / wecom-adapter.log.jsonl
  -> forwarding / RouteDecision
  -> AgentPacket / replyContextJson
  -> Agent adapter
  -> POST /api/agent/replies
  -> outbox
  -> 企业微信群聊
```

`wecom` 和 `napcat` 的定位一致，都是消息端 adapter。区别是：

- `napcat` 监听本地 WebSocket，NapCat 主动连进来；发送时调用 OneBot HTTP。
- `wecom` 主动连企业微信 WebSocket；发送时复用同一个企业微信智能机器人 SDK。
- `wecom` 默认以群聊为主，模板变量尽量对齐 NapCat 群聊变量。

## 配置示例

```json
{
  "enabled": true,
  "messageAdapters": ["wecom", "heartbeat"],
  "messageAdapterPolicies": {
    "wecom": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"]
    }
  },
  "pipelinePreset": "wecom_chat",
  "pipeline": {
    "inputAdapter": "wecom",
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "promptOutputMode": "markdown",
    "preventFeedbackLoop": true,
    "replyToSource": true
  },
  "wecomBotId": "${WECOM_BOT_ID}",
  "wecomBotSecret": "${WECOM_BOT_SECRET}",
  "wecomWsUrl": "${WECOM_WS_URL}",
  "codexThreadName": "企业微信消息监听",
  "codexCwd": "C:/Path/To/Your/Project",
  "agentAdapters": ["codex"],
  "dataDir": "./data/route/wecom",
  "configName": "wecom",
  "agentRoleId": "Rabi",
  "rolesDir": "./data/roles"
}
```

`wecomBotId`、`wecomBotSecret` 和 `wecomWsUrl` 可以写在 `adapterConfig.json`，也可以由环境变量提供：

```text
WECOM_BOT_ID=<企业微信智能机器人 Bot ID>
WECOM_BOT_SECRET=<企业微信智能机器人 Secret>
WECOM_WS_URL=<可选：私有部署或调试 WebSocket 地址>
```

公开示例只允许使用占位值。不要把真实企业微信机器人 ID、secret、群聊内容、企业内部人员 ID 或私有会话 ID 写进仓库。

## 群聊字段与模板变量

企业微信群聊模板变量应尽量复用 NapCat 群聊习惯，减少同一人格模板的分叉。

通用变量：

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {sender} {senderName}
{message} {rawMessage} {routeText} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {routeProfileId} {routeProfileName}
{agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath}
{replyApiUrl} {replyContextJson}
{inputAdapter} {outputAdapter} {outputPipeline} {replyToSource}
```

企业微信专用变量：

```text
{wecomReqId}
{wecomConversationId}
{wecomChatId}
{wecomSenderId}
{wecomMessageType}
```

变量映射原则：

- `{groupId}`：企业微信群聊或会话 ID，优先等于 `{wecomChatId}`，没有 chat id 时回退到 `{wecomConversationId}`。
- `{userId}`：发送者企业微信用户 ID，等于 `{wecomSenderId}`。
- `{sender}` / `{senderName}`：发送者展示名；没有展示名时回退到 `{userId}`。
- `{messageId}`：RabiRoute 内部消息 ID，优先用企业微信消息 ID，没有时用 `reqId` 或本地生成 ID。
- `{repliedMessageId}`：企业微信引用/回复消息 ID；SDK 暂不提供时为空。
- `{messageTarget}`：形如 `企业微信群 <groupId>`，便于 Agent 直接识别来源。

推荐模板：

```text
[RabiRoute 数据解构]
事件：企业微信群聊消息
路由类型：{routeKind}
事件时间：{time}
当前时间：{currentTime}

[来源]
目标：{messageTarget}
群号：{groupId}
企业微信会话：{wecomConversationId}
企业微信 Chat：{wecomChatId}
发送者：{sender}
用户：{userId}
消息 ID：{messageId}
请求 ID：{wecomReqId}
消息类型：{wecomMessageType}

[消息]
{message}

[上下文]
企业微信消息日志：{groupLogPath}
角色目录：{agentRoleDir}
输出通道：{outputAdapter}
回复来源：{replyToSource}

[回传]
普通回复 API：{replyApiUrl}
当前回复上下文：{replyContextJson}

[行动]
请按 persona.md 中的角色身份判断是否需要回应、记录、追问或行动。需要普通聊天回复时，把回复交给 RabiRoute 普通回复 API，不要直接调用企业微信 SDK。
```

## Route Kind

v1 以一个专用 route kind 表达企业微信消息：

```text
wecom_message
```

`wecom_message` 覆盖企业微信群聊里的普通文本、Markdown、混合消息以及后续可规范化的图片/文件/语音消息。规则层可以通过 `regex` 区分关键词触发：

```json
{
  "id": "wecom-group-rabi",
  "name": "企业微信群聊 Rabi 触发",
  "enabled": true,
  "routeKinds": ["wecom_message"],
  "targetGroupId": "",
  "regex": "Rabi|RabiRoute|帮我|总结|记录|提醒",
  "template": "<使用上方企业微信群聊模板>"
}
```

`targetGroupId` 对企业微信同样使用 `{groupId}` 的值。这样规则过滤群聊时可以和 NapCat 群号过滤保持同一套语义。

## 回复与主动发送

Agent 不直接调用企业微信 SDK。普通回复仍然走 RabiRoute 的统一回传接口：

```http
POST /api/agent/replies
```

回复当前来源消息：

```json
{
  "text": "收到，我来整理一下。",
  "replyContext": {
    "adapterType": "wecom",
    "routeKind": "wecom_message",
    "targetType": "group",
    "messageId": "wecom-msg-001",
    "groupId": "wrCHATID",
    "userId": "zhangsan",
    "wecomReqId": "REQ_ID",
    "wecomConversationId": "CONVERSATION_ID",
    "wecomChatId": "wrCHATID",
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "replyToSource": true
  }
}
```

主动发送到明确企业微信群：

```json
{
  "text": "项目提醒：今天 18:00 前请同步阻塞项。",
  "targetType": "group",
  "groupId": "wrCHATID",
  "adapterType": "wecom",
  "replyContext": {
    "outputAdapter": "wecom",
    "outputPipeline": "wecom",
    "replyToSource": false
  }
}
```

发送前必须检查当前路由的 `messageAdapterPolicies.wecom.outputEnabled` 和 `supportedOutputs`。关闭发送、缺少明确目标、缺少企业微信 bot secret、SDK 返回发送限制或目标不可达时，outbox 返回 `blocked` / `failed`，并写入 `outbox-adapter.log.jsonl`。

## 日志与状态

企业微信接入应写入：

```text
data/route/<configName>/wecom-messages.jsonl
data/route/<configName>/wecom-adapter.log.jsonl
data/route/<configName>/outbox-adapter.log.jsonl
```

`wecom-messages.jsonl` 的记录至少包含：

```json
{
  "time": 1780000000,
  "adapterType": "wecom",
  "messageId": "wecom-msg-001",
  "reqId": "REQ_ID",
  "conversationId": "CONVERSATION_ID",
  "chatId": "wrCHATID",
  "groupId": "wrCHATID",
  "senderId": "zhangsan",
  "userId": "zhangsan",
  "senderName": "张三",
  "rawMessage": "Rabi 帮我总结一下这段讨论",
  "messageType": "text",
  "segments": [],
  "isSelf": false,
  "raw": {}
}
```

`gateway-status.json` 中应维护 `messageAdapters.wecom`：

```json
{
  "type": "wecom",
  "status": "running",
  "connected": true,
  "authenticated": true,
  "lastMessageAt": "2026-06-30T12:00:00.000Z",
  "messageCount": 12,
  "lastError": ""
}
```

## 实现边界

- `wecom` 是独立消息端，不复用 `webhook`。
- 企业微信群聊变量要尽量对齐 NapCat 群聊变量，专用字段只作为补充。
- Adapter 只做协议翻译、日志和入口判断，不拼 Agent prompt。
- Prompt 和 `replyContextJson` 仍由 `src/routing/agentPacket.ts` 生成。
- 出站发送必须走 `src/outbox.ts`，不能从 adapter 收消息 handler 里直接发。
- 公开文档和示例不能包含真实企业微信 secret、企业内部人员 ID 或真实群聊内容。
