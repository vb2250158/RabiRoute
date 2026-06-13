# Agent 上下文注入说明

本文面向配置 RabiRoute 的用户，说明 RabiRoute 投递消息给 Agent 时，会自动向消息上下文中注入哪些内容，以及最终建议格式。

上下文注入的目标是让 Agent 快速知道“这条消息从哪里来、当前角色是谁、可以关注哪些计划和记忆、有哪些 Rabi 接口可用”。它不负责把所有历史、所有计划或所有记忆全文塞进 prompt。

消息模板应该尽量薄。RabiRoute 负责自动包装事件信息、角色路径、计划/记忆索引、日志路径和接口文档链接；用户配置的 route 模板只需要写少量补充要求，甚至可以为空。

Agent 自己需要看的接口说明是 [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)。本文件主要帮助用户理解“为什么模板不用写很多”和“最终发给 Agent 的消息大概长什么样”。

## 注入原则

默认注入只放轻量信息：

- 当前事件的必要信息。
- 角色和路由路径。
- Agent 需要关注的接口文档链接。
- 进行中计划索引。
- 近期记忆索引。
- 当前消息命中的计划和记忆索引。

默认不注入：

- 全量聊天记录。
- 全量计划详情。
- 近期记忆全文。
- 沉淀记忆全文。
- 诊断详情。

Agent 需要更多内容时，应根据上下文里的路径、ID 或接口文档按需查询。

## 用户模板定位

用户不应该被要求在每条 route 规则里重复写完整消息模板。默认情况下，用户模板可以为空。

用户模板只用于补充这条规则的特殊要求，例如：

```text
请用更短的群聊草稿回应。
```

或：

```text
这条规则只做记录，不要生成外发草稿。
```

RabiRoute 会把用户模板内容放到最终消息的 `[用户模板补充]` 段落。没有补充内容时，该段落可以省略。

这意味着：

- 事件信息不需要用户手写。
- 角色文件路径不需要用户手写。
- 日志路径不需要用户手写。
- 计划和记忆索引不需要用户手写。
- Agent 接口文档链接不需要用户手写。
- 用户只写额外意图或特殊限制。

## 默认注入内容

事件信息：

```text
事件类型
事件时间
当前时间
route kind
route profile
消息来源
发送者
消息正文
```

角色信息：

```text
角色 ID
角色文件路径
角色目录
运行数据目录
```

日志路径：

```text
群聊日志路径
私聊日志路径
心跳日志路径
手动触发日志路径
语音转写日志路径
```

Rabi 内置能力：

```text
Agent 需要关注的 Rabi 接口文档链接
计划目录
记忆目录
```

计划和记忆索引：

```text
更新记忆与计划的说明文档路径
可用 API 提示：查看/更新计划、查看记忆、新增近期记忆、更新指定近期记忆
进行中计划索引：计划 ID + 标题
近期记忆索引：记忆 ID + 标题
命中召回索引：被当前消息命中的计划/记忆 ID + 标题
```

## 命中召回与处理前确认

`[记忆与计划]` 默认显示进行中计划和近期记忆。近期记忆统一指 `memory/recent/` 里的记忆，只是会根据记忆活跃时间所在窗口有不同处理。记忆活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个；默认配置下，最近 24 小时内更新、按 ID 查看或被关键词命中过的近期记忆会直接显示。

除此之外，RabiRoute 还会在投递消息给 Agent 之前，根据当前用户消息做轻量相关性打分，把高相关条目列入 `[处理前上下文确认]`。这个确认协议不只服务聊天回复，也适用于发布任务、更新计划、写入记忆或执行外部动作。

相关性打分发生在 Agent 投递前的热路径上，必须保持轻量。它不应该在每条消息到来时全量分词、扫描正文或读取大量文件。

计划和记忆的可检索关键词由 Agent 在写入或更新时主动提供。RabiRoute 只维护 ID、标题和 `keywords` 索引；消息到来时只对这些元信息做打分。ID 或标题显式命中最高，关键词命中次之；进行中计划和活跃近期记忆只有小幅排序加成，不会让无关条目进入必读队列。

新增或更新近期记忆时，`keywords` 必须存在且至少包含一个关键词。

相关性打分覆盖当前仍有操作价值的内容：

- 近期记忆，包括默认已显示的活跃近期记忆，以及不默认显示但尚未沉淀的近期记忆。
- 未归档计划，包括 `未开始`、`进行中`、`已完成` 等状态。
- 沉淀记忆，只参与标题和 `keywords` 打分，不默认注入全文。

如果用户消息包含这些条目的 ID、标题或 `keywords`，RabiRoute 会把得分最高的条目以 ID + 标题 + GET 路径的形式加入 `[处理前上下文确认]`，默认最多 5 条。

近期记忆或沉淀记忆进入处理前确认队列时，RabiRoute 会刷新该条记忆的 `viewedAt`。按 ID 查看近期记忆或沉淀记忆也会刷新 `viewedAt`；更新近期记忆会同时刷新 `updatedAt` 和 `viewedAt`。

已归档计划和其他更老的历史内容不参与常规打分。用户明确要求查看归档计划或历史记录时，再按需查询。

处理前确认只注入索引和查询路径，不注入全文。Agent 在回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须按 GET 路径读取确认队列里的每一项；如果无法读取或内容不足，应说明上下文无法确认或先追问。

MVP 使用 ID、标题 `includes` 和 Agent 写入的 `keywords` 做打分。不在投递前做智能分词。后续如果需要更复杂的中文分词，也应作为写入/更新时的离线辅助，不进入消息投递热路径。

## 按需注入内容

这些内容不默认进入每条消息，只在 route 模板、用户请求、手动触发或 Agent 明确需要时进入上下文：

- 计划详情。
- 近期记忆全文。
- 沉淀记忆摘要。
- 全量计划列表。
- 计划归档。
- 近期记忆列表。
- 沉淀记忆列表。
- gateway / NapCat / heartbeat 诊断摘要。

## 自动包装格式

最终投递给 Agent 的消息由 RabiRoute 自动包装生成。每段用稳定标题，方便 Agent 识别，也方便以后不同 Agent adapter 做解析。

建议结构：

```text
[RabiRoute 事件]
事件：<事件说明>
路由类型：<routeKind>
事件时间：<time>
当前时间：<currentTime>
来源：<messageTarget>
发送者：<sender>

[消息]
<message>

[角色和路径]
角色：<agentRoleId>
角色文件：<agentRolePath>
角色目录：<agentRoleDir>
运行数据目录：<dataDir>
计划目录：<agentRoleDir>/plans
记忆目录：<agentRoleDir>/memory

[记忆与计划]
更新记忆与计划的说明文档：<agentInterfaceDocPath>
可用 API 提示：
- 查看/更新计划：GET /api/roles/<roleId>/plans、GET /api/roles/<roleId>/plans/{planId}、POST /api/roles/<roleId>/plans、PATCH /api/roles/<roleId>/plans/{planId}
- 查看记忆：GET /api/roles/<roleId>/memory、GET /api/roles/<roleId>/memory/recent、GET /api/roles/<roleId>/memory/recent/{memoryId}、GET /api/roles/<roleId>/memory/consolidated、GET /api/roles/<roleId>/memory/consolidated/{memoryId}
- 新增近期记忆：POST /api/roles/<roleId>/memory/recent
- 更新指定近期记忆：PATCH /api/roles/<roleId>/memory/recent/{memoryId}
- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；关键词命中召回会刷新 viewedAt

进行中计划：
- <planId>：<planTitle>

近期记忆：
- <memoryId>：<memoryTitle>

命中召回：
- <itemId>：<itemTitle>

[日志]
群聊日志：<groupLogPath>
私聊日志：<privateLogPath>
心跳日志：<heartbeatLogPath>
手动触发日志：<manualTriggerLogPath>
语音转写日志：<voiceTranscriptLogPath>

[用户模板补充]
<用户在 route 模板里写的可选补充要求；为空时省略本段>
```

## 示例：QQ 群消息

```text
[RabiRoute 事件]
事件：QQ 群聊消息提醒
路由类型：group_message
事件时间：2026/6/8 20:12:00
当前时间：2026/6/8 20:12:03
来源：群 <group-id>
发送者：Alice

[消息]
Rabi，帮我看看计划和记忆机制怎么设计。

[角色和路径]
角色：Rabi
角色文件：C:/Path/To/RabiRoute/data/roles/Rabi/persona.md
角色目录：C:/Path/To/RabiRoute/data/roles/Rabi
运行数据目录：C:/Path/To/RabiRoute/data/roles/Rabi
计划目录：C:/Path/To/RabiRoute/data/roles/Rabi/plans
记忆目录：C:/Path/To/RabiRoute/data/roles/Rabi/memory

[记忆与计划]
更新记忆与计划的说明文档：C:/Path/To/RabiRoute/docs/rabi-agent-interfaces.md
可用 API 提示：
- 查看/更新计划：GET /api/roles/Rabi/plans、GET /api/roles/Rabi/plans/{planId}、POST /api/roles/Rabi/plans、PATCH /api/roles/Rabi/plans/{planId}
- 查看记忆：GET /api/roles/Rabi/memory、GET /api/roles/Rabi/memory/recent、GET /api/roles/Rabi/memory/recent/{memoryId}、GET /api/roles/Rabi/memory/consolidated、GET /api/roles/Rabi/memory/consolidated/{memoryId}
- 新增近期记忆：POST /api/roles/Rabi/memory/recent
- 更新指定近期记忆：PATCH /api/roles/Rabi/memory/recent/{memoryId}
- 按 ID 查看记忆会刷新 viewedAt；更新近期记忆会刷新 updatedAt 和 viewedAt；关键词命中召回会刷新 viewedAt

进行中计划：
- plan-001：完善计划和记忆机制文档

近期记忆：
- memory-001：用户希望计划和记忆由 Agent 主动维护
- memory-002：近期记忆和进行中计划默认只注入 ID 与标题

命中召回：
- memory-003：更新记忆与计划的说明文档路径

[日志]
群聊日志：C:/Path/To/RabiRoute/data/roles/Rabi/group-messages.jsonl
私聊日志：C:/Path/To/RabiRoute/data/roles/Rabi/private-messages.jsonl
心跳日志：C:/Path/To/RabiRoute/data/roles/Rabi/heartbeat-events.jsonl
手动触发日志：C:/Path/To/RabiRoute/data/roles/Rabi/manual-trigger-events.jsonl
语音转写日志：C:/Path/To/RabiRoute/data/roles/Rabi/voice-transcripts.jsonl

[用户模板补充]
需要回应时给短而自然的群聊草稿。
```

## 示例：内置记忆整理触发

内置记忆整理触发属于 `manual_trigger` 类消息，投递方式和普通手动触发一致。

当前实现先创建可查询的 consolidation request 和 pending run；负责 outbox 或回复发送的链路可以随后把 request 投递给 Agent。Agent 返回结果后，RabiRoute 通过 result 接口落盘沉淀记忆并标记输入近期记忆。

```text
[RabiRoute 事件]
事件：内置记忆整理
路由类型：manual_trigger
触发 ID：memory-consolidation
触发名称：记忆整理
触发来源：auto
触发阈值：存在 updatedAt 超过 72 小时的近期记忆
整理范围：所有 updatedAt 超过 24 小时且尚未沉淀的近期记忆
事件时间：2026/6/8 23:00:00
当前时间：2026/6/8 23:00:00

[角色和路径]
角色：Rabi
角色目录：C:/Path/To/RabiRoute/data/roles/Rabi
记忆目录：C:/Path/To/RabiRoute/data/roles/Rabi/memory
Agent 需要关注的 Rabi 接口：C:/Path/To/RabiRoute/docs/rabi-agent-interfaces.md

[待整理记忆]
- memory-001：用户希望计划和记忆由 Agent 主动维护
  用户希望计划和记忆都由 Agent 主动维护，RabiRoute 负责提供接口。

- memory-002：记忆整理触发机制
  记忆整理是 RabiRoute 内置 manual_trigger，可自动触发也可由用户主动触发。

[系统处理要求]
请将以上近期记忆整理为稳定、简洁、可长期保留的沉淀记忆。只返回沉淀记忆内容，不需要解释触发原因，不需要选择输入范围，不需要修改原始近期记忆。
```

## 模板变量建议

后续实现时仍可提供这些模板变量，供少量高级模板使用；普通 route 规则不需要手写这些变量：

```text
{agentInterfaceDocPath}
{plansDir}
{memoryDir}
{activePlanIndex}
{recentMemoryIndex}
{matchedPlanMemoryIndex}
{consolidatedMemorySummary}
```

其中：

- `{activePlanIndex}` 只包含进行中计划的 ID 和标题。
- `{recentMemoryIndex}` 只包含近期记忆的 ID 和标题；默认配置下会直接列出最近 24 小时内更新过的近期记忆。
- `{matchedPlanMemoryIndex}` 只包含当前消息命中的计划/记忆 ID 和标题。
- `{consolidatedMemorySummary}` 默认按需注入，不建议每条消息都带。

## 边界

上下文注入不是长期记忆数据库，也不是计划执行器。它只负责把 Agent 当前处理消息所需的轻量索引和路径交给 Agent。

如果 Agent 需要更多信息，应通过接口文档中的计划/记忆接口按 ID 查询；如果 Agent 需要维护记忆，应写近期记忆；如果 Agent 收到记忆整理触发，只返回沉淀记忆。
