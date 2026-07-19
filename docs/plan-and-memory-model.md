<!-- docs-language-switch -->
<div align="center">
<a href="./plan-and-memory-model_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 计划和记忆机制

> 状态：现行指南。已按 `src/roleKnowledge.ts`、Manager API 和测试核对；文中明确区分当前实现与后续计划。

本文说明 RabiRoute 中计划和记忆的运行机制：数据放在哪里、如何分层、怎样进入处理端 Agent、何时更新，以及托盘面板如何展示。

RabiRoute 仍然是消息网关和 Policy Router。计划和记忆机制用于给路由和处理端提供可追踪上下文，不把 RabiRoute 变成完整 Agent OS、项目管理器或聊天机器人框架。

最终注入给 Agent 的消息格式见 [Agent 上下文注入说明](agent-context-injection.md)。Agent 可用接口见 [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)。

## 总体模型

计划和记忆都跟随角色人格目录。一个角色拥有自己的计划、人格文件、消息日志和长期上下文。

```text
data/roles/<RoleId>/
  persona.md
  growth.md
  skills.md
  personaConfig.json
  plans/
  memory/
  private-messages.jsonl
  group-messages.jsonl
  voice-transcripts.jsonl
  heartbeat-events.jsonl
```

路由运行态数据跟随 route profile：

```text
data/route/<RouteName>/
  gateway-status.json
  heartbeat-events.jsonl
```

角色目录保存“这个角色长期应该知道和关注什么”。路由目录保存“这条航线当前运行成什么样”。

## 计划机制

计划用于保存可推进、可等待、可完成、可归档的关注项。计划数据是角色要盯住的事项，不是普通聊天记录，也不是执行器队列。

计划有生命周期状态。当前机制只定义四个状态：

```text
未开始
进行中
已完成
已归档
```

等待用户、等待外部系统、暂停、阻塞等情况不作为顶层状态。它们应写入 `nextAction`、`waitingFor`、`blockedBy` 或备注字段。这样计划列表保持简单，Agent 也更容易判断计划是否还能推进。

推荐目录：

```text
data/roles/<RoleId>/plans/
  README.md
  index.json
  items/
    active/
  archive/
```

活跃计划：

```text
plans/items/active/*.json
```

用于放所有未归档计划，包括 `未开始`、`进行中`、`已完成`。计划不再按短期、长期、项目关联拆目录；这些信息应写入 `kind`、`project`、`priority`、`dueAt`、`nextAction` 等字段，由视图筛选。

归档计划：

```text
plans/archive/
```

用于放已完成、过期或不再默认展示的计划。

已完成计划不会立即归档。它会先保持 `已完成` 状态，继续在完成列表或总览里保留一段时间，方便用户确认结果。距离最后更新时间超过当前固定的 72 小时后，角色知识快照会将它变为 `已归档`，并移动到 `plans/archive/`。

计划归档不需要经过 Agent 处理。它是 RabiRoute 的机械生命周期维护，不触发 Agent 总结，不要求 Agent 判断，只更新状态、`archivedAt` 和存放位置。

当前归档窗口：

```json
{
  "completedArchiveAfterHours": 72
}
```

默认值：

```text
completedArchiveAfterHours = 72
```

归档计时以计划的 `updatedAt` 为准，不以 `createdAt` 为准。计划只要被 Agent 或用户更新过，就重新进入活跃窗口；只有 `已完成` 状态下距离最后更新时间超过 72 小时，RabiRoute 才会归档。目前 `completedArchiveAfterHours` 还不是 `personaConfig.json` 的公开配置字段。

## 计划字段

单个计划建议保持轻量，先满足展示、筛选和后续写入。

```json
{
  "id": "plan-rabiroute-plan-memory-model",
  "title": "完善 RabiRoute 计划和记忆机制文档",
  "focus": "计划和记忆机制文档",
  "status": "进行中",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "confirm-contract",
  "currentStep": "确认机制说明口径",
  "nextAction": "根据确认结果更新示例和读取层",
  "waitingFor": "",
  "blockedBy": "",
  "steps": [
    { "id": "inspect-current", "title": "检查当前模型与界面", "status": "已完成" },
    { "id": "confirm-contract", "title": "确认结构化步骤契约", "status": "进行中" },
    { "id": "update-readers", "title": "更新接口、读取层和文档", "status": "未开始" }
  ],
  "project": {
    "name": "RabiRoute",
    "path": "C:/Path/To/RabiRoute"
  },
  "source": {
    "kind": "manual",
    "summary": "用户要求说明计划和记忆机制"
  },
  "dueAt": "",
  "completedAt": "",
  "archivedAt": "",
  "createdAt": "2026-06-08T00:00:00+08:00",
  "updatedAt": "2026-06-08T00:00:00+08:00",
  "keywords": ["计划", "记忆", "机制", "文档"]
}
```

`keywords` 由 Agent 在新增或更新计划时主动填写，用于 RabiRoute 在投递前做轻量命中召回。RabiRoute 不在每条消息到来时对计划内容做智能分词。

`focus` 是单条计划的唯一主题声明。新增计划必须显式填写，且只能是一行；一个计划只推进一个主题，遇到无关目标或独立阻塞时应拆成另一条计划，不能继续堆进 `currentStep`。

`steps` 是计划的有序执行路径。新建计划必须完整列出步骤；同一时间最多一条步骤为 `进行中`。顶层 `currentStepId` 必须指向这条步骤，让界面和 Agent 都能准确回答“执行到哪一步”。步骤可带 `detail`、`waitingFor`、`blockedBy` 和 `completedAt`；`waitingFor` 说明正在等谁或什么，`blockedBy` 说明为什么无法继续，并优先写到实际受阻的当前步骤上。`currentStep` 保留为当前进展说明，不再承担步骤列表或步骤身份。结构化步骤已经表达后续路径，界面不再重复展示 `nextAction`；`nextAction` 仍供 Agent 恢复和旧版计划兼容使用。

## 聚焦与长度校验

计划、近期记忆和沉淀记忆的写入都经过后端校验。新增计划、近期记忆或沉淀结果必须显式提供单行 `focus`；`keywords` 至少一个。超出字段长度、关键词数量或总文本长度时，API 返回 `400`，要求 Agent 拆成更聚焦的条目。读取旧文件保持兼容，现有违规条目可通过校验接口发现：

```http
GET /api/roles/:roleId/knowledge-validation
```

默认限制可由角色的 `personaConfig.json` 中 `knowledgeLimits` 收紧：

```json
{
  "knowledgeLimits": {
    "plan": {
      "titleChars": 80,
      "focusChars": 80,
      "currentStepChars": 1200,
      "stepTitleChars": 120,
      "stepDetailChars": 600,
      "stepWaitingForChars": 300,
      "stepBlockedByChars": 300,
      "maxSteps": 100,
      "nextActionChars": 600,
      "waitingForChars": 300,
      "blockedByChars": 600,
      "sourceSummaryChars": 240,
      "keywordChars": 32,
      "maxKeywords": 24,
      "totalChars": 2800
    },
    "memory": {
      "titleChars": 80,
      "focusChars": 80,
      "contentChars": 4000,
      "sourceSummaryChars": 240,
      "keywordChars": 32,
      "maxKeywords": 24,
      "totalChars": 4600
    }
  }
}
```

字符数按 Unicode code point 计算；`totalChars` 统计该条目的主要文本字段和关键词。一个记忆只记录一个事实、偏好、结论或问题；一个计划只记录一个可推进目标。系统用必填单行 `focus` 和硬长度上限约束结构，语义是否混题仍由写入 Agent 负责拆分。

计划状态含义：

```text
未开始    已记录，但还没有进入推进状态
进行中    正在推进、正在关注，或当前需要 Agent 留意
已完成    事情已经完成，先保留一段时间供用户确认，再按配置自动归档
已归档    已从默认计划视图中收起，只作为历史记录保留
```

## 记忆机制

记忆用于保存 Agent 主动整理出来的上下文。它不是聊天记录的别名，也不是直接从消息日志里截取几条给用户看。

聊天记录、语音转写和心跳事件属于原始事件日志。Agent 本身可以按路径或工具查询这些日志，所以托盘面板不需要把聊天记录伪装成记忆展示。记忆应该是 Agent 看过上下文之后，认为以后仍有价值而主动写入的内容。

记忆不需要计划状态。记忆不是待办事项，不需要 `未开始`、`进行中`、`已完成` 或 `已归档`。记忆可以有来源、记录时间、更新时间、适用范围或置信度，但这些只是元信息，不表示生命周期。

推荐目录：

```text
data/roles/<RoleId>/memory/
  recent/
  consolidated/
  consolidation-runs/
```

近期记忆：

```text
memory/recent/*.json
```

近期记忆由 Agent 主动新增或更新。它记录最近一段时间里 Agent 认为值得保留的事实、偏好、判断、阶段性结论或上下文摘要。近期记忆可以通过记忆 ID 修改。

沉淀记忆：

```text
memory/consolidated/*.json
```

沉淀记忆由 RabiRoute 的定时总结流程生成。它是近期记忆经过总结后的稳定记录。沉淀记忆生成后，Agent 不能直接修改已有条目；如果需要修正，只能新增近期记忆说明修正原因，再由下一轮沉淀流程生成新的沉淀记录。

记忆总结记录：

```text
memory/consolidation-runs/*.json
```

用于记录每次总结的输入范围、触发时间、Agent 返回结果和写入的沉淀记忆 ID，方便排障和审计。

## 近期记忆和沉淀记忆

近期记忆有两个当前固定时间窗口：

```json
{
  "recentEditableHours": 24,
  "recentConsolidationHours": 72
}
```

默认值：

```text
recentEditableHours = 24
recentConsolidationHours = 72
```

含义：

- `recentEditableHours`：距离最后活跃时间多少小时内的近期记忆允许 Agent 通过记忆 ID 直接修改，默认 24 小时。
- `recentConsolidationHours`：显式请求记忆整理时，用于判断是否已经到期，默认 72 小时。

这两个窗口目前不是 `personaConfig.json` 的公开配置字段。创建一次 Manager API request 时可以用请求参数覆盖本轮阈值。

记忆窗口以近期记忆的活跃时间为准，不以 `createdAt` 为准。活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个。近期记忆只要被 Agent 更新、按 ID 查看，或被当前消息通过标题/`keywords` 命中召回，就重新进入活跃窗口。

上下文默认显示的记忆也是按 `recentEditableHours` 判断。默认配置下，`[记忆与计划]` 中默认列出最近 24 小时内活跃过的近期记忆。距离最后活跃时间超过 24 小时、且尚未沉淀的近期记忆，不默认显示；只有用户消息命中标题或 `keywords` 时，才作为命中召回临时列入上下文，并刷新 `viewedAt`。

记忆整理的输入范围和到期判断由 RabiRoute 处理，不由 Agent 判断。当前必须先由用户触发 `memory-consolidation` 手动项，或调用 Manager API 创建 request；仅仅经过时间不会自行启动后台整理任务。

默认判断策略是：显式请求到来后，若存在最后活跃时间超过 `recentConsolidationHours` 的近期记忆，就创建一次整理 run。输入范围是所有最后活跃时间超过 `recentEditableHours` 且尚未沉淀的近期记忆。`force=true` 可以跳过到期判断，但仍只收集超过可编辑窗口的输入。

这条消息属于一种内置手动触发消息。它不是额外开一条特殊私有通道，而是作为 RabiRoute 内置的 `manual_trigger` 进入同一套模板、投递和 Agent 接收流程。

现行记忆整理有两种显式入口：

- 用户主动触发 `triggerId=memory-consolidation` 的内置手动触发项。
- 调用 `POST /api/roles/:roleId/memory/consolidation-requests`。

API 可在单次请求中覆盖 `triggerOlderThanHours`、`includeOlderThanHours` 和 `force`；默认仍为 72/24 小时。后台自动调度属于后续能力，不能写成已经完成。进入 Agent 端的消息结构保持一致，区别只体现在触发来源元信息里。

Agent 在这次交互里只需要返回沉淀后的记忆，不需要解释触发原因，不需要决定哪些记忆进入本轮整理，也不需要修改原始近期记忆。

请求可以抽象成：

```json
{
  "type": "memory_consolidation_request",
  "routeKind": "manual_trigger",
  "triggerId": "memory-consolidation",
  "triggerName": "记忆整理",
  "triggerSource": "auto",
  "roleId": "Rabi",
  "requestedAt": "2026-06-08T00:00:00+08:00",
  "window": {
    "triggerOlderThanHours": 72,
    "includeOlderThanHours": 24
  },
  "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。",
  "memories": [
    {
      "id": "memory-001",
      "focus": "计划和记忆的维护责任",
      "createdAt": "2026-06-06T12:00:00+08:00",
      "content": "用户希望计划和记忆由 Agent 主动维护，RabiRoute 提供接口。"
    }
  ]
}
```

Agent 返回可以抽象成：

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "计划和记忆维护边界",
      "focus": "计划和记忆的维护责任",
      "content": "用户希望 RabiRoute 的计划和记忆由 Agent 主动维护；RabiRoute 负责提供计划/记忆接口、自动归档和记忆沉淀触发。"
    }
  ]
}
```

当前 manager API 创建沉淀请求时返回 `{ run, memories }`，由后续投递链路把它包装成上述 Agent 消息。结果接收接口为 `POST /roles/:roleId/memory/consolidation-runs/:runId/result`，请求体可以直接使用 Agent 返回的 `memory_consolidation_result`。

Agent 返回总结后，RabiRoute 负责写入结果、记录总结轮次，并更新近期记忆的沉淀标记。Agent 不负责判断何时触发、不负责选择输入范围，也不负责移动或归档记忆文件。

RabiRoute 将结果写入：

```text
memory/consolidated/
```

本实现采用保留近期记忆文件并标记的方式。被总结过的近期记忆会写入 `consolidatedAt` 和 `consolidationRunId`，不再默认展示，也不再进入后续沉淀输入。沉淀结果写入 `memory/consolidated/`，整理轮次写入 `memory/consolidation-runs/`，两边都记录输入记忆 ID 和 run ID，方便追溯。

近期记忆适合记录：

- Agent 刚形成的阶段性判断。
- 用户刚表达、还需要观察是否稳定的偏好。
- 某个计划推进过程中的临时结论。
- 刚发生、未来一两天可能还会用到的上下文。

沉淀记忆适合记录：

- 已确认稳定的用户偏好。
- 已反复出现的项目边界。
- 角色长期需要遵守的行为约定。
- 从多条近期记忆中总结出的稳定事实。
- 已经不需要保留细节、但需要保留结论的历史上下文。

人格文件、成长文件和技能文件仍然是角色基础设定：

```text
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/growth.md
data/roles/<RoleId>/skills.md
```

它们不是沉淀记忆数据库。Agent 可以按已有规则更新这些文件，但这属于角色自我维护，不替代 `memory/recent` 和 `memory/consolidated`。

## Agent 获取机制

计划和记忆不会因为存在于托盘面板里就把全文自动塞给 Agent，但 RabiRoute 会默认注入必要索引和当前关注项。Agent 获取上下文有三种方式。

路径提示：

```text
请遵循 {agentRolePath}。
请读取 {groupLogPath} 查看群聊上下文。
请读取 {privateLogPath} 查看私聊上下文。
计划目录：{agentRoleDir}/plans
记忆目录：{agentRoleDir}/memory
Agent 需要关注的 Rabi 接口：{agentInterfaceDocPath}
```

这是当前最主要的机制。RabiRoute 在路由模板中渲染这些路径，处理端 Agent 收到消息后按需读取。

上下文注入：

```text
进行中计划：
- plan-001：完善计划和记忆机制文档

近期记忆索引：
- memory-001：计划和记忆由 Agent 主动维护
- memory-002：记忆整理是内置手动触发消息
```

进行中的计划会以 ID 和标题的形式注入上下文，让 Agent 知道当前需要关注什么。近期记忆也会以 ID 和标题的形式自动注入，作为可进一步查询或更新的索引。默认不注入计划详情或近期记忆全文，避免每次投递都把上下文塞满。

处理前上下文确认：

```text
[处理前上下文确认]
以下条目与当前消息高相关。回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按 GET 路径读取每一项内容；不要只凭标题行动。
- memory-001：计划和记忆由 Agent 主动维护（recent_memory，score=25） GET /api/roles/Rabi/memory/recent/memory-001
```

RabiRoute 会对未归档计划、近期记忆和沉淀记忆做轻量相关性打分，只使用 ID、标题和 `keywords`。进行中计划和活跃近期记忆有小幅排序加成，但无关条目不会仅因为“活跃”进入必读队列。必读队列默认最多 5 条，只注入查询路径，不注入全文；Agent 在回复或执行动作前应按 ID 查询内容，无法确认时要说明不确定或先追问。

接口查询和更新：

```text
GET /roles/:roleId/plans
GET /roles/:roleId/memory
GET /roles/:roleId/memory/recent/:memoryId
GET /roles/:roleId/memory/consolidated/:memoryId
POST /roles/:roleId/plans
PATCH /roles/:roleId/plans/:planId
POST /roles/:roleId/memory/recent
PATCH /roles/:roleId/memory/recent/:memoryId
```

这些接口已由 Manager 实现。Agent adapter、角色面板或其它本机工作台可以按需查询和更新；`/roles/...` 与 `/api/roles/...` 两种路径前缀均可解析，公开示例优先使用 `/api/roles/...`。

计划接口可以新增计划、更新已有计划、修改状态、更新下一步或归档。记忆接口可以新增近期记忆，也可以通过记忆 ID 修改近期记忆。沉淀记忆不提供直接修改接口。

近期记忆新增和更新都要求保留 `keywords`。RabiRoute 在消息投递前只匹配 ID、标题和 `keywords`，不做智能分词。按 ID 查看近期记忆或沉淀记忆会刷新 `viewedAt`；更新近期记忆会刷新 `updatedAt` 和 `viewedAt`；近期记忆或沉淀记忆进入处理前确认队列时也会刷新该条记忆的 `viewedAt`。

## 注入时机

默认注入：

- 角色文件路径。
- 当前消息。
- 当前时间。
- 对应消息日志路径。
- route profile 和角色目录路径。
- Agent 需要关注的 Rabi 接口文档链接。
- 进行中的计划索引，格式为计划 ID 和标题。
- 近期记忆索引，格式为记忆 ID 和标题；默认配置下直接列出最近 24 小时内更新过的近期记忆。
- 处理前上下文确认队列，格式为类型、ID、标题、得分和 GET 路径；默认最多 5 条。

按需注入：

- 计划详情。
- 近期记忆全文。
- 沉淀记忆摘要。

用户明确询问时注入：

- 全量计划列表。
- 计划归档。
- 近期记忆列表。
- 沉淀记忆列表。
- 诊断信息。
- gateway / NapCat / heartbeat 状态。

诊断信息只用于排障，不作为计划或记忆默认注入。

## 更新机制

记忆更新由 Agent 主动发起。RabiRoute 不应该自动把聊天记录变成记忆，只提供新增、修改、读取和沉淀接口。

近期记忆可以修改。Agent 通过记忆 ID 更新已有近期记忆，用于修正措辞、补充上下文或合并重复记录。

查看记忆也是一次活跃行为。按 ID 查看近期记忆或沉淀记忆时，RabiRoute 自动刷新 `viewedAt`；更新近期记忆时，RabiRoute 自动刷新 `updatedAt` 和 `viewedAt`。近期记忆的默认注入、关键词命中召回和沉淀窗口都按 `updatedAt` / `viewedAt` 中较新的时间判断。

沉淀记忆不可直接修改。沉淀记忆来自总结流程，生成后只作为稳定记录读取。如果后来发现沉淀记忆不准确，Agent 应新增一条近期记忆说明修正，等待下一轮沉淀生成新的稳定结论。

记忆更新不走计划状态流转。它只需要说明信息从哪里来、何时记录、适用于什么范围；如果一条记忆后来不再适用，应修正近期记忆、追加修正记忆，或通过下一轮沉淀产生新的结论，而不是标记为“已完成”。

计划更新要留下状态和来源。任何写操作都应该更新 `updatedAt`，并尽量保留 `source`，方便以后知道计划为什么出现。

建议更新规则：

- 新计划先设为 `未开始`。
- 已确认要推进或当前正在关注时设为 `进行中`。
- 等用户或外部系统时仍保持 `进行中`，用 `waitingFor` 写清等待对象；如果已无法继续，用当前步骤的 `blockedBy` 写清阻塞原因。
- 完成后设为 `已完成`，写入 `completedAt`。
- `已完成` 距离最后一次 `updatedAt` 超过当前固定 72 小时后，由角色知识快照设为 `已归档`，写入 `archivedAt`，并移动到 `archive/`。
- 用户手动要求不再展示时，也可以直接设为 `已归档`。

托盘 MVP 阶段保持只读，不创建、完成、删除或迁移计划。写入机制等计划 JSON 规范稳定后再接入。

## 托盘视图

当前：

```text
展示 status=进行中 的计划。
```

近期记忆：

```text
展示 Agent 最近主动记录、且仍处在可修改或待沉淀窗口内的记忆。
```

沉淀记忆：

```text
展示由记忆总结流程生成、Agent 不能直接修改的稳定记忆。
```

计划 / 记忆总览：

```text
展示正式计划汇总、近期记忆摘要、沉淀记忆摘要，以及它们的当前可用状态。
```

诊断：

```text
展示 manager、gateway、NapCat、heartbeat 和状态文件摘要。
```

托盘视图主要服务用户观察。是否把其中内容交给 Agent，由路由模板、摘要注入或未来 manager API 决定。
