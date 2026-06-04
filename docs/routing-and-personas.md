# 路由与人格

## 路由规则

路由规则决定一条消息是否转发给处理端，以及使用哪段模板。

```json
{
  "id": "group-direct-at",
  "name": "直接 @ 模板",
  "enabled": true,
  "targetGroupId": "",
  "regex": "",
  "template": "QQ 消息更新提醒：群聊里有人 @ 了机器人。\n时间：{time}\n目标：{messageTarget}\n发送者：{sender}\n消息：{message}\n\n请在需要时读取 {groupLogPath} 查看上下文。",
  "routeKinds": ["direct_at"]
}
```

支持的 route kind：

- `direct_at`：群聊直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息。
- `group_message`：普通群聊消息，通常配合 `regex` 使用。
- `private`：私聊消息。
- `heartbeat`：定时触发消息。

`regex` 会匹配规范化后的 `routeText`，也会在间接回复场景中匹配 `repliedRouteText`。它支持变量展开，例如 `{RobotQQId}`、`{SenderQQId}`、`{GroupId}`、`{ReplyMessageId}`。

## 模板填写规则

- 在 WebUI 的模板文本框里直接换行，不要手写 `\n`。
- 在 `persona.md` 里写 Markdown 正文，不要把整段人格包成 JSON 字符串。
- 只有直接编辑 `routes.json` 或 `data/gateways.json` 时，JSON 字符串内部才会出现 `\n` 和 `\\` 这类转义。
- 路径占位推荐用 `C:/Path/To/Project` 或 `/path/to/project`，避免公开示例里的 JSON 转义被误抄到 WebUI。

如果 WebUI 里看到模板显示成 `消息：{message}\n\n请读取...`，说明模板被双重转义了。保存新版 WebUI 会自动把可见的 `\n` 转成真实换行；手工修时也应直接换行，而不是继续添加反斜杠。

模板常用变量：

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

`{time}` 是消息或事件发生时间；`{now}` / `{currentTime}` 是模板渲染时的当前本地时间。延迟补发或心跳巡检时，推荐同时写清这两个时间。

## 路由人格

RabiRoute 的“人格”不是单独一段 prompt，而是一个角色包。角色包同时决定两件事：

- `persona.md`：这个角色如何说话、如何判断消息、如何整理上下文、哪些事不能做。
- `routes.json`：这个角色关心哪些 route kind、普通群消息用什么关键词触发、命中后给处理端什么模板。

一个角色目录通常包含：

```text
<RoleId>/
├── persona.md
└── routes.json
```

公开示例：

- `examples/roles/Rabi/persona.md`
- `examples/roles/Rabi/routes.json`
- `examples/data/default-main/roles/Rabi/`

Rabi 示例是一个轻量公开样例，主要演示 `persona.md` 和 `routes.json` 如何配合。真实项目可以在本地 `data/<gateway-id>/roles/<RoleId>/` 里扩展更完整的直接 @、回复、私聊、关键词和心跳规则。

一个 gateway 可以同时拥有多个路由人格。每个角色目录里的 `routes.json` 会被 manager 组装成一个 route profile；这些 route profile 共用同一个 gateway 的消息端适配器。

```text
data/default-main/roles/Rabi/routes.json
data/default-main/roles/QAReviewer/routes.json
data/default-main/roles/DevAssistant/routes.json
```

上面三套路由都会使用同一个 NapCat WebSocket 监听端口和同一个 NapCat HTTP 地址。不要为了多个路由人格复制多个 gateway，除非它们真的对应不同 QQ 号、不同平台账号或不同监听端口。

本地使用时，推荐直接复制示例 data 包：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

也可以只复制单个人格到 gateway 的角色目录：

```powershell
mkdir data\default-main\roles
copy examples\roles\Rabi\persona.md data\default-main\roles\Rabi\persona.md
copy examples\roles\Rabi\routes.json data\default-main\roles\Rabi\routes.json
```

然后在 WebUI 的 `路由人格` 中选择 `Rabi`。选择人格后，转发给处理端的提示末尾会追加角色文件路径，消息记录也会写入该角色目录。

项目内还提供了一个开源 skill，用来指导创建新人格：

- `skills/create-rabiroute-persona/SKILL.md`

它说明了如何一起设计 `persona.md` 和 `routes.json`，让角色既有稳定气质，也有对应的路由触发策略。
