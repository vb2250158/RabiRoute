---
name: create-rabiroute-persona
description: 创建或修改通用 RabiRoute 路由人格。用于把任意用户指定角色适配成 persona.md 和 routes.json，例如老师、客服、QA、NPC、主持人、审校员、陪伴角色、运营、个人助理或自定义角色；也用于检查人格是否能忠实扮演角色、路由触发是否清楚、模板是否没有双重转义，并适合示例配置。
---

# 创建 RabiRoute 路由人格

## 目标

使用这个 skill 创建或修改一个通用 RabiRoute 路由人格。

RabiRoute 人格是一个角色包，不是 Agent OS，也不是固定业务流程。它要让下游 agent 按用户指定的人格/角色行动，并知道哪些消息该回应、记录、追问、转交或保持安静。

默认目标是 role fidelity：忠实扮演用户指定的角色。不要默认生成任何特定职业、项目管理清单或内部工作流；只有用户明确指定时，才写对应职责。

## 输出结构

一个人格目录通常包含：

```text
<role-id>/
├── persona.md
└── routes.json
```

`persona.md` 定义角色身份、语气、行为边界、上下文使用方式和输出原则。

`routes.json` 定义这套人格关心哪些消息场景，以及命中后交给下游 agent 的模板。

不要把人格正文写成 JSON 字符串。`persona.md` 应该是正常 Markdown，并使用真实换行。

仓库示例放在：

```text
examples/roles/<RoleId>/
```

本地或私有 gateway 使用的人格放在：

```text
data/roles/<RoleId>/
```

不要提交私有 `data/` 人格内容，除非用户明确要求，并且内容已经脱敏。

## 创建流程

### 1. 明确角色

先提取或确认这些信息：

- 角色身份：它是谁，面向谁服务。
- 角色语气：正式、温和、活泼、沉稳、角色扮演、短句优先等。
- 角色知识：它知道什么、不知道什么、什么时候必须承认不确定。
- 可做事项：回答、总结、记录、追问、翻译、审校、安抚、讲解、生成草稿、转交处理端等。
- 禁止事项：不能暴露什么，不能承诺什么，不能直接执行什么。
- 触发场景：私聊、群聊 @、回复、关键词、心跳、Webhook 等。

如果用户没有指定风格，默认写成简洁、可靠、边界清楚的协作语气。

### 2. 保持角色忠实

每个人格都要回答四个问题：

- 它在对谁说话？
- 它用什么身份说话？
- 它什么时候应该开口？
- 它什么时候应该保持安静或只记录？

不要把所有角色都写成同一种“工作助手”。老师要像老师，客服要像客服，NPC 要像 NPC，审校员要像审校员。角色可以使用工具或读取上下文，但对外表达必须符合角色身份。

### 3. 定义路由场景

至少说明这些 route kind 的行为：

- `private`
- `direct_at`
- `direct_reply`
- `indirect_reply`
- `group_message`
- `heartbeat`
- `voice_transcript`（如果使用语音或 Webhook 文本）

不需要每一类都写很长，但必须清楚说明：哪些场景要回应，哪些只记录，哪些需要补问，哪些要交给下游 agent 继续处理。

### 4. 编写 persona.md

除非项目已有更强的本地约定，否则使用下面结构：

```markdown
# <RoleName>

<用一段话说明这个角色是谁，以及它在 RabiRoute 中负责什么。>

## 角色身份

- <身份和服务对象>
- <语气和表达习惯>
- <知识范围和不确定性处理>

## 路由判断

- 私聊消息：...
- 群聊 @：...
- 直接回复：...
- 间接回复：...
- 群聊普通消息：...
- 定时触发：...
- Webhook 文本：...

## 处理动作

- 需要回应：...
- 需要记录：...
- 需要追问：...
- 需要转交：...
- 只需观察：...
- 风险动作：...

## 输出口径

- 对外回复要像这个角色本人在说话。
- 内部总结可以更结构化，但不要泄露给群成员。
- 卡住时只问一个最小、具体的问题。

## 安全边界

- <隐私和密钥规则>
- <审批和执行规则>
- <公开/私有边界规则>
```

人格说明要具体，不要只写“乐于助人”“专业高效”这类泛泛口号。

### 5. 编写 routes.json

最小结构：

```json
{
  "routeName": "<RoleName> 路由",
  "notificationRules": []
}
```

单条规则示例：

```json
{
  "id": "<stable-kebab-id>",
  "name": "<可读名称>",
  "enabled": true,
  "targetGroupId": "",
  "regex": "<可选正则>",
  "template": "<发给下游 agent 的提示>",
  "routeKinds": ["group_message"]
}
```

支持的 route kind：

```text
private
direct_at
direct_reply
indirect_reply
group_message
heartbeat
voice_transcript
```

常用模板变量：

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

`{time}` 表示消息或事件发生时间；`{now}` / `{currentTime}` 表示模板渲染时的当前本地时间。需要日期判断时优先使用 `{currentDate}`、`{currentWeekday}`、`{currentHour}` 等内置变量，不要让下游 agent 自己猜。

模板要把平台事件翻译成角色能理解的触发场景，而不是把内部字段堆给角色。

示例：

```text
QQ 消息提醒：有人在群聊中直接 @ 了你。
时间：{time}
目标：{messageTarget}
发送者：{sender}
消息：{message}

请按 persona.md 中的角色身份判断是否需要回应。需要上下文时读取 {groupLogPath}，不要在对外回复中暴露日志路径。
```

### 6. 模板换行规则

- 在 WebUI 文本框中，模板必须使用真实换行，不要输入字面量 `\n`。
- 在 `persona.md` 中，写正常 Markdown 段落和列表，不要给每个引号、斜杠或换行加转义。
- 在 `routes.json` 中，JSON 字符串出现 `\n` 是格式要求。不要把 JSON 转义后的模板原样复制回 WebUI。
- 路径占位优先使用 `C:/Path/To/Project` 或 `/path/to/project`。除非专门演示 JSON 转义，否则不要在示例里写 `C:\\Path\\To\\Project`。

错误的 WebUI / 模板输出：

```text
QQ 消息提醒：有人 @ 了你。\n时间：{time}\n消息：{message}
```

正确的 WebUI / 模板输出：

```text
QQ 消息提醒：有人 @ 了你。
时间：{time}
消息：{message}
```

生成 `routes.json` 时，只按 JSON 要求转义一次。如果 WebUI 显示出可见的 `\n`，说明模板被双重转义，必须改成真实换行。

## 好人格与坏人格

好的 RabiRoute 人格：

- 能独立扮演一个清楚的角色。
- 语气、行动和拒绝方式都符合角色身份。
- 知道什么时候保持安静。
- 默认生成草稿或内部判断，除非明确授权对外发送。
- 卡住时只问一个小而具体的问题。
- 区分私聊、群聊和内部 agent 上下文的隐私边界。
- 能把消息整理成角色可执行的下一步。

差的人格：

- 声称自己是全能 Agent OS。
- 把所有角色都写成同一种通用工作助手。
- 把日志、路径、路由内部字段或线程状态暴露给群成员。
- 把每条群消息都当成必须回复。

## 最终检查

创建或修改人格后：

- 确认 `persona.md` 作为独立角色提示词是可读的。
- 确认 `routes.json` 是合法 JSON。
- 确认角色目录可以复制到 `data/roles/<RoleId>/` 或 gateway 的角色目录使用。
- 确认人格能忠实扮演用户指定角色，而不是滑向默认职业或旧模板。
- 总结这个人格的角色身份、安全边界，以及新增或修改的路由规则。
