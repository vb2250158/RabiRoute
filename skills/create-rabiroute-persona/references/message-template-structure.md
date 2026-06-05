# RabiRoute 消息模板数据解构

消息模板要用真实换行的 text block 写，不要先写成 JSON 字符串。目标是让 agent 看到稳定字段，而不是从一整段散文里猜上下文。

## 基本结构

```text
[RabiRoute 数据解构]
事件：<这是什么触发>
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
私聊日志：{privateLogPath}
角色目录：{agentRoleDir}

[行动]
<按当前角色说明要判断、回应、记录、追问、行动或自我更新什么>
```

## 群聊 @ 示例

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

## 成长补充块

普通消息、私聊或回复命中后，可以在当前任务完成后附带内部成长逻辑：

```text
[成长]
处理完成后，如果发现本角色的表达、知识、判断标准或常用 skill 可以改进，可以更新 {agentRoleDir} 下的人格文件。
更新前先把将被修改的旧文件复制到 {agentRoleDir}/old/，备份文件名加当前日期时间。
```

## 低频自检示例

```text
[RabiRoute 数据解构]
事件：成长自检触发
路由类型：{routeKind}
事件时间：{time}
当前时间：{currentTime}
星期：{currentWeekday}
间隔：{heartbeatIntervalSeconds} 秒

[来源]
路由：{routeProfileName}

[消息]
{message}

[上下文]
数据目录：{dataDir}
心跳日志：{heartbeatLogPath}
角色目录：{agentRoleDir}

[行动]
请先判断是否有未处理事项。若没有即时任务，请按 persona.md 的成长机制复盘自己如何更好地扮演当前角色。
需要更新人格文件时，可以直接修改 {agentRoleDir} 下的对应文件；修改前必须先把旧文件复制到 {agentRoleDir}/old/，备份文件名加当前日期时间。
```

## 换行规则

- WebUI 文本框里必须是真实换行。
- 不要输出让用户直接复制的 `"template": "...\\n..."` JSON 字符串。
- 只有保存到 `roleMessageConfig.json` 时，JSON 序列化结果里才应该出现 `\n`。
- 如果 WebUI 里显示可见的 `\n`，说明模板被双重转义，必须改成真实换行。
