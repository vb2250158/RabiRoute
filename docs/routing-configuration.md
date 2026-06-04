# 路由配置

路由配置决定一条消息是否转发给处理端，以及用哪段模板把事件交给对应人格或 Agent。

## 配置放在哪里

RabiRoute 支持两种常用方式。

### 角色目录里的 routes.json

推荐把路由规则放在角色目录：

```text
data/<gateway-id>/roles/<RoleId>/routes.json
```

示例：

```text
data/default-main/roles/Rabi/routes.json
data/default-main/roles/QAReviewer/routes.json
data/default-main/roles/DevAssistant/routes.json
```

manager 会把 `rolesDir` 下每个角色的 `routes.json` 组装成 route profile。这样同一个 gateway 可以共享一套 NapCat WS / HTTP，但同时拥有多个人格路由。

### gateway 里的 routeProfiles

也可以在 `data/gateways.json` 里显式写 `routeProfiles`：

```json
{
  "routeProfiles": [
    {
      "id": "rabi",
      "name": "Rabi 路由",
      "agentRoleId": "Rabi",
      "notificationRules": []
    },
    {
      "id": "qa-reviewer",
      "name": "QA 审校路由",
      "agentRoleId": "QAReviewer",
      "notificationRules": []
    }
  ]
}
```

除非需要覆盖角色目录、数据目录或变量，优先使用角色目录里的 `routes.json`。

## routes.json 结构

最小结构：

```json
{
  "routeName": "Rabi 路由",
  "notificationRules": []
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

`template` 不建议手写成一整条 JSON 字符串。先在 WebUI 或文本块里写真实换行模板，再保存到 `routes.json`。

## route kind

- `direct_at`：群聊直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息。
- `group_message`：普通群聊消息，通常配合 `regex` 使用。
- `private`：私聊消息。
- `heartbeat`：定时触发消息。
- `voice_transcript`：Webhook / 语音转写文本。

一条规则可以匹配多个 route kind：

```json
"routeKinds": ["direct_at", "direct_reply", "private"]
```

## regex

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
- 只有保存到 `routes.json` 时，JSON 序列化结果里才应该出现 `\n`。
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
{botNickname} {routeProfileId} {routeProfileName}
{agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath} {heartbeatLogPath}
{heartbeatIntervalSeconds}
```

`{time}` 是消息或事件发生时间；`{now}` / `{currentTime}` 是模板渲染时的当前本地时间。
