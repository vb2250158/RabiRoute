# 路由配置

路由配置决定一条消息是否转发给处理端，以及用哪段模板把事件交给对应人格或 Agent。

## 配置放在哪里

RabiRoute 支持两种常用方式。

### 角色目录里的 personaConfig.json

消息路由配置跟随路由人格，放在角色目录：

```text
data/roles/<RoleId>/personaConfig.json
```

示例：

```text
data/roles/Rabi/personaConfig.json
data/roles/QAReviewer/personaConfig.json
data/roles/DevAssistant/personaConfig.json
```

manager 会扫描 `data/roles/*/personaConfig.json`。每个文件里可以有多套 `configs`，一套 config 就是一条可启动的消息路由配置。

人格文件仍放在同一个 `data/roles/<RoleId>/`。多个消息路由配置可以使用同一个路由人格，因为它们本来就跟随这个角色文件夹。

路由入口参数来自 `data/route/<配置名>/adapterConfig.json`。manager 会用其中的 `agentRoleId` 找到对应角色，再从该角色的 `personaConfig.json` 中读取相同 `configName` 的规则。没有有效配置时，消息不会投递给处理端。

## personaConfig.json 结构

最小结构：

```json
{
  "configs": [
    {
      "configName": "main",
      "routeVariables": {},
      "notificationRules": []
    }
  ]
}
```

单条规则结构：

```json
{
  "id": "rabi-group-keywords",
  "name": "Rabi 看板娘呼唤",
  "enabled": true,
  "targetGroupId": "",
  "regex": "Rabi|RabiRoute|看板娘|兔娘|陪陪|聊聊|在吗|记一下|提醒",
  "template": "<由真实换行模板正文保存得到>",
  "routeKinds": ["group_message"]
}
```

`template` 不建议手写成一整条 JSON 字符串。先在 WebUI 或文本块里写真实换行模板，再保存到 `personaConfig.json`。

## 路由类型 route kind

- `direct_at`：群聊直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息，或继续回复一条已经触发过路由的群聊回复链。路由层只识别回复链结构，不判断内容是否“值得回”；陪伴型角色可以订阅它来持续接住对话，工作型角色可以不订阅或配合 `regex` 降噪。
- `group_message`：普通群聊消息，通常配合 `regex` 使用。
- `wecom_message`：企业微信群聊消息。它默认使用和 NapCat 群聊接近的模板变量：`groupId` 表示企业微信群聊或 chat id，`userId` 表示发送者企业微信用户 ID，`sender` / `senderName` 表示发送者展示名，额外提供 `wecomReqId`、`wecomConversationId`、`wecomChatId`、`wecomSenderId` 和 `wecomMessageType`。
- `private`：私聊消息。
- `heartbeat`：定时触发消息。
- `manual_trigger`：手动触发事件，例如托盘菜单主动触发某条任务/规则。它不是消息 adapter 类型，也不会伪装成 heartbeat；是否投递仍由规则的 `enabled` 和 `routeKinds` 勾选决定。
- `voice_transcript`：Webhook / 语音转写文本。

## Pipeline 预设 / 通道预设

`adapterConfig.json` 可以额外写 `pipelinePreset` 和 `pipeline`，把默认输入端、输出端、提示词输出模式和 TTS 配置意图打成一组。这个配置不会强行改变旧路由行为；不写时仍按原来的 `messageAdapters`、规则和模板投递。

消息端权限写在同一个配置文件的 `messageAdapterPolicies`。它和 pipeline 是两层：pipeline 表达“这条 route 想往哪里输出”，policy 表达“这个消息端允许不允许接收、发送、主动发、发哪些类型、发到哪些目标”。旧的 `messageInputsDisabled` 和 `messageAdaptersDisabled` 仍兼容，但新配置优先用 policy。

```json
{
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "inputAdapter": "webhook",
    "outputAdapter": "fennenote",
    "outputPipeline": "fennenote",
    "promptOutputMode": "voice_short",
    "ttsProvider": "oumuq",
    "ttsVoice": "cloud_zh_voice",
    "ttsWorkerUrl": "http://127.0.0.1:8793/api/fennenote/playback",
    "ttsPlay": true,
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

内置 preset：

- `qq_chat`：QQ 输入和 QQ 输出意图，适合普通聊天文本。
- `wecom_chat`：企业微信输入和企业微信输出意图，适合企业微信群聊文本/Markdown 回复。
- `voice_chat`：FenneNote/Webhook 输入和 FenneNote 播放请求转发意图，适合短句口语化回复。
- `webhook_task`：Webhook 输入和文件/Markdown 输出意图，适合任务触发。

模板可以读取 `{outputPipeline}`、`{promptOutputMode}`、`{ttsProvider}`、`{ttsVoice}`、`{preventFeedbackLoop}` 和 `{replyToSource}`。语音管道建议要求 Agent 产出一个播放请求 JSON；RabiRoute 的 FenneNote 端只转发文字反写或播放请求，FenneNote 决定 guard、角色播放和后续 OumuQ/worker 调用。

一条规则可以匹配多个 route kind；同一条事件可以命中多条已启用规则，RabiRoute 会逐条投递，不会只取第一条：

```json
"routeKinds": ["direct_at", "direct_reply", "private"]
```

## 正则匹配 regex

`regex` 匹配规范化后的 `routeText`。在间接回复场景中，也会匹配 `repliedRouteText`。

可以在正则里使用变量：

```text
{RobotQQId}
{SenderQQId}
{GroupId}
{ReplyMessageId}
```

常见写法：

```json
"regex": "Rabi|陪陪|提醒|记一下"
```

如果 `regex` 留空，规则会匹配对应的 route kind。普通群消息的 `group_message` 规则通常不要留空，否则会把所有普通群消息都转发。

## 模板规范

模板正文使用“数据解构”写法，把事件拆成稳定字段，避免 agent 从散文里猜上下文。

```text
[RabiRoute 数据解构]
事件：群聊直接 @ 触发
路由类型：{routeKind}
事件时间：{time}
当前时间：{currentTime}

[来源]
目标：{messageTarget}
群号：{groupId}
发送者：{sender}
用户：{userId}
消息 ID：{messageId}

[消息]
{message}

[上下文]
群聊日志：{groupLogPath}
角色目录：{agentRoleDir}

[行动]
请按 persona.md 中的角色身份判断是否需要回应、记录、追问或行动。
```

成长型人格可以加一段：

```text
[成长]
处理完成后，如果发现本角色的表达、知识、判断标准或常用 skill 可以改进，可以更新 {agentRoleDir} 下的人格文件。
更新前先把将被修改的旧文件复制到 {agentRoleDir}/old/，备份文件名加当前日期时间。
```

## 换行规则

- WebUI 文本框里必须是真实换行。
- 不要把模板写成用户要直接复制的 `"template": "...\\n..."` JSON 字符串。
- 只有保存到 `personaConfig.json` 时，JSON 序列化结果里才应该出现 `\n`。
- 如果 WebUI 里显示可见的 `\n`，说明模板被双重转义，必须改成真实换行。

## 常用变量

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{now} {currentTime} {currentDate} {currentClock} {currentIsoTime}
{currentTimestamp} {currentYear} {currentMonth} {currentDay}
{currentWeekday} {currentHour} {currentMinute} {currentSecond}
{groupId} {userId} {selfId} {sender} {senderName}
{RobotQQId} {SenderQQId} {GroupId} {ReplyMessageId}
{message} {rawMessage} {routeText} {repliedRouteText} {messageId}
{repliedMessageId} {repliedMessage}
{wecomReqId} {wecomConversationId} {wecomChatId}
{wecomSenderId} {wecomMessageType}
{botNickname} {routeProfileId} {routeProfileName}
{agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath} {heartbeatLogPath}
{manualTriggerLogPath} {triggerId} {triggerName}
{heartbeatIntervalSeconds}
```

`{time}` 是消息或事件发生时间；`{now}` / `{currentTime}` 是模板渲染时的当前本地时间。
