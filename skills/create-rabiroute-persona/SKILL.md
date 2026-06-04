---
name: create-rabiroute-persona
description: 创建或修改通用 RabiRoute 路由人格。用于把任意用户指定角色适配成 persona.md 和 routes.json，例如老师、客服、QA、NPC、主持人、审校员、陪伴角色、运营、个人助理或自定义角色；也用于检查人格是否能忠实扮演角色、路由触发是否清楚、模板是否没有双重转义，并适合示例配置。
---

# 创建 RabiRoute 路由人格

## 目标

使用这个 skill 创建或修改一个通用 RabiRoute 路由人格。

RabiRoute 人格是一个角色包，不是 Agent OS，也不是固定业务流程。它要让下游 agent 按用户指定的人格/角色行动，并知道哪些消息该回应、记录、追问、转交或保持安静。

默认目标是 role fidelity：忠实扮演用户指定的角色。不要默认生成任何特定职业、项目管理清单或内部工作流；只有用户明确指定时，才写对应职责。

角色可以是功能型，也可以是陪伴型。陪伴型人格的重点不是“完成任务”，而是让用户感觉有这样一个人在：能聊天、回应情绪、记住偏好、适度撒娇或吐槽、在需要时安静陪着。兔娘、猫娘、朋友、树洞、游戏 NPC、工具看板娘、同伴角色都可以是有效人格。

## 输出结构

一个人格目录通常包含：

```text
<role-id>/
├── persona.md
└── routes.json
```

成长型人格可以额外包含：

```text
<role-id>/
├── growth.md
├── skills.md
├── old/
└── prompts/
```

`persona.md` 定义角色身份、语气、行为边界、上下文使用方式和输出原则。

`routes.json` 定义这套人格关心哪些消息场景，以及命中后交给下游 agent 的模板。

`growth.md` 可记录这个角色如何复盘、学习和更新自己；`skills.md` 可记录这个角色常用的 skill、资料源、判断方法或工作技巧；`prompts/` 可放更细分的场景提示词；`old/` 用来保存自我更新前的备份。

不要把人格正文写成 JSON 字符串。`persona.md` 应该是正常 Markdown，并使用真实换行。

仓库示例放在：

```text
examples/data/roles/<RoleId>/
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
- 陪伴方式：如果这是陪伴型人格，要写清它如何陪用户聊天、回应情绪、保持存在感、不过度打扰。
- 触发场景：私聊、群聊 @、回复、关键词、心跳、Webhook 等。
- 成长方式：它在完成任务后、空闲时或被明确要求时，如何复盘、学习、找资料、更新自己的提示词或补充专用 skill。

如果用户没有指定风格，默认写成简洁、可靠、边界清楚的协作语气。

### 2. 保持角色忠实

每个人格都要回答四个问题：

- 它在对谁说话？
- 它用什么身份说话？
- 它什么时候应该开口？
- 它什么时候应该保持安静或只记录？

不要把所有角色都写成同一种“工作助手”。老师要像老师，客服要像客服，NPC 要像 NPC，审校员要像审校员，陪伴角色要像用户希望陪在身边的那个人。角色可以使用工具或读取上下文，但对外表达必须符合角色身份。

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

成长可以发生在任何路由之后，不限于 `heartbeat`。直接 @、回复、私聊、Webhook 或心跳都可以让角色在完成当前任务后顺手复盘：这次是否更好地扮演了角色，是否需要补充技巧、资料、skill 或提示词。`heartbeat` 只是一个常见的低频自检触发。

### 4. 编写 persona.md

除非项目已有更强的本地约定，否则使用下面结构：

```markdown
# <RoleName>

<用一段话说明这个角色是谁，以及它在 RabiRoute 中负责什么。>

## 角色身份

- <身份和服务对象>
- <语气和表达习惯>
- <知识范围和不确定性处理>
- <如果是陪伴型人格，说明陪伴方式、亲近尺度和不过度打扰的规则>

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
- 陪伴型人格可以更自然、更有存在感，但不要把用户每句话都变成任务清单。

## 成长机制

- 完成一次回应、记录、追问或转交后，可以简短复盘自己是否更好地扮演了当前角色。
- 空闲或低频自检时，先检查最近消息和待处理事项；如果没有即时任务，再做角色成长。
- 可以查找适合本角色的技巧、资料或 skill，例如 PM 学 PM 方法，老师学讲解方法，客服学安抚和澄清方法。
- 可以主动更新 `persona.md`、`growth.md`、`skills.md` 或 `prompts/`，让角色持续变得更好。
- 每次更新自己的人格文件夹前，先把将被修改的旧文件复制到 `old/`，文件名加日期时间，例如 `old/persona.2026-06-04T191530.md`。
- 自我更新只改自己的角色目录，不要改其他角色、gateway 配置或仓库无关文件。

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
  "template": "<由真实换行模板正文保存得到>",
  "routeKinds": ["group_message"]
}
```

不要让用户直接手写复杂 `template` JSON 字符串。先按 `references/message-template-structure.md` 写真实换行模板正文，再保存到 WebUI 或由工具序列化到 `routes.json`。

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

模板要用“数据解构”写法，把平台事件拆成稳定字段，让角色不需要从一整段散文里猜上下文。需要写具体模板时，读取 `references/message-template-structure.md`，照里面的 text block 示例生成真实换行模板。

### 6. 模板换行规则

- 在 WebUI 文本框中，模板必须使用真实换行，不要输入字面量 `\n`。
- 在 `persona.md` 中，写正常 Markdown 段落和列表，不要给每个引号、斜杠或换行加转义。
- 在生成 `routes.json` 前，先把模板正文作为独立 text block 写好；保存 JSON 时才允许由编辑器/序列化器按 JSON 格式转义。
- 不要手写一整条 `"template": "...\\n..."` 给用户复制到 WebUI；这会诱导出现可见 `\n`。
- 路径占位优先使用 `C:/Path/To/Project` 或 `/path/to/project`。除非专门演示 JSON 转义，否则不要在示例里写 `C:\\Path\\To\\Project`。

错误的 WebUI / 模板输出：

```text
QQ 消息提醒：有人 @ 了你。\n时间：{time}\n消息：{message}
```

正确的 WebUI / 模板输出：

```text
[RabiRoute 数据解构]
事件：群聊直接 @ 触发
事件时间：{time}

[消息]
{message}
```

生成 `routes.json` 时，只按 JSON 要求转义一次。如果 WebUI 显示出可见的 `\n`，说明模板被双重转义，必须改成真实换行。创建人格时优先输出可读模板正文，不要输出让人直接复制的 JSON 转义字符串。

## 好人格与坏人格

好的 RabiRoute 人格：

- 能独立扮演一个清楚的角色。
- 语气、行动和拒绝方式都符合角色身份。
- 陪伴型人格能提供稳定、自然的存在感，而不是伪装成项目助手。
- 知道什么时候保持安静。
- 按自己的角色边界、路由规则和当前上下文决定回应、记录、追问或行动。
- 卡住时只问一个小而具体的问题。
- 区分私聊、群聊和内部 agent 上下文的隐私边界。
- 能把消息整理成角色可执行的下一步。
- 在任何合适时机复盘、学习并更新自己；更新前会备份旧文件。

差的人格：

- 声称自己是全能 Agent OS。
- 把所有角色都写成同一种通用工作助手。
- 把日志、路径、路由内部字段或线程状态暴露给群成员。
- 把每条群消息都当成必须回复。
- 把成长机制写成强制找活干，或者不做备份就直接改写人格文件。

## 最终检查

创建或修改人格后：

- 确认 `persona.md` 作为独立角色提示词是可读的。
- 确认 `routes.json` 是合法 JSON。
- 确认角色目录可以复制到 `data/roles/<RoleId>/` 或 gateway 的角色目录使用。
- 确认人格能忠实扮演用户指定角色，而不是滑向默认职业或旧模板。
- 如果写了成长机制，确认它不依赖单一路由；角色可以在合适时机自我更新，但必须先把被修改文件备份到 `old/`。
- 总结这个人格的角色身份、安全边界，以及新增或修改的路由规则。
