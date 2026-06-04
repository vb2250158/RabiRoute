---
name: create-rabiroute-persona
description: 创建或修改 RabiRoute 路由人格。用于设计新人格目录、编写 persona.md、创建 routes.json 路由规则、把已有助手角色适配到 QQ/NapCat/OneBot 路由，或检查人格是否安全、简洁、路由感明确并适合公开示例。
---

# 创建 RabiRoute 路由人格

## 目标

使用这个 skill 创建或修改 RabiRoute 路由人格。

RabiRoute 人格不是一个完整 Agent 实现，而是一个角色包。它告诉下游处理端如何理解被路由过来的消息、用什么语气说话、什么时候回应、记录、追问、转交或等待，以及哪些事不能越界。

除非用户明确要求创建私有本地角色，否则每个人格都应按可公开示例来写。

## 输出结构

一个人格目录通常包含：

```text
<role-id>/
├── persona.md
└── routes.json
```

`persona.md` 定义角色语气、路由行为、输出方式和安全边界。

`routes.json` 定义这套人格的路由名称和可选通知规则。

不要把人格正文写成 JSON 字符串。`persona.md` 应该是正常可读的 Markdown，并使用真实换行。

公开示例放在：

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

先确认：

- 角色名和路由名。
- 服务对象：项目负责人、群聊、运营、QA、PM、客服、个人提醒等。
- 哪些消息应该触发它。
- 它允许做什么：只生成草稿、记录、转交、追问、总结，或在审批后调用工具。
- 它绝不能暴露或执行什么。

如果用户没有指定风格，默认写成简洁、温和、偏工作协作的语气。

### 2. 定义路由感

每个人格都必须说明如何处理这些 route kind：

- `private`
- `direct_at`
- `direct_reply`
- `indirect_reply`
- `group_message`
- `heartbeat`

不需要每一类都写长段落，但必须讲清楚什么时候读取上下文日志、什么时候只记录或保持安静。

### 3. 编写 persona.md

除非项目已有更强的本地约定，否则使用下面结构：

```markdown
# <RoleName>

<用一段话说明这个人格是谁，以及它在 RabiRoute 中负责什么。>

## 回复姿态

- <语气规则>
- <清晰度规则>
- <上下文规则>

## 路由判断

- 私聊消息：...
- 群聊 @：...
- 直接回复：...
- 间接回复：...
- 群聊普通消息：...
- 定时巡检：...

## 处理动作

- 需要回应：...
- 需要记录：...
- 需要转处理端：...
- 需要补信息：...
- 只需观察：...
- 风险动作：...

## 输出口径

<内部总结格式，以及对外回复话术的生成原则。>

## 安全边界

- <密钥和隐私规则>
- <审批规则>
- <公开/私有边界规则>
```

人格说明要具体，不要只写“乐于助人”“专业高效”这类泛泛口号。

### 4. 编写 routes.json

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
  "template": "<发给下游处理端的提示>",
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
```

常用模板变量：

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{RobotQQId} {SenderQQId} {GroupId} {ReplyMessageId}
{message} {rawMessage} {routeText} {repliedRouteText} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath}
```

模板书写规则：

- 在 WebUI 文本框中，模板必须使用真实换行，不要输入字面量 `\n`。
- 在 `persona.md` 中，写正常 Markdown 段落和列表，不要给每个引号、斜杠或换行加转义。
- 在 `routes.json` 中，JSON 字符串出现转义是正常的，但那只是 JSON 格式要求。不要把 JSON 转义后的模板原样复制回 WebUI。
- 公开示例路径优先使用 `C:/Path/To/Project` 或 `/path/to/project`。除非专门演示 JSON 转义，否则不要在示例里写 `C:\\Path\\To\\Project`。

错误的 WebUI / 模板输出：

```text
QQ 消息更新提醒：群聊里有人 @ 了机器人。\n时间：{time}\n目标：{messageTarget}
```

正确的 WebUI / 模板输出：

```text
QQ 消息更新提醒：群聊里有人 @ 了机器人。
时间：{time}
目标：{messageTarget}
```

生成 `routes.json` 时，只按 JSON 要求转义一次。如果 WebUI 显示出可见的 `\n`，说明模板被双重转义，必须改成真实换行。

### 5. 开源脱敏检查

完成前检查：

- 不包含真实 QQ 号、群号、账号名、token、Cookie、私有 URL、本机私有路径或个人聊天内容。
- 公开示例里的 `targetGroupId` 默认留空，除非该 ID 明确是虚构值。
- 模板可以要求处理端按需读取日志，但不要让对外回复暴露敏感路径。
- `regex` 应足以演示角色触发意图，但不能宽到把所有普通群消息都转发。
- 如果没有实际 `heartbeat` 规则，人格不要承诺后台定时监控。
- 不要把 `data/`、`.env`、`gateways.json`、JSONL 日志、私聊记录或本地 Codex 状态复制进公开示例。
- 公开路径使用 `C:/Path/To/Project` 或 `/path/to/project` 这类占位值，绝不能包含真实用户名或私有工作区路径。

## 好人格与坏人格

好的 RabiRoute 人格：

- 清楚说明自己在路由层做什么。
- 知道什么时候保持安静。
- 默认生成草稿，而不是直接对外发送消息。
- 卡住时只问一个小而具体的问题。
- 区分私聊、群聊和内部 agent 上下文的隐私边界。
- 能把任务整理成具体任务包交给下游处理端。

差的人格：

- 声称自己是全能 Agent OS。
- 过度角色扮演，淹没可执行内容。
- 把日志、路径、路由内部字段或线程状态暴露给群成员。
- 把每条群消息都当成必须回复。
- 在公开示例中提交真实 ID 或私有运行细节。

## 最终检查

创建或修改人格后：

- 确认 `persona.md` 作为独立角色提示词是可读的。
- 确认 `routes.json` 是合法 JSON。
- 确认角色目录可以复制到 `data/roles/<RoleId>/` 使用。
- 总结这个人格的触发意图、安全边界，以及新增或修改的路由规则。
