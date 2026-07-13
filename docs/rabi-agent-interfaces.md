# Agent 需要关注的 Rabi 接口

本文说明 Agent 在处理 RabiRoute 消息时需要关注的 Rabi 内置接口。它不是普通用户操作手册，而是给 Agent 注入上下文后使用的接口说明。

这些接口用于让 Agent 主动维护计划和记忆，并把普通回复交回 RabiRoute。RabiRoute 负责存储、权限边界、自动归档、记忆沉淀触发、上下文注入和回复回传；Agent 需要关注的是：什么时候新增或更新计划、什么时候记录近期记忆、收到记忆整理触发时如何返回沉淀记忆，以及需要普通聊天回复时把内容交给回传接口。

## 上下文注入

RabiRoute 投递消息给 Agent 时，应在上下文中注入本接口文档链接，让 Agent 知道当前可以关注和使用哪些 Rabi 接口：

```text
Agent 需要关注的 Rabi 接口：{agentInterfaceDocPath}
```

推荐路径：

```text
docs/rabi-agent-interfaces.md
```

同时默认注入轻量索引：

```text
进行中计划：
- plan-001：完善计划和记忆机制文档

近期记忆：
- memory-001：计划和记忆由 Agent 主动维护
```

近期记忆统一指 `memory/recent/` 里的记忆。默认配置下，最近 24 小时内活跃过的近期记忆会直接注入；超过 24 小时且尚未沉淀的近期记忆不默认显示，只有用户消息命中标题或 `keywords` 时才会被召回。活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个；按 ID 查询记忆、更新近期记忆、关键词命中召回都会刷新对应时间。

RabiRoute 还会注入 `[处理前上下文确认]`。它会从未归档计划、近期记忆和沉淀记忆中按 ID、标题和 `keywords` 做轻量打分，列出默认最多 5 条高相关必读项。Agent 在回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按该小节里的 GET 路径读取内容；不能只凭标题行动。若必读项无法读取或内容不足以确认，应说明上下文无法确认，或先向用户追问。

普通回复上下文会一并注入：

```text
普通回复 API：http://127.0.0.1:8790/api/agent/replies
当前回复上下文：{"gatewayId":"main","runtimeRouteId":"main","routeProfileId":"main","routeKind":"direct_at","targetType":"group","messageId":123,"groupId":456,"userId":789,"targetGroupId":456,"instanceId":"default","replyApiUrl":"http://127.0.0.1:8790/api/agent/replies","groupLogPath":"data/route/main/group-messages.jsonl","privateLogPath":"data/route/main/private-messages.jsonl","outputAdapter":"codex","outputPipeline":"codex","replyToSource":false}
```

## 普通回复回传接口

Agent 的普通聊天回复应默认交给 RabiRoute，而不是直接调用 NapCat 或其他消息平台。

```http
POST /api/agent/replies
```

请求体示例：

```json
{
  "text": "收到，我来处理。",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "messageId": 123,
    "groupId": 456,
    "userId": 789,
    "instanceId": "default"
  }
}
```

RabiRoute 只会在满足以下条件时自动发送：

- 请求带有明确聊天目标：`targetType=group` 加 `groupId`，或 `targetType=private` 加 `userId`。
- 或请求带有原始消息上下文，RabiRoute 能从消息日志中定位来源群聊或私聊。
- 对应路由的消息端发送管道未关闭，且 payload 类型在 `supportedOutputs` 内。

Agent 可以主动向自己已经掌握的群号或企业微信群 chat id 发送推进消息，不需要 `messageId`、`replyToSource=true` 或固定某个 output adapter。RabiRoute 不再按群号、私聊账号或具体 pipeline ID 做细粒度过滤；是否能发由消息端发送开关、消息端可用性和明确目标决定。

主动投递到 RabiLink 眼镜也使用同一个动作安全门，不要直接绕过到 Relay：

```json
{
  "routeProfileId": "RabiLink",
  "targetType": "rabilink",
  "proactive": true,
  "source": "scheduler",
  "text": "该休息一下了。"
}
```

`routeProfileId` 必须指向启用了 RabiLink 输出策略且已配置 Relay 的 Route。该请求不需要 `messageId`；通过策略后，RabiRoute 会把消息写入应用级持续下行队列，眼镜即使刚才没有说话也能收到。普通 RabiLink 来源回复仍保留来源关联，不会走主动分支，从而避免重复投递。

企业微信群聊消息使用同一个回复接口。企业微信的 `replyContext` 会尽量和 NapCat 群聊保持一致：`targetType=group`、`groupId` 表示企业微信群聊或 chat id，`userId` 表示发送者企业微信用户 ID；同时补充 `adapterType=wecom`、`wecomReqId`、`wecomConversationId`、`wecomChatId`、`outputAdapter=wecom`。Agent 回复当前企业微信群聊时，应原样带回 `replyContextJson`；主动发送到企业微信群时，至少提供 `adapterType=wecom`、`targetType=group` 和 `groupId`。

企业微信回复示例：

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

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "sent",
  "routeProfileId": "main",
  "messageId": "123",
  "targetType": "group",
  "groupId": "456",
  "instanceId": "default",
  "sentMessageId": "124"
}
```

被阻断示例：

```json
{
  "code": -1,
  "ok": false,
  "status": "blocked",
  "reason": "Missing original source message context; automatic external send is not allowed.",
  "draft": {
    "text": "这条只能作为草稿。",
    "targetType": "group",
    "groupId": "456"
  }
}
```

## 计划接口

计划是 Agent 需要关注的事项。计划不按短期、长期拆目录，而是通过状态和字段表达当前进展、优先级、项目归属和下一步。

```text
未开始
进行中
已完成
已归档
```

查询计划：

```http
GET /roles/:roleId/plans
GET /roles/:roleId/plans/:planId
```

新增计划：

```http
POST /roles/:roleId/plans
```

请求体示例：

```json
{
  "title": "完善计划和记忆机制文档",
  "status": "进行中",
  "priority": "medium",
  "kind": "documentation",
  "currentStep": "确认接口文档注入方式",
  "nextAction": "补充 Rabi Agent 接口文档",
  "keywords": ["计划", "记忆", "接口", "上下文"],
  "source": {
    "kind": "agent",
    "summary": "Agent 根据用户讨论新增计划"
  }
}
```

更新计划：

```http
PATCH /roles/:roleId/plans/:planId
```

常见用途：

- 更新标题。
- 更新当前步骤。
- 更新下一步。
- 更新关键词。
- 将状态改为 `进行中`。
- 将状态改为 `已完成`。

计划归档不需要 Agent 处理。计划变为 `已完成` 后，RabiRoute 按人格配置的 `completedArchiveAfterHours` 自动转为 `已归档`。

归档计时以计划的 `updatedAt` 为准。Agent 更新计划后，RabiRoute 会刷新 `updatedAt`，该计划重新进入活跃窗口；只有 `已完成` 且距离最后更新时间超过归档窗口时才会自动归档。

## 近期记忆接口

近期记忆是 Agent 主动记录、仍处于可修改或待沉淀窗口内的记忆。近期记忆没有计划状态。

查询近期记忆：

```http
GET /roles/:roleId/memory/recent
GET /roles/:roleId/memory/recent/:memoryId
```

新增近期记忆：

```http
POST /roles/:roleId/memory/recent
```

请求体示例：

```json
{
  "title": "计划和记忆由 Agent 主动维护",
  "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 负责提供接口、自动归档和记忆沉淀触发。",
  "keywords": ["计划", "记忆", "主动维护", "接口"],
  "source": {
    "kind": "agent",
    "summary": "Agent 根据当前对话记录"
  }
}
```

更新近期记忆：

```http
PATCH /roles/:roleId/memory/recent/:memoryId
```

近期记忆可以通过 ID 修改，用于修正、补充、合并或降噪。超过 `recentEditableHours` 的近期记忆是否允许修改，由 RabiRoute 按人格配置判断。

记忆时间窗口以活跃时间为准。活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个。Agent 按 ID 查询近期记忆时，RabiRoute 会刷新 `viewedAt`；Agent 更新近期记忆时，RabiRoute 会刷新 `updatedAt` 和 `viewedAt`；只有距离最后活跃时间超过可编辑窗口的记忆才会进入待沉淀范围。

Agent 新增或更新近期记忆时，应主动填写 `keywords`。RabiRoute 在消息投递前只使用标题和 `keywords` 做轻量召回，不对记忆内容进行实时智能分词。当前消息命中近期记忆标题或 `keywords` 时，RabiRoute 会刷新该条记忆的 `viewedAt`。

`keywords` 是必填项。新增近期记忆时必须提供至少一个关键词；更新近期记忆时如果改写 `keywords`，也必须保留至少一个关键词。

## 沉淀记忆接口

沉淀记忆是近期记忆经过整理后的稳定记录。Agent 不能直接修改已有沉淀记忆。

查询沉淀记忆：

```http
GET /roles/:roleId/memory/consolidated
GET /roles/:roleId/memory/consolidated/:memoryId
```

沉淀记忆不提供普通 `PATCH` 接口。如果 Agent 发现沉淀记忆需要修正，应新增一条近期记忆说明修正内容，等待下一轮沉淀流程生成新的稳定结论。

按 ID 查询沉淀记忆会刷新该条沉淀记忆的 `viewedAt`。沉淀记忆没有更新接口，`viewedAt` 只表示近期被查看或召回过。

## 内置记忆整理触发

记忆整理是一种内置手动触发消息。它走与普通 `manual_trigger` 一致的 Agent 投递链路。

触发来源：

- RabiRoute 根据人格配置和时间窗口自动触发。
- 用户主动触发。

RabiRoute 创建的沉淀请求包含待整理的近期记忆。负责投递的链路可以把这个请求交给 Agent；Agent 只需要返回沉淀后的记忆。

手动创建沉淀请求：

```http
POST /roles/:roleId/memory/consolidation-requests
```

请求体可选：

```json
{
  "triggerSource": "manual",
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

默认情况下，只有存在最后活跃时间超过 72 小时且尚未沉淀的近期记忆时，RabiRoute 才创建请求；请求输入为所有最后活跃时间超过 24 小时且尚未沉淀的近期记忆。

创建后 API 返回本轮整理 run 和输入记忆。负责投递的链路可以把这些内容包装成 `memory_consolidation_request` 交给 Agent。

API 返回示例：

```json
{
  "code": 0,
  "data": {
    "run": {
      "id": "memory-consolidation-run-001",
      "roleDir": "data/roles/Rabi",
      "requestedAt": "2026-06-08T00:00:00+08:00",
      "trigger": "api",
      "recentEditableHours": 24,
      "recentConsolidationHours": 72,
      "inputMemoryIds": ["memory-001"],
      "status": "requested",
      "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。"
    },
    "memories": [
      {
        "id": "memory-001",
        "title": "计划和记忆由 Agent 主动维护",
        "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 提供接口。",
        "keywords": ["计划", "记忆", "接口"],
        "createdAt": "2026-06-06T12:00:00+08:00",
        "updatedAt": "2026-06-06T12:00:00+08:00"
      }
    ]
  }
}
```

投递给 Agent 的抽象消息示例：

```json
{
  "type": "memory_consolidation_request",
  "routeKind": "manual_trigger",
  "triggerId": "memory-consolidation",
  "triggerName": "记忆整理",
  "triggerSource": "manual",
  "roleId": "Rabi",
  "runId": "memory-consolidation-run-001",
  "requestedAt": "2026-06-08T00:00:00+08:00",
  "window": {
    "triggerOlderThanHours": 72,
    "includeOlderThanHours": 24
  },
  "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。",
  "memories": [
    {
      "id": "memory-001",
      "title": "计划和记忆由 Agent 主动维护",
      "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 提供接口。"
    }
  ]
}
```

返回示例：

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "计划和记忆维护边界",
      "content": "计划和记忆由 Agent 主动维护；RabiRoute 负责提供接口、注入索引、自动归档已完成计划，并触发记忆沉淀流程。"
    }
  ]
}
```

接收 Agent 返回并落盘：

```http
POST /roles/:roleId/memory/consolidation-runs/:runId/result
```

请求体可以直接是 `memory_consolidation_result`，RabiRoute 会读取其中的 `memories` 数组。

RabiRoute 负责写入沉淀记忆、记录整理轮次和标记近期记忆已沉淀。Agent 不需要移动文件、更新沉淀标记或判断触发时机。

## 远端 Agent 设备接口

当路由启用了“远端 Agent”消息端时，本机 Agent 可以把需要特定设备/系统完成的任务投递给远端 Agent 设备。远端机器只需要运行 `plugin-adapters/remote-agent-rabiroute` bridge，不需要安装完整 RabiRoute。

安全边界：

- 本机 loopback 调用用于 WebGUI 和本机人格线程。
- RabiGUI/manager 先扫描局域网远端 bridge，再由用户输入设备密码连接；默认密码为 `123456`，连接成功后只在本机运行期数据中记住密码。
- WebSocket bridge 密码通过首包握手传递，不放 URL query。
- 任务事件必须来自任务所属的 `deviceId`；其他设备不能把别人的任务标记为 completed/failed。
- 文件传输默认不限制大小；如需给特定部署加保护，可设置 `REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES` 或 `REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES`。

查询在线远端设备：

```http
GET /api/remote-agent/devices
```

创建设备任务：

```http
POST /api/remote-agent/tasks
```

请求体示例：

```json
{
  "originGatewayId": "main",
  "deviceId": "builder-device",
  "taskKind": "build-desktop",
  "cwd": "/path/to/project",
  "threadName": "远端构建小助手",
  "message": "请在远端设备执行打包任务，完成后回传产物路径和日志路径。",
  "filePaths": ["/local/path/to/input.patch"],
  "originReplyContext": {}
}
```

文件传输：

- `filePaths`：本机 manager 可读取的文件路径数组。manager 会读取文件内容，随任务发送到远端 bridge。
- `files` / `attachments`：也可以直接传 `{ "name": "input.txt", "contentBase64": "..." }`；带 `path` 时 manager 会读取本机路径。
- 远端 bridge 会把任务文件保存到远端运行期 inbox 目录，并在远端 Codex 任务提示里列出实际路径。
- 远端 Codex 完成后，可在本机回调中填写 `artifactPath`、`logPath` 或 `files`；bridge 会读取这些远端本机文件内容，回传给 manager。
- Manager 会把回传文件保存到 `data/remote-agent-files/<taskId>/`，并在任务事件的 `savedFiles` 中记录本机保存路径、大小和 sha256。

远端结果会先回到本机 RabiRoute，再投递回发起任务的本机人格线程。远端 Agent 不应直接回复 QQ；是否回复 QQ 仍由本机人格通过普通回复接口决定。

查询整理轮次：

```http
GET /roles/:roleId/memory/consolidation-runs
GET /roles/:roleId/memory/consolidation-runs/:runId
```

## 错误边界

Agent 不应该：

- 直接修改沉淀记忆。
- 把聊天日志原样写成记忆。
- 把计划归档当成需要自己判断的事项。
- 在没有需要时请求全量记忆或全量计划。
- 把 RabiRoute 当成完整 Agent OS 或执行器队列。

Agent 应该：

- 用计划接口维护关注项。
- 用近期记忆接口记录自己主动总结出的上下文，并填写可召回的 `keywords`。
- 需要详情时按 ID 查询。
- 收到记忆整理触发时只返回沉淀记忆。

## 角色技能接口

角色技能是角色目录下的可复用操作指南，放在：

```text
data/roles/<RoleId>/skills/*.md
```

每个技能文件使用 Markdown 正文和简单 frontmatter：

```markdown
---
id: configuration-triage
title: Configuration triage
summary: Diagnose setup issues by separating input, route match, delivery, and reply.
keywords: configuration, route miss, agent delivery, outbox
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Configuration triage

...
```

RabiRoute 在投递前只读取技能元信息：`id`、`title`、`summary` 和 `keywords`。技能正文不会默认进入每条 Agent 消息。

查询角色技能：

```http
GET /roles/:roleId/skills
GET /roles/:roleId/skills/:skillId
```

列表接口只返回元信息。单项接口返回完整正文。Agent 在 `[处理前上下文确认]` 里看到 `role_skill` 条目时，回复、更新计划/记忆或执行外部动作前应先按 GET 路径读取技能全文。
