<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-agent-interfaces_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent 需要关注的 Rabi 接口

人格的电脑/手机时间轴查询、来源选择与采集控制见[人格全天记录接口](persona-all-day-recording.md#本机接口)。读取事件不代表已经开启采集，空列表不证明全天没有活动。

> 状态：现行 Agent 接口指南。远端 Agent 设备链路仍为实验能力；其它接口按当前 Manager API 和测试核对。

本文说明 Agent 在处理 RabiRoute 消息时需要关注的 Rabi 内置接口。它不是普通用户操作手册，而是给 Agent 注入上下文后使用的接口说明。

这些接口用于让 Agent 主动维护计划和记忆，并把普通回复交回 RabiRoute。RabiRoute 负责存储、权限边界、符合人格配置条件的计划延迟归档、到点或显式发起的记忆整理请求、上下文注入和回复回传；Agent 需要关注的是：什么时候新增或更新计划、什么时候记录近期记忆、收到记忆整理请求时如何返回沉淀记忆，以及需要普通聊天回复时把内容交给回传接口。

### Agent 转投的模型设置

`POST /api/agent/threads` 的 `action=send` 优先使用调用方明确指定的 `model`；未指定时使用目标任务唯一所属 Route 的 `agentModel`，仍未配置则省略模型字段，沿用对应 Desktop Agent 的默认设置。不要因读取不到任务模型名而停止转投，也不要读取当前编码 Agent 的配置替代目标配置。主人格需要另选模型时，在原任务投递请求中传入 `model`，可同时指定 `reasoningEffort`；保留原 `taskBinding`。该设置用于新轮次，活跃轮次继续 `steer`。回执不确定时先核对原投递，不自动改投或重发。


## 计划与记忆写入合同

`focused` 消息包只给出本节入口。涉及计划、近期记忆、反馈或整理结果的写入前，必须先读本节及目标接口章节；文档不可读时停止该操作。写入仍受当前授权和 Action Gate 约束。计划状态先读取当前人格的 `plan-statuses`，不猜 key；附件通过计划 `attachments` 提交。

1. 从 Host 状态（安装版）、结构化 READY（源码版）或测试显式注入取得当前完整 Manager URL。每次请求设置最长 12 秒的有界超时。写入前 GET `/meta`，核对非空 `applicationGenerationId`、`managerInstanceId` 与当前 Host/READY 身份；普通业务请求要求 `health.live=true`、`health.requiredReady=true`，且 `health.state` 为 `healthy` 或 `degraded`。`businessReady=false` 或无关 Route 降级不阻断全部请求，计划恢复、目标路线等依赖由 Manager 对应接口判断。
2. 每项逻辑写入先生成并保存稳定 `Idempotency-Key` 与完整请求体。PATCH 计划/近期记忆、POST 计划反馈或回传记忆整理结果前，先 GET 对应单项资源或 feedback，把返回的强 ETag 原样放入 `If-Match`。禁止使用弱 ETag、`*` 或 `updatedAt` 替代版本。新增计划、新增近期记忆和发起整理带幂等键，不带 `If-Match`。
3. 超时、HTTP 503 或结果不确定时，保留原请求和原键，先权威读回；重试只能使用相同请求体和相同键，不创建第二项操作。HTTP 412 明确表示旧前置版本未提交：废弃旧键和旧 `If-Match`，重新 GET；原意仍适用时保存新键，以新强 ETag 提交。
4. 成功响应必须回显完全相同的 `Idempotency-Key`、返回强 ETag，且 body 的资源身份必须与目标一致。任一条件不满足时不得宣布成功。
5. 响应后再次有界 GET `/meta`，只复核两项身份是否与写前一致，不把无关健康变化当作切代；身份缺失、请求失败或身份变化均视为结果不确定，重新发现当前地址，保留原请求和键做权威读回，不自动重放。身份一致不消除原写请求超时、5xx 等已经存在的不确定性。通过资源读回核对实际结果。

精确 `GET /meta` 是诊断入口：取得有效响应并核对当前身份后即可返回健康详情，不要求 `live`、`requiredReady` 或业务就绪；地址约束、鉴权、超时、禁止重定向和身份校验仍保留。此豁免不能推广到其它 GET，一些读取会更新 `viewedAt`。本节降级访问与写后身份分离合同须由新版客户端实现；仍要求整体 `healthy` 的旧版插件需要升级，本文更新不代表运行中的插件已完成安装或验收。

跨人格投递另读“查询其它人格并投递消息”，保留 deliveryId、来源能力、目标 Route 和跳数合同；远端任务另读“远端 Agent 设备接口”。按需加载说明不会放宽这些要求。

## 消息投递：Rabi 可用时统一走 Rabi

此规则覆盖 Rabi 管理的群聊/私聊、附件、跨人格、持久 Agent 任务正文与续投、任务结果、callback / knowledge-callback 和 Outbox。普通界面对用户的答复、只读任务核对及同一任务内临时子 Agent 协作不属于旁路投递。发送仍须有原动作授权。

群聊/私聊和文件使用 `POST /api/agent/send`；跨人格使用 `POST /api/personas/{targetPersonaId}/messages`；持久任务正文与续投使用 Rabi 线程桥 `POST /api/agent/threads`；正式 callback 按来源需求合同调用。保留原 taskBinding、来源身份、requestId、tracking、引用和稳定幂等字段。Rabi 的 adapter 最终调用 NapCat、Desktop IPC 或其它平台是受管链路的一部分；调用方绕开 Rabi 才属于旁路。

只有按上节动态发现、核对身份并有界重试后确认 Rabi 不可用，才允许在原授权内使用已核实的当前平台入口。旧端口拒绝连接、Hook 概括提示、参数错误、权限/策略拒绝、owner 未加载或接口能力不足，都不能单独证明 Rabi 已挂。截图或旧任务中的地址不能替代当前 generation。Rabi 健康时应解决具体接口问题，不因工具方便而直发。

超时、断连和 5xx 可能发生在接收后；先读正式回执和目标接收证据。原投递结果不明时不换通道、不换 ID、不重复发送。旁路前须确认原消息未生效或具备跨通道去重证据，并核实目标身份；不得启动第二 Runtime、写会话文件、换目标或逃避审批。

旁路送达只证明平台接收，不能冒充 callback、knowledge-callback、Outbox 或计划状态已记录。保留原标识、目标、时间、摘要和真实平台回执；恢复后先查状态，再按接口支持方式补录，不为补回执重发正文，不直接修改真实存储。没有补录能力时明确保留“旁路已送达，正式回传待恢复”。下一次独立投递仍从 Rabi 开始。

## 消息查询：先 Rabi，无法完成时才绕过

正常群聊、私聊和最新反馈查询先走 Rabi。安装版通过 `RabiRouteHost.exe --command status --json` 获取当前 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`；源码模式使用结构化 READY 地址。读取 `<managerBaseUrl>/meta`，按上节合同核对 generation/实例身份；普通查询要求 `health.live=true`、`health.requiredReady=true`，接受 `healthy` 或 `degraded`，再由目标接口判断依赖是否可用。旧地址或瞬时失败时重新发现并有界重试；Hook 的概括性“Host 未运行”提示不能替代实际失败原因。不扫描端口、不读取退役实例锁、不直接启停 Manager。

当前 `GET <managerBaseUrl>/api/gateways` 提供 Route 诊断，其 `messageFiles` 包含近期消息摘要。NapCat 摘要合并群聊和私聊后仅返回最近 8 条，须按目标 Route、群/私聊、消息 ID 和时间筛选；它不是完整历史检索接口。`GET /api/roles/{roleId}/chat-history` 读取的是 Agent 最终回复，不能替代 QQ 群聊历史。
### 查询消息端历史消息

处理端需要恢复 QQ 群聊、QQ 私聊或其它消息端上下文时，使用只读接口：

```http
GET /api/roles/{roleId}/message-endpoint-history
```

常用参数：`query`（支持空格、英文逗号、中文逗号、顿号分隔的多个关键词）、`match=any|all`（默认 `any`）、`adapter`、`kind=group|private`、`sender`、`target`、`conversationKey`、`from`、`to`、`includeArchives=1`、`limit`。返回 `entries`、`count` 和 `coverage`；消息记录保留消息端、群/私聊会话键、发送者、目标、消息 ID、回复 ID 和附件摘要。`kind=group` 只查群聊入站消息，`kind=private` 只查私聊入站消息；`reply_sent` 等出站回复不应当当作用户原始反馈。

查询由有界交互读进程执行，不占用目录整理任务队列；客户端断开会取消排队任务或终止仍在读取的进程。另支持 `channel` 和 `maxChars`；`limit` 默认 50、最多 200，`maxChars` 默认及最多 200,000。成功结构和筛选语义不变；读池繁忙、超时或无法确认子进程终止返回 HTTP 503，业务参数错误仍返回 400，不把失败伪装成零条记录。此隔离不承诺任意大小历史都能在超时前查完，也不代表其它同步入口或线上健康已验收。

新会话的上下文恢复顺序：先从用户原话提取对象和关键词；再查本接口恢复消息端历史；涉及计划、记忆或原任务归属时另查 `knowledge/search`；最后回到当前文件、配置、代码或运行证据。查询覆盖范围必须随结果一起判断，空结果不等于系统从未出现过该消息。


只有 Rabi 无法访问、接口不可用或已确认摘要无法覆盖所需历史时，才使用当前 NapCat 或正式日志补查。Rabi 可用时从当前 Route 绑定和状态取得连接；不可用时只使用当前任务明确提供的连接、当前运行实例配置或已确认的正式日志。直连前用 `get_status`、`get_login_info` 核对在线状态及账号，再调用只读历史/消息接口。不得从旧任务、记忆或安装残留逐个试账号和端口；凭据不回显。鉴权拒绝不得通过旁路逃避权限。

空结果先核对目标及时间覆盖，不应归为连接故障。返回结果时区分“连接失败”“查到零条”“历史未覆盖”；绕过时说明原因、实际来源与时间范围。查询不授权发送、重放消息、修改配置或重启服务。下一次独立查询仍从 Rabi 开始。

## 上下文注入

RabiRoute 投递消息给 Agent 时，应在上下文中注入本接口文档链接，让 Agent 知道当前可以关注和使用哪些 Rabi 接口：

```text
Agent 需要关注的 Rabi 接口：{agentInterfaceDocPath}
```

推荐路径：

```text
docs/rabi-agent-interfaces.md
```

### 身份关系记忆接口

身份关系记录“这个消息端账号可能对应谁，以及哪些人与人、组织或项目关系已确认或待确认”，不等同于聊天记录、计划或当前发言立场。关系记录本身不分长期或短期；当前消息里的临时角色由情景记录表示。身份关系由人格私有保存。只有受支持消息端从真实发送者字段提供稳定 `senderStableId` 与 `endpointIdentityNamespace`，并且消息实际进入命中的 Route 投递时，系统才会自动建立“待认识”的候选参与者。昵称、群权限、一次自报或正文里转述的身份都不能触发确认。账号查询键必须同时提供 `platform`、`endpointIdentityNamespace` 和 `senderStableId`；不要使用 Route ID 代替其中任何一项。

```text
GET /api/roles/:roleId/identity-relations
GET /api/roles/:roleId/identity-relations?platform=<platform>&endpointIdentityNamespace=<namespace>&senderStableId=<id>&conversationKey=<optional>
PUT /api/roles/:roleId/identity-relations
POST /api/roles/:roleId/identity-relations/observations
```

`GET` 不带查询参数时返回账号、参与者和关系卡的当前视图；带完整账号键时返回该账号的解析上下文。`PUT` 一次只写一种记录：`endpoint_account`、`participant` 或 `relation_card`，用于人工确认、纠正和冲突处理。`POST .../observations` 供处理 Agent 在对话中发现新身份线索时使用：它只能更新当前账号已经关联的候选参与者和候选关系，不能写成 `confirmed`，也不能覆盖冲突记录。写入要附最小化证据引用，例如消息 ID、消息端、群/私聊会话或简短核对说明；不要复制整段私人聊天正文。多电脑同步后，若同一记录存在不一致的并发事件头，视图会标记 `conflicted`，给出 `conflictEventIds`，并在 `conflictCandidates` 中保留每个候选的完整记录，供人格页比较后修正；这类记录不会参与自动确认。要收敛冲突，`PUT` 必须明确提供该记录的全部关键字段，新的事件会替代所有当前事件头。

稳定账号键只能证明“这是同一个消息端账号”，不能单独证明“始终是同一个人在使用”。共用账号或证据互相矛盾时，`participantLinks` 可以保留多个候选；当前账号只有一个候选参与者时，观察请求可以省略 `participantId`，存在多个候选时则必须先通过带完整账号键的 `GET` 读取候选 ID，再明确指定。系统不会根据昵称、最近发言或最高置信度自行选择。

证据应区分作用。用户明确纠正、可核对的跨消息端归属和持续稳定的账号事实可以支持人工确认；自报姓名、别人转述、显示名以及词汇、句式、回复节奏等说话习惯一致性只能作为候选的辅助证据。即使多次表现一致，也不能单独创建确认映射。来源不能提供稳定发送者标识，或者自报只存在于转发、引用、附件文字等不可信上下文时，Agent 必须保持未识别，不得调用观察接口把它合并到既有人物。

说话习惯档案属于参与者记录，只能通过受审阅的 `PUT` 更新，不能由观察接口从未归因消息中自动学习。`speakingHabits` 每项包含 `dimension`、自然语言 `description`、可选 `confidence` 和 `evidenceRefs`；证据至少要有一条作者已经确认的 `messageId`。允许的维度为 `sentence_opening`、`sentence_length`、`stance_expression`、`emotion_threshold`、`analogy_source`、`punctuation`、`reader_relationship`、`value_preference`、`information_order`、`avoidance`、`imperfection`、`scene_boundary`。共享账号中作者仍不确定的消息不得写入任何人的档案。

```json
{
  "kind": "participant",
  "participantId": "participant-example",
  "speakingHabits": [
    {
      "dimension": "sentence_opening",
      "description": "常先指出当前判断，再补条件和未确定项。",
      "confidence": 0.75,
      "evidenceRefs": [
        { "messageId": "confirmed-author-message-id", "note": "作者已经人工确认。" }
      ]
    }
  ]
}
```

```json
{
  "platform": "napcat",
  "endpointIdentityNamespace": "bot:example",
  "senderStableId": "example-user",
  "participantKind": "person",
  "participantDisplayName": "对方明确自述的称呼",
  "aliases": ["本轮出现的新称呼"],
  "conversationKey": "napcat:group:example",
  "evidenceRefs": [
    {
      "messageId": "example-message-id",
      "conversationKey": "napcat:group:example",
      "note": "只写身份线索和判断依据，不复制整段聊天。"
    }
  ]
}
```

人格页把同一读取结果投影为“已识别身份”和“未识别身份”。已识别人物使用整张卡片作为入口，在同一个身份工作区内查看和编辑参与者资料、说话习惯、消息端账号与关系；参与者、账号和关系仍通过独立 `PUT` 保存，不构成一次事务。独占账号放在唯一人物中；已经知道使用者范围的共用账号同时出现在每个可能使用者中，并标记“共用”，但解析结果仍保持多人候选。“未识别身份”按 QQ、微信、声纹等消息端分类，容纳尚不知道对应人物、候选尚未指向已识别人物或存在冲突的账号。页面会在身份修正或人格同步事件后刷新；共用账号的单条消息归因、其他候选和冲突仍只能作为核对材料，不能被当作项目归属或执行授权。

声纹在概念上也是消息端账号。当前通用账号键使用 `platform=voice`、`endpointIdentityNamespace=host:<处理主机 ID>` 和 `senderStableId=voiceprintId`；一段多人录音可以关联多个账号。当前版本已把语音归类工具放进同一个“身份定位”区域，但旧数据仍由下文的 `voice-identities` 兼容接口和文件保存。不要同时向两套接口重复写同一条判断；完成统一数据迁移前，声纹的“这是我 / 其他人”、覆盖率和冲突读回仍以下文接口为准。

### 情景记录

```text
GET /api/roles/:roleId/conversation-situations?limit=20
GET /api/roles/:roleId/conversation-situations/:situationId
```

消息实际投递时会生成这份只读情景记录。它没有聊天正文，只保留会话和消息标识、关系卡派生的项目线索、附件/身份歧义以及 `mayParticipate=true`、`mayCreateOrUpdateCurrentProjectRecords=false`。它用于人工审阅主动智能是否把“可参与讨论”误解成“应负责当前项目”；接口不能用来创建、确认或授权项目动作。

```json
{
  "kind": "endpoint_account",
  "platform": "napcat",
  "endpointIdentityNamespace": "instance:qq-main",
  "senderStableId": "example-user-id",
  "participantLinks": [
    {
      "participantId": "participant-example",
      "status": "confirmed",
      "confidence": 1,
      "evidenceRefs": [{ "messageId": "example-message-id" }]
    }
  ]
}
```

候选映射只用于核对，不能用于真实称呼、授权、项目归属或执行。`confirmed` 也只说明身份或关系本身；它不能绕过明确委托、项目范围和外部动作审批。身份关系不进入 `knowledgeMatches`，也不需要为每条消息提交 `knowledge-callback`。

同时默认注入轻量索引：

```text
当前计划：
- plan-001：完善计划和记忆机制文档

近期记忆：
- memory-001：计划和记忆由 Agent 主动维护
```

近期记忆统一指 `memory/recent/` 里的记忆。默认配置下，最近 24 小时内更新或查看过的近期记忆会直接注入；超过 24 小时且尚未沉淀的近期记忆不默认显示，只有用户消息命中标题或 `keywords` 时才会被召回。默认注入和可编辑窗口取 `updatedAt` / `viewedAt` 中较新的时间；沉淀窗口取 `updatedAt` / `recalledAt` 中较新的时间。按 ID 查询只刷新 `viewedAt`，更新刷新 `updatedAt` 和 `viewedAt`，关键词命中召回同时刷新 `viewedAt` 和 `recalledAt`。

RabiRoute 还会注入 `[处理前上下文确认]`。它会从未归档计划、近期记忆和沉淀记忆中按 ID、标题和 `keywords` 做轻量打分，列出默认最多 5 条高相关必读项。Agent 在回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按该小节里的 GET 路径读取内容；不能只凭标题行动。若必读项无法读取或内容不足以确认，应说明上下文无法确认，或先向用户追问。

### 只启用知识接口的本机 Manager 模式

直接在 Codex 中维护角色计划或记忆、但不希望 Manager 自动启动已启用网关、RabiLink Relay 或局域网发现时，可以在启动 Manager 前设置：

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

此模式仍提供 `/meta`、计划、记忆和校验等 Manager HTTP 接口；`GET /meta` 会返回 `managerAutostart: false`。它关闭已停止 Route 的自动启动和文件监视器，不移除显式运行控制接口。若调用方已经显式启动某条 Route，之后又通过 Manager 保存配置，Manager 仍会重启该运行中 Route 以应用新的会话、模型和消息端设置；否则界面保存态会与真实投递态分叉。调用方仍不得在没有相应授权时请求启动、重启、触发、回传或外发动作。生产托盘和正常消息路由不设置该变量，行为保持不变。

### Codex Hook 上下文接口

Codex 插件必须把 Hook 原始事件提交给 Manager，而不是在插件内复制人格、计划、记忆或召回逻辑：

```http
POST /api/codex-hook/context
```

请求体沿用 Codex Hook 字段，至少包含 `hook_event_name` 和真实 `session_id`。当前接受：

- `SessionStart`：提供 `source`；
- `UserPromptSubmit`：提供 `turn_id` 和 `prompt`；
- `PreToolUse`：提供 `turn_id`、`tool_name`、`tool_use_id` 和 `tool_input`；
- `PostToolUse`：在上述字段外提供 `tool_response`。

Manager 负责解释严格的 `[rabi:*]` 控制标记、维护 session 绑定，并把事件标准化为 `session_start`、`user_prompt`、`reasoning_pre_tool` 或 `reasoning_post_tool`。这些事件与 RabiRoute 消息投递的 `message_delivery` 都进入同一个 `RabiContextManager`；只有它调用 `roleKnowledgeSnapshot()`、执行计划归档和 `viewedAt` 策略，并在 `data.additionalContext` 中返回可注入内容。未绑定会话返回空字符串。

推理期触发只返回本轮新增的相关知识。相同 `turn_id` 内，Manager 按条目类型、ID 和修订时间去重；Pre/Post 重复看到同一条目时既不重复注入，也不重复刷新 `viewedAt`。`preview` 策略不归档计划、不刷新 `viewedAt`、不创建 consolidation run。

Rabi PC 可按完整 session ID 主动维护绑定：

```text
GET    /api/codex-hook/roles
GET    /api/codex-hook/sessions
GET    /api/codex-hook/sessions/:sessionId
PUT    /api/codex-hook/sessions/:sessionId  { "roleId": "YeYu" }
DELETE /api/codex-hook/sessions/:sessionId
GET    /api/codex-hook/doctor
```

绑定状态属于 Manager 私有运行数据。插件不得保存第二份 binding、角色根、关键词索引或记忆正文；Manager 离线时只允许失败开放并说明本轮未注入，不能使用插件本地缓存伪造成功。

### 智能手表 / 手环健康查询

启用 `wearable` 消息端后，结构化健康观测按角色进入独立时间线，不进入普通聊天记录。Agent 可使用本机 Manager API 查询，而不是依赖提示词里复制全部健康数据：

```text
GET   /api/roles/:roleId/health/state
GET   /api/roles/:roleId/health/history?metric=heart_rate&from=<ISO>&to=<ISO>&limit=100&order=desc
GET   /api/roles/:roleId/health/summary
GET   /api/roles/:roleId/health/config
PATCH /api/roles/:roleId/health/config
POST  /api/roles/:roleId/health/observations
```

`state` 和 `summary` 都包含时效信息；`unknown` 或 `stale` 不得解释成确定的睡着、醒来或健康状态。经 RabiLink Relay 输入并命中心率/睡眠规则的观测会形成 `wearable_health_alert` Agent 事件。认证秘钥、Relay token 和原始敏感元数据不得作为观测字段传入。完整字段、配置和验收边界见 [`rabilink-wearable-health.md`](./rabilink-wearable-health.md)。

### 查询其它人格并投递消息

“人格”是面向用户和 Agent 的正式名称；现有 `roleId`、`/api/roles/*` 和 `data/roles/` 是兼容保留的内部名称。人格列表提供专用接口，不需要从 Route 管理结果中拆解：

```http
GET /api/personas
GET /api/personas?addressable=true
GET /api/personas/:personaId
```

列表返回人格的 `personaId`、显示名称、是否可以接收消息，以及绑定的 Route。`addressable=true` 只返回至少绑定一个已启用 Route 的人格；只有一个已启用 Route 时会同时返回 `defaultRouteId`。

当前人格需要联系另一个人格时，使用目标人格路径，并从当前 `AgentPacket.replyContext` 读取 `runtimeRouteId` 和 `personaMessagingCapability`。凭据同时绑定 Route 与人格，不能用另一个 Route 或人格的身份复用：

```http
POST /api/personas/:targetPersonaId/messages
Content-Type: application/json

{
  "deliveryId": "stable-unique-delivery-id",
  "sourceRouteId": "source-route",
  "sourceCapability": "value-from-replyContext.personaMessagingCapability",
  "targetRouteId": "optional-when-target-has-one-enabled-route",
  "conversationId": "optional-stable-conversation-id",
  "inReplyToMessageId": "optional-message-id-being-answered",
  "hopCount": 0,
  "text": "请检查今天的构建状态。"
}
```

`deliveryId` 必填，并由调用方为一次业务投递稳定生成。相同 ID 与相同请求只执行一次，重试返回同一完成结果；相同 ID 携带不同内容返回 `409`。请求结果不明确时先查询回执，不要直接生成新 ID 重发：

```http
GET /api/personas/messages/receipts/:deliveryId
```

发送 Route 和接收 Route 都必须已启用；目标人格有多个已启用 Route 时必须提供 `targetRouteId`，不能猜测；不能通过这个接口给自己发送消息。`hopCount` 必须是非负整数，最大为 `8`。成功响应为 HTTP `202` 且 `status=delivered`，表示消息已经沿目标 Route 的现有 `role_panel_message` 路径交给目标处理端。服务只在处理端接收后记录 `status=sent`；失败记录只代表一次尝试。

跨人格投递是显式的单向消息，不会自动建立双向聊天。目标人格的普通回复只留在自己的角色面板。需要回复来源人格时，目标人格必须再次调用 POST：把新的 `deliveryId` 用于本次回复，沿用收到的 `personaConversationId`，令 `inReplyToMessageId` 等于当前消息 ID，并把 `personaMessageHopCount` 加一。超过 `personaMessageMaxHops` 时停止继续互投。

需要向消息端发送内容时，AgentPacket 会同时给出明确发送接口、已经按当前来源生成的请求模板，以及只读来源上下文：

```text
明确发送 API：`<managerBaseUrl>/api/agent/send`；安装版从 Host `status --json` 发现本代地址，源码模式由 Manager 标准输出提供。
明确发送请求模板：{"deliveryId":"<stable-id>","sender":{"agentType":"primary_persona","sessionId":"<当前 Codex 主人格完整会话 ID>"},"routeId":"main","channel":"napcat","styleValidation":1,"params":{"target":"group","groupId":"456","instanceId":"default","replyToMessageId":"<能引用时填源消息 ID；不引用时填空字符串>","replyImageDescriptions":[]},"payload":{"type":"text","text":"<正文>"}}
来源上下文（只用于核对来源，不可直接作为发送参数）：{"routeKind":"direct_at","messageId":"123","groupId":"456"}
```

## 明确发送接口

Agent 的外部消息统一使用一个发送接口。旧 `/api/agent/replies` 已取消；`/api/agent/send` 不接受“把 replyContext 原样传回后自动猜目标”的用法。

```http
POST /api/agent/send
```

请求体固定包含：

- `deliveryId`：本次业务发送的稳定 ID，重试时保持不变；
- `sender.agentType`：调用发送接口的 Agent 角色标识；
- `sender.sessionId`：调用发送接口的 Agent 完整会话 ID；
- `routeId`：精确的已启用 Route ID；
- `channel`：发送渠道；
- `params`：该渠道的目标参数；
- `payload`：`text`、`image`、`voice` 或 `file`；
- `styleValidation`：枚举值 `1 | 0`，默认 `1`。`1` 使用人格绑定的目标语言风格 Skill 校验文本；`0` 跳过本次校验；
- `tracking.requirementId`：可选，用于关联消息处理看板，不能决定发送目标；回复已登记的消息处理需求时必须填写；
- `tracking.sendContextReviewToken`：消息处理需求在发送前完成最新群聊上下文核对后取得的短期凭证，只对同一需求、发送者会话、目标和正文有效。

当主 Agent 为 Codex 且开启“仅允许主人格发送消息”Hook 时，唯一允许的发送方是绑定的 Codex 主人格任务：`sender.agentType=primary_persona`，且 `sender.sessionId` 必须与 `codexThreadId` 完全一致。其它情况下以注入的请求模板为准。

QQ 群文本示例：

```json
{
  "deliveryId": "send-example-001",
  "sender": {
    "agentType": "primary_persona",
    "sessionId": "019f0000-0000-7000-8000-000000000001"
  },
  "routeId": "main",
  "channel": "napcat",
  "styleValidation": 1,
  "params": {
    "target": "group",
    "groupId": "456",
    "instanceId": "default",
    "replyToMessageId": "123",
    "replyImageDescriptions": [
      "图片展示动态文字变长后底框随内容扩展，想表达背景宽度需要跟随正文变化。"
    ]
  },
  "payload": {
    "type": "text",
    "text": "收到，我来处理。"
  },
  "tracking": {
    "requirementId": "message-requirement-001",
    "sendContextReviewToken": "<POST send-context 返回的 token>"
  }
}
```

人格可在 `personaConfig.json.languageStyle.styleSkillUrl` 绑定自己的语言风格 Skill。不同人格可以绑定不同 URL。URL 可指向 Skill 目录、`SKILL.md` 或 `references/style-data.json`；Manager 从其中读取程序化 JSON 规则。

`styleValidation=1` 且校验不通过时，Manager 返回 `409` 和 `status=style_confirmation_required`，附带规则编号、段落、原因和命中证据，消息尚未进入 Outbox。Agent 确认原文符合本次需求后，使用同一 `deliveryId` 重发，并把 `styleValidation` 改为 `0`。这次跳过不修改人格绑定，后续发送恢复默认校验。

通用校验接口只分析文本，不发送消息：

```http
POST /api/language-style/validate
```

```json
{
  "text": "待检查正文",
  "styleSkillUrl": "file:///path/to/style-skill",
  "scope": "outbound_message",
  "prompt": "可选的来源问题"
}
```

接口返回 `passed`、`status`、`violations`、`checkedRuleIds` 和 `skippedRuleIds`。Codex Stop Hook 使用同一接口，只在校验不通过时提示，不阻止或改写 Codex 输出。

当前渠道和必填目标：

| `channel` | `params` 必填目标 |
| --- | --- |
| `napcat` | `target=group + groupId`，或 `target=private + userId`。群聊必须显式提交 `replyToMessageId`：能取得来源消息时尽量填写真实消息 ID；明确不引用时填写空字符串 `""`。引用消息含图片时，`replyImageDescriptions` 必须按原图顺序逐张填写图片内容和想表达的意思；缺失、数量不符、空泛描述、图片不可读或来源消息无法核对都会在进入幂等发送前报错。完全省略 `replyToMessageId` 也会在进入 Outbox 前返回可行动错误。同一来源消息在 10 分钟内已有成功回复时，新的改写默认返回 `409`；只有确有新增事实的后续回复才显式填写 `allowAdditionalReply=true`。 |
| `wecom` | `chatId` |
| `feishu` | `chatId` |
| `weixin` | `sessionId` |
| `rabilink` | `targetDeviceIds` 或 `targetDeviceKinds`；非主动发送还要 `sourceMessageId` |
| `speech` | 可选 `sessionId`；该渠道只代表 RabiSpeech 合成/播放，不代表 QQ 已发送 |
| `fennenote` | `sessionId`、`mode=message/playback` |
| `role_panel` | `roleId` |
| `plan_feedback` | `roleId`、`planId`、`kind=guidance/approval` |

Route 的消息端输出策略仍会检查开关、支持的 payload 和允许的文件根目录。请求中的 `channel` 是唯一发送管道；Route 原有 `outputAdapter`、来源消息类型和 `replyContext` 都不能把它改成另一渠道。

### 消息处理需求与看板接口

启用消息处理 Agent 后，Manager 会给每个已投递的消息组分配 `messageProcessingRequirementId`，并把它放进 AgentPacket 的 `replyContext` 和消息处理任务说明。Agent 必须通过结构化接口结束本轮，不能只在 Codex 最终输出里说“已处理”。

```http
POST /api/message-processing/requirements/:requirementId/outcome
```

直接回复时先提交决定，使需求进入 `awaiting_send`，再完成“发送前上下文核对”，最后调用明确发送接口。Manager 只有在 `channel` 与原消息端一致、结果为 `sent`，且 QQ 等渠道带真实发送标识时才关闭看板项：

```json
{
  "decision": "reply",
  "reason": "用户明确要求确认命名和预制位置"
}
```

发送前不能只依赖 AgentPacket 创建时附带的最近消息，因为处理期间群里可能已经有人回答，或者另一名 Agent 已经发过同义回复。先读取 Manager 当前保存的有界双向消息：

```http
GET /api/message-processing/requirements/:requirementId/send-context?sourceMessageId=:sourceMessageId
```

单条回复必须传本次准备引用的 `sourceMessageId`。响应保留有界上下文，并把 `requiredReviewIds` 缩小为该主消息和从消息记录解析出的明确回复链；同一聚合需求里的其它消息仍参与上下文版本计算，但不要求逐条声明为本次正文依据。Agent 判断拟发送内容仍合适后，把这次精确发送请求作为 `proposedSend` 提交审核：

来源消息较早、已超出近期窗口时，Manager 只会从该需求所属人格的正式 `group-messages.jsonl` 恢复同 Route、同 `sourceMessageId` 的唯一记录。找不到、出现重复记录或 Route 证据冲突时，GET 失败关闭，不会扩大到其它群或其它历史需求。

上下文读取使用同一有界交互读池。发送校验才额外恢复完整来源和附件证据，并与最近上下文合并在一次读任务中；GET 和审批不增加这项额外恢复。最近窗口沿用 80 条、24,000 字符预算，必要时允许附加 1 条精确来源；记录与来源、附件元数据合计的 UTF-8 JSON 最多 1 MiB，超限拒绝，不截断证据。读取前后发现相关文件清单或元数据变化会失败关闭；这不是跨文件原子快照。

等待结束后重新读取需求并核对版本、来源归属、凭证有效期、审查会话、上下文版本和发送指纹。变更或读取失败要求重新审查，不自动循环校验。发送入口冻结请求；校验成功或失败后都权威重读同一 `deliveryId` 回执。只有已持久化的 `completed` 回执且包含结果才交原幂等发送服务核对指纹与发送者后重放。`reserved`、`sending`、`uncertain` 不能借此发起新发送；重放期间回执消失也不会重新发送。保留原 `deliveryId` 并查询回执，不以新 ID 绕过未决状态。

```http
POST /api/message-processing/requirements/:requirementId/send-context
```

```json
{
  "contextVersion": "<GET 返回的版本>",
  "reviewedContextIds": ["<本次 sourceMessageId 和明确回复链对应的 requiredReviewIds>"],
  "reviewedByThreadId": "<当前完整会话 ID>",
  "reason": "群里尚无人回答，拟发送内容仍对应当前问题。",
  "proposedSend": {
    "deliveryId": "send-example-001",
    "sender": {
      "agentType": "primary_persona",
      "sessionId": "019f0000-0000-7000-8000-000000000001"
    },
    "routeId": "main",
    "channel": "napcat",
    "params": {
      "target": "group",
      "groupId": "456",
      "instanceId": "default",
      "replyToMessageId": "123"
    },
    "payload": {
      "type": "text",
      "text": "收到，我来处理。"
    },
    "tracking": {
      "requirementId": "message-requirement-001"
    }
  }
}
```

审核通过后，把返回的 `sendContextReviewToken` 加入 `tracking`，并原样发送同一请求。凭证两分钟后失效；审核后出现新消息、需求状态改变、发送者会话改变，或目标、引用消息、正文发生变化时，Manager 都会拒绝发送并要求重新读取上下文。已有 Agent 回复同一来源消息时，改写措辞仍视为重复；确有新增事实的后续说明必须显式填写 `allowAdditionalReply=true` 和原因。

受跟踪发送在引用和图片检查阶段只使用本次审批绑定的精确正式来源证据。需求里过时的 `conversationKey` 或 `replyContext.groupId` 不能把来源改到另一群；正式群、Route、实例与发送目标不一致，来源记录不唯一，或图片附件没有标为已审核时都会拒绝发送。普通未跟踪发送仍按原 Route 历史查找，不使用这项恢复。

这项检查适用于所有 Agent 类型。只要 `replyToMessageId` 指向已登记消息处理需求的来源消息，主人格或其它 Agent 也不能省略 `tracking.requirementId` 绕过看板和发送前核对。

普通群讨论可以决定不回复，但必须说明原因。直接 @、直接回复、私聊和计划进展通知不能用泛化的 `agent_judgement` 关闭，只接受重复、他人已回答、消息撤回、来源无效等受限原因：

```json
{
  "decision": "no_reply",
  "reasonCode": "answered_by_other",
  "reason": "群内已有成员给出完整答案"
}
```

如果后续同题消息已经改变或补全原消息，可以使用 `reasonCode=superseded_by_followup`，但原因中必须写明取代它的后续消息 ID 或真实发送回执，不能只写“后面处理了”。

只有图片、视频或文件而没有文字问题的消息，在附件已经下载核对并写入关联计划后，可以使用 `reasonCode=attachment_consumed`；必须同时提交 `planId`，并在原因里保留原 `sourceMessageId`。含有文字问题的消息不能使用这个原因跳过回复。

Manager 不判断群消息的业务含义。每个新消息需求在关闭或准备回复前，消息处理 Agent 都必须核对原消息、附件和必要的回复链，并提交 `projectFactAssessment`：

新登记的消息需求还带有 `source.evidenceReviewRequired=true`。Manager 会在 `source.messageIds`、`source.replyChainMessageIds` 和 `source.attachments` 中保留聚合需求的完整证据。NapCat 图片会在收到时立即保存到运行目录，并通过 Desktop IPC 作为 `localImage` 随当前任务输入；只看到 CQ 代码、文件名或 URL 不算看过图片。准备回复或关闭前，outcome 必须同时提交：

```json
{
  "sourceEvidenceReview": {
    "reviewedMessageIds": ["source-message-id", "quoted-message-id"],
    "replyChainChecked": true,
    "attachmentReviews": [
      {
        "attachmentId": "source-message-id:image:1",
        "status": "reviewed",
        "observation": "图中是动态文案底框，当前文字长度明显短于底框最大宽度。"
      }
    ],
    "evidence": "已核对当前消息、引用消息和随任务附带的图片。",
    "reviewedAt": "2026-08-11T12:00:00.000Z",
    "reviewedByThreadId": "完整消息处理任务 ID"
  }
}
```

`reply` outcome 可以先提交已经核对的证据并进入 `awaiting_send`。POST send-context 会根据 `proposedSend.params.replyToMessageId` 重新计算精确子集：本次主消息、它的明确回复链，以及被引用消息自带或被正文明确提到的附件。`sourceEvidenceReview` 和 `projectFactAssessment` 必须覆盖这个子集。群引用回复的来源归属只在 `kind=message_reply` 中计算；`plan_progress_notification` 等派生通知不拥有原群消息的引用回复权。同一 Route、同一消息组和同一来源消息的历史重复只允许 `createdAt` 最新的 canonical `message_reply` 继续审批；没有 `message_reply` 时失败关闭，不能由计划通知承接。不同消息组、不同 Route、最新项不唯一、回复链记录缺失、相关附件为 `unavailable`，或正文依赖了未纳入事实核验的消息时同样失败关闭。同一聚合需求中无关消息的不可用附件不会阻止这条回复。`no_reply` 关闭整个需求时仍必须覆盖全部消息和附件。这个证据核对与项目事实判断分开保存：前者证明 Agent 看了什么，后者记录 Agent 如何判断长期项目事实。

先通过 `GET /api/message-processing/requirements/{requirementId}` 读取需求。响应里的 `knowledgeMatches` 是 Manager 根据角色计划和记忆的标题、ID、关键词生成的候选关联。Agent 必须读取每个候选项，并逐项调用 `POST /api/message-processing/requirements/{requirementId}/knowledge-callback`。

回调的 `result` 可使用 `unchanged`、`updated`、`created`、`not_relevant`、`deferred`；`responseAction` 可使用 `none`、`reply`、`discuss`、`handoff`。`unchanged` 也必须提供具体核对依据。`updated/created` 必须提供 `recordType`、`recordId`、`verifiedAt`，而且目标计划或记忆必须包含原消息 ID，Manager 才会接受。`deferred` 不是最终结果。

Manager 从投递时起为未完成回调设置一小时期限。到期后，它会把缺失项再次投给原消息处理 Agent，并重新设置一小时期限。若 `knowledgeMatches` 为空，Agent 仍须从附件、回复链和消息对象提取至少两组同义关键词主动查询，不能把未命中直接当成无需处理。

```json
{
  "projectFactAssessment": {
    "status": "critical",
    "reviewedMessageIds": ["msg-schedule-1"],
    "replyChainChecked": true,
    "evidence": "原文是内部上线目标，措辞为大概按照，不是公开定档。",
    "assessedAt": "2026-08-05T06:00:00.000Z",
    "assessedByThreadId": "完整消息处理任务ID",
    "facts": [{ "kind": "schedule", "evidence": "示例项目暂以2030年10月15日为内部目标，尚未正式定档" }]
  }
}
```

`status=none` 表示 Agent 已核对并判断没有需要长期保存的项目事实；此时不能携带 `facts`。`status=critical` 必须携带至少一条 `facts`。Manager 只校验结构、消息 ID 覆盖和状态，不使用关键词替 Agent 判断。

当 Agent 判断消息包含上线/公测排期、版本范围、批准/否决、负责人变更、取消/延期或发布版本等项目事实时，即使无需群内回复，也不能直接关闭。Agent 应把事实写入计划、绑定记忆或明确的项目文档；随后在 outcome 中同时提交记录证据：

```json
{
  "decision": "no_reply",
  "reason": "群内无需重复发言，但内部上线目标已经写入统一包计划。",
  "criticalFactDisposition": {
    "status": "recorded",
    "record": {
      "type": "plan",
      "planId": "plan-example-release"
    },
    "evidence": "messageId=msg-schedule-1；已核对原文和回复链，并更新计划与绑定记忆。",
    "verifiedAt": "2026-08-05T06:00:00.000Z"
  }
}
```

已有同一记录时使用 `status=duplicate` 并提供带类型的 `record`、证据和核对时间。计划使用 `{ "type": "plan", "planId": "..." }`，记忆使用 `{ "type": "memory", "memoryId": "..." }`，项目文档使用 `{ "type": "document", "relativePath": "docs/..." }`。文档路径必须相对于当前项目，绝对路径和跳出项目目录的路径会被拒绝。尚未完成判断或记录时只能 `handoff` 给秘书、计划 Agent 或主人格，`reply` 和 `no_reply` 都会被 Manager 拒绝。消息处理看板的 `factAssessmentOpen` 用于发现尚未完成 Agent 语义判断的需求，`criticalFactOpen` 用于发现已判断为项目事实但尚未登记完成的需求。

Manager 还会按 `record` 的类型读取对应计划、记忆或项目文档，确认记录真实存在并至少包含一个原始群消息 ID。仅提交一个看似有效的业务 ID、路径，或只在 `evidence` 中自述“已更新”，都不能关闭事项。

转交秘书、计划 Agent 或主人格时，调用 `/api/agent/threads` 的 `send` 动作，并增加结构化字段。Manager 只在目标 Desktop owner 接受后把看板改为“已转交”；如已确定计划，应同时传 `planId`，让后续计划进展能够回到原群或私聊：

```json
{
  "action": "send",
  "threadId": "<target-task-id>",
  "cwd": "C:/Path/To/Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "<message-agent-task-id>",
    "sessionName": "当前消息处理任务名称"
  },
  "sourceThreadId": "<message-agent-task-id>",
  "sourceAgentType": "message_processing",
  "prompt": "请处理这个计划事项，并把结果返回来源消息处理任务。",
  "messageProcessing": {
    "requirementId": "<requirement-id>",
    "outcome": "handoff",
    "targetAgentType": "plan_agent",
    "planId": "<plan-id>",
    "planTitle": "<plan-title>"
  }
}
```

不需要额外接口。上述请求会直接返回投递结果。只有下面三个值同时成立，才表示目标 Codex Desktop 任务已经接收消息；这不表示对方已经完成业务：

```json
{
  "code": 0,
  "status": "delivered",
  "delivery": {
    "status": "delivered",
    "targetThreadId": "<target-task-id>",
    "acceptedBy": "codex_desktop_owner",
    "action": "started",
    "transport": "desktop-ipc"
  },
  "handoff": {
    "status": "recorded",
    "requirementId": "<requirement-id>"
  }
}
```

缺少 `prompt`、`sourceThreadId` 等参数时，同一次响应返回 `code=-1`、`status=failed`，并在 `error.field`、`error.message` 和 `error.retryable` 中说明原因。目标任务已经接收、但消息处理看板记录失败时，响应为 `status=delivered_tracking_failed`：此时不得再次向目标任务发送同一内容，只处理或上报 `handoff.status=tracking_failed`。

维护者和 WebGUI 可读取同一份状态：

```http
GET /api/message-processing/board?routeId=<gateway-id>&limit=100
```

返回项包含处理阶段、来源消息组、处理任务、转交、决定、发送回执、失败、超时和“Agent 已空闲但没有提交结果”标记。该接口是 Manager 状态的只读视图，不从日志重新推断业务状态。

### 受控外发幂等回执

`deliveryId`、`sender.agentType` 和 `sender.sessionId` 都是发送接口的必填字段。Manager 会在进入 Outbox 前把 reservation 持久化到运行期 `data/agent-send-idempotency/`；完成结果会原样保存发送者身份。同一个 `deliveryId` 和相同请求只执行一次，完成后重复 POST 返回原 `sent/draft/blocked/failed` 结果。相同 ID 携带不同发送者或其它不同请求返回 `409 conflict`，`reserved/sending/uncertain` 状态也失败关闭，不会自动重发。

NapCat 群回复另按 `routeId + groupId + replyToMessageId` 做短时保护。某条被引用消息在 10 分钟内已经成功收到回复时，换 `deliveryId`、换 Agent 或换一种说法再次发送都会被拒绝；Manager 重启后仍从近期成功回执恢复这项判断。确有新证据必须补充时，调用方可以显式提交 `params.allowAdditionalReply=true`，并对这次额外回复负责。这个字段不能用于绕过普通重复发送保护。

调用方在 POST 超时或收到空回执后，应先查询原 ID。不存在的回执返回 HTTP `404` 和 `idempotency.state=missing`；`in_progress` 继续回读，`uncertain` 或 `conflict` 禁止自动重发。只有原 `deliveryId`、原 payload 完全不变，并且 Manager 从同一 Route 的 Outbox 明确确认没有请求记录和终态记录时，才允许一次受控重试。Outbox 已记录请求但没有终态、记录的 payload 摘要不同，或受控重试仍没有终态时，都转为 `uncertain`：

```http
GET /api/agent/send/receipts/:deliveryId
```

如果只有消息端回执 ID，可以按渠道反查最多 100 条匹配记录：

```http
GET /api/agent/send/traces?channel=napcat&sentMessageId=:platformMessageId&routeId=:optionalRouteId
```

返回项包含 `deliveryId`、完成时间、Route、目标和 `sender.agentType + sender.sessionId`。旧回执没有发送者字段，因此只能从启用本合同之后的新发送记录追溯。当前字段是调用方声明并由 RabiRoute 持久保存的来源；它用于审计，不等同于对 Agent 会话的加密认证。

只有回执返回 `status=sent` 且包含目标通道要求的真实标识（QQ 文本为 `sentMessageId`）时，调用方才能继续做平台回读并把业务状态标成已发送。`deliveryId` 只提供 Outbox 请求幂等，不代替 NapCat/外部平台的真实存在验证，也不是自动重试队列。公开示例应使用占位 ID，不把运行期回执文件提交到仓库。

### 语音消息端人格回复

当来源上下文显示 `routeKind=voice_transcript`、`adapterType=speech` 和 `characterTtsDialogue=true` 时，本轮来自 RabiPC 语音消息端。Agent 使用注入模板调用 `/api/agent/send`，明确填写 `channel=speech`、当前 `routeId`、`params.sessionId` 和文本 payload。Outbox 从 Route 读取人格、声线、TTS 模型、语言和自动播放设置；成功时表示请求进入 RabiSpeech 合成或主机级 FIFO，不表示 QQ、企业微信或其它渠道已经发送。

这个状态只由 `speech` / RabiSpeech 消息端的转写事件注入。不要把 QQ、角色面板或其它文字入口手工标记成语音状态，也不要绕过 Outbox 直连 worker，否则会丢失来源绑定、策略检查和会话隔离。

手机音频流虽然复用同一套 RabiSpeech ASR，但来源是 `rabilink`。发送回原设备时必须明确填写 `channel=rabilink`、`params.sourceMessageId` 和 `params.targetDeviceIds`；注入模板只使用稳定 `sourceDeviceId`，不会把临时 `sourceStreamId` 当设备。它不是 `speech` 发送，因此不会误触发独立语音端的 TTS/FIFO 规则。

### 声纹证据与人格身份解释

RabiRoute 投给人格的语音记录只保留不透明声纹/聚类 ID、`Speaker 1` 等分段标签、分数和判定证据，不携带人名，也不把任何声纹标成“用户”。收到记录的人格应结合自己的关系、记忆和会话上下文解释身份；不同人格可以对同一声纹形成不同关系认知。

每条新语音同时携带 `sourceHostId/sourceHostName`。声纹 ID 只在产生它的处理主机范围内解释，因此人格身份键是“处理主机 + 声纹 ID”，不能把两台 PC 恰好相同的 cluster 字符串当成同一个人。人格自己的结构化解释以追加式文件 `data/roles/<RoleId>/voice/voice-identities.jsonl` 为真源；它会随人格目录同步，而 RabiSpeech、Manager 和 Route 都不会替人格填写 `displayName`、`relationship` 或 `isUser`。

查询或更新当前人格的解释：

```http
GET /api/roles/:roleId/voice-identities
GET /api/roles/:roleId/voice-identities?sourceHostId=<host>&voiceprintId=<voiceprint>
PUT /api/roles/:roleId/voice-identities
Content-Type: application/json
```

```json
{
  "sourceHostId": "example-host-guid",
  "sourceHostName": "Studio PC",
  "voiceprintId": "unknown-cluster-7",
  "displayName": "老板",
  "relationship": "我的用户",
  "isUser": true,
  "aliases": ["老板"],
  "notes": "由当前人格结合持续会话确认"
}
```

`isUser` 没有系统默认值；未知时应省略，而不是写成 `false`。重复提交相同解释不会新增事件；修正会追加新事件，`deleted=true` 会追加 tombstone，不会原地改写共享历史。每个新事件会自动记录它收敛的上一组事件，调用方不需要也不能手工维护父事件。

两台 PC 从同一共同版本并发修改同一个 `sourceHostId + voiceprintId` 时，JSONL 并集合并会保留两个事件头，不再按文件顺序静默选择最后一条。`GET` 返回 `conflicted=true`、`conflictFields` 和带 `eventId/deleted` 的 `conflictCandidates`。如果 `isUser` 或删除状态发生分歧，`voice-transcripts` 把相关分段归为 `conflict`；只有称呼、关系或备注分歧但所有分支的 `isUser` 一致时，用户/他人分类仍可保留，同时关系资料继续标记待收敛。人格再次 `PUT` 自己确认的最终解释时，Manager 会自动 supersede 当前全部事件头，下一次多电脑同步即可收敛。AgentPacket 会提供 `voiceIdentitiesPath`、处理主机、全部声纹 ID、已知关系和待收敛字段；这些内容明确标记为“人格记录”，不是主机推断。

需要从一天或一段时间的会话中区分“当前人格确认的用户、其他人、未知或冲突声纹”时，使用人格级只读视图，而不是自行修改原始消息：

```http
GET /api/roles/:roleId/voice-transcripts?from=<ISO>&to=<ISO>&speaker=user&limit=200&includeArchives=true
```

`speaker` 可为 `user`、`other`、`unknown` 或 `conflict`。返回结果在读取时联结 `conversation/current.jsonl`（可选归档）与当前人格的 `voice/voice-identities.jsonl`，提供整条记录的 `personaClassification`、逐分段 `classification` 和匹配身份。`mixed` 表示同一录音包含多种分段结论。这个视图不把称呼或 `isUser` 回写到主机原始消息和人格会话账本；人格关系修正后再次查询会立即得到新解释。

响应中的 `matchedCount` 和 `summary` 都基于完整筛选结果计算，不受明细 `limit` 截断。`summary` 给出总录音/分段数、录音时长、说话人时长、`user/other/unknown/conflict` 分类统计、已解释时长和 `coverageRate`；`unresolvedVoiceprints` 按 `sourceHostId + voiceprintId` 汇总仍未知或冲突的声纹、分段数、时长和最后出现时间。它们只是读取时派生的覆盖率视图，不是新的账本，也不会写回人格文件。

当前路由消息明确询问声纹、说话人、“哪些是我/用户说的、哪些是别人说的”或全天录音归类时，AgentPacket 会把上述时间范围查询、四类 speaker 过滤、关系 GET/PUT 和追加事件规则注入当前人格任务；普通消息不携带这段说明。Agent 应执行当前请求所需的一次查询，不能周期轮询覆盖率；`unknown` 或 `conflict` 只能根据当前人格自己的会话、记忆和用户确认来收敛，不能直接采用主机候选名称或高分。

下面的本机接口仍作为 RabiSpeech 操作员诊断兼容入口：当人工已确认某条录音标签时，可以创建/复用诊断资料并绑定当前 `recordId + speakerLabel`。这些名字不会进入 RabiRoute 主机通用消息或人格账本，不能作为 Agent 判断用户身份的真源：

```http
PUT /api/speech/speaker-identities
Content-Type: application/json
```

```json
{
  "sessionId": "meeting-one",
  "recordId": "speech-0123456789abcdef",
  "speakerLabel": "Speaker 1",
  "displayName": "秋雨",
  "aliases": ["Qiu Yu"]
}
```

已知稳定人物 ID 时可传 `speakerId`，此时接口直接复用该资料；未传时按显示名和别名大小写不敏感查找，唯一命中则复用并合并别名，未命中则创建，多个资料同时命中会返回 `409`，要求调用方改用明确 ID。资料查找/创建、别名合并和 `recordId + speakerLabel` 绑定在一次本机注册表写入中完成，重复请求是幂等的。

人工入口仍位于 WebGUI「语音服务 → ASR 语音识别 → 说话人 / 声纹设置」，和 Agent 接口共用 `output/speaker-profiles.json`。界面按未知/已知说话人折叠，并为每个分段人物预览最近 10 句话，帮助人工确认或纠正。

这个接口写的是 RabiSpeech 本机诊断元数据和显式录音绑定。Manager 在通用消息入口删除人名，只转发不透明声纹/聚类证据；对应人格拥有“是谁、是不是用户”的最终解释权。只有能力发现明确返回已校准支持时，才可以把分数描述成声纹匹配证据，但仍不能把主机匹配直接等同于人格关系。

### Agent 触发多电脑人格同步

使用同一个 RabiLink 应用 token 的 PC 可以由本机 Agent 查询并显式同步：

```http
GET /api/persona-sync/peers
POST /api/persona-sync/sync
Content-Type: application/json
```

```json
{
  "peerId": "office-pc",
  "roleId": "Rabi"
}
```

省略 `roleId` 表示同步全部人格。同步器优先局域网直连，失败后经 Relay 受限中转。Agent 必须检查逐文件结果、`fileConflicts` 和 `semanticConflicts`；后者会在同一次同步响应中列出已成功并集合并、但仍有并发分支的语音账号兼容归类或通用身份关系。语音项包含处理主机、声纹、字段和事件候选；身份关系项包含记录类型、记录 ID 和事件候选，不需要另行轮询覆盖率。`conflicts > 0` 或 HTTP `409` 表示仍有待处理冲突，不能声称同步完成。

普通文件冲突由本机 Agent 使用 `GET /api/persona-sync/conflicts`、`GET /api/persona-sync/conflicts/content` 和 `POST /api/persona-sync/conflicts/resolve` 处理。解决动作支持 `keep_local`、`use_remote`、`use_merged`，并应携带列表返回的 `expectedLocalHash` 防止覆盖刚发生的新修改。三条冲突控制接口仅允许回环调用，不经 LAN listener 或 Relay 暴露。底层 manifest、文件读取、单文件 merge 和完整请求字段见 [多电脑人格数据同步](persona-data-sync.md)。

当当前路由消息明确提到多台电脑、人格/角色同步或 persona sync 时，AgentPacket 会把上述回环地址、当前 `roleId`、一次性执行要求和冲突判定直接注入绑定人格的当前任务；普通聊天不注入这段能力说明。默认只同步当前人格，只有用户明确要求时才允许省略 `roleId` 同步全部人格；peer 不唯一时必须先确认目标，不能猜测，也不能用轮询等待覆盖率。

NapCat 群聊始终需要提交 `params.replyToMessageId`。能取得来源消息时尽量填写真实消息 ID：

```json
{
  "deliveryId": "send-qq-progress-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主人格完整会话 ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": {
    "target": "group",
    "groupId": "456",
    "instanceId": "default",
    "replyToMessageId": "123",
    "replyImageDescriptions": [
      "图片展示动态文字较短时底框保持紧凑，并保留图标和文字间距。",
      "图片展示文字变长后底框随内容扩展，想表达背景需要自适应宽度。"
    ]
  },
  "payload": { "type": "text", "text": "【工会入口无响应】我先接手调查，有结论后继续引用这里同步。" }
}
```

Outbox 会在字符串消息前添加 OneBot `[CQ:reply,id=123]`，或在消息段数组前插入 `reply` 段。`replyImageDescriptions` 的数量必须与被引用消息的图片数量完全一致，并按消息中的图片顺序一一对应；每项都要写实际看到的内容和图片想表达的意思，不能只写“已查看”。发送成功后，RabiRoute 会在每张本机图片旁创建或追加图片同名的 `.md`，保存来源消息 ID、图片序号、Agent 类型、完整会话 ID、发送 ID、QQ 回执 ID 和本次描述。存档回执只返回映射文件，不把描述正文复制进运维追踪结果。

主动无源群消息应明确填写 `"replyToMessageId":""`，并保持 `"replyImageDescriptions":[]`，表示有意不引用；这时不会添加引用段。完全省略 `replyToMessageId` 会拒绝请求，并提示 Agent：能引用时使用来源 QQ 消息 ID，确实不引用时传空字符串。私聊不要求该字段。

发送本地 QQ 群文件时仍使用同一个发送接口：

```json
{
  "deliveryId": "send-qq-file-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主人格完整会话 ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "456", "instanceId": "default", "replyToMessageId": "123" },
  "payload": {
    "type": "file",
    "path": "C:/Path/To/Allowed/ReleasePkg/build.apk",
    "fileName": "build.apk",
    "text": "【构建包】版本、渠道和签名已确认，文件已上传。"
  }
}
```

对应 NapCat 策略必须允许 `file`，并配置 `messageAdapterPolicies.napcat.allowedFileRoots`。RabiRoute 会校验文件存在、类型和真实路径，再调用 `upload_group_file`；成功结果包含 `sentFileName`，NapCat 返回稳定标识时还包含 `sentFileId`。如果文件上传成功但跟随的说明文本失败，返回仍为 `status=sent` 并在 `reason` 中说明文本失败，调用方只能补发文本，不能重复上传文件。

### 远端 Agent 上传后发送群文件（实验合同）

> 上传链路已通过本机真实 HTTP 与模拟 NapCat 集成、完整构建及 `0.3.4-4b5d30118b40` 部署健康核验；真实双机群文件尚未验收。先核对运行实例的 capabilities 与版本，不把本机模拟渠道测试当作真实群回执。

远端优先使用 Hook 提供的已安装连接器 `--api`；本机 Host 发现规则仅适用于 Manager 电脑，远端没有 Host 不代表 Manager 离线。用 `GET /api/lan-agent/capabilities` 发现操作，`GET /api/lan-agent/resources` 发现实际可读的文档与 references，再用 `/api/lan-agent/resources/read?id=...` 读取返回的 ID。公共合同含对应英文版，不能把 Markdown 任意链接当成可读取资源。连接器按内容摘要更新及首次 bootstrap/DSH reload 要求见 [远端接入与更新](./lan-rabi-agent-bootstrap.md#安装与发布)。

已使用独立节点凭据接入、并由总控批准的 primary Agent，可把远端文件上传到 Manager，再显式调用发送接口。CLI 从私有配置读取凭据和准确 Agent 身份；不使用共享 WebGUI Token，也不把凭据写到命令参数。上传不自动发送：

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
```

`--upload-id` 是调用方预先保存的稳定 UUID，必填，不自动生成。底层请求为 `PUT /api/agent/uploads/<UUID>`，正文为文件原始字节，`Content-Type: application/octet-stream`，`Idempotency-Key` 必须与路径 UUID 完全相同；`x-rabiroute-file-name` 为 URI 编码的 basename（不含目录），`x-rabiroute-content-sha256` 为内容 SHA-256。鉴权沿用 Bearer 节点凭据和 `x-rabiroute-agent-id`。`GET` 同一路径回读元数据；成功结构如下，不返回 Manager 的本地 `path`：

```json
{
  "code": 0,
  "data": {
    "id": "00000000-0000-4000-8000-000000000001",
    "fileName": "report.zip",
    "size": 1234,
    "sha256": "<64 hexadecimal characters>",
    "expiresAt": "2030-01-02T00:00:00.000Z"
  }
}
```

默认限制为单文件 2 GiB（2048 MiB，硬上限）、总量 4 GiB、最多 100 个文件、TTL 24 小时；HTTP 上传总并发上限为 4，跨 owner 合计。归属按 `nodeId + agentId` 隔离，同一 Agent 的多个 session 可共享文件，但每次请求仍须来自可信且已批准的 source；知道 ID 不构成授权。超时、503、响应不确定或 generation 变化后，保留原 UUID、文件内容和摘要，先重新发现并核对当前 `/meta`，再 `GET` 原路径核对 `id/fileName/size/sha256/expiresAt`，不自动重试 PUT 或换 ID。

如果磁盘权限或文件锁故障导致临时预留清理失败，系统保守保留其配额并记录审计，不删除可能活跃的数据。需修复存储故障，并在 Host 重启后再次触发回收；不保证任意存储故障都自动恢复。

大文件通过有背压的二进制流上传、落盘和增量 SHA-256 校验，不把完整安装包读入内存，也不使用 JSON/Base64 传包。上传期限为 30 分钟。可在「RabiLink → 配置」保存 `agentUploads.maxFileMiB`，整数范围 `1..2048`，默认 `2048`；值保存在 `data/Config.json`，重启 Manager 后生效。本机管理员也可使用原权限保护的 `PATCH /api/rabi/identity` 修改该字段；远端 Agent 不得借此提高配额。客户端硬上限仍是 2 GiB，Manager 配置更低时以服务器限制为准。

受控集成测试已用 **734 MiB（769654784 字节）** 文件完成真实客户端 → loopback HTTP → 受管存储 → 模拟 NapCat 的上传和发送摘要核对；文件由 64 KiB 小块生成，测试禁止大于 8 MiB 的 Buffer 分配/拼接，接收端按块核对。用 `RABI_TEST_LARGE_UPLOAD=1` 启用 `src/manager/agentUploadFlow.test.ts` 的大文件用例，默认日常测试跳过。该结果不是 QQ 平台验收：真实 QQ/NapCat 的文件大小、账号及群权限、磁盘可读性和响应期限仍以实际渠道回执为准。旧连接器须按接入文档执行新版 bootstrap，已缓存旧 Hook 的宿主需重载；服务端增大配额不会升级旧客户端。

最短发送示例：先完成上述上传并确认回执，再把以下 JSON 经标准输入交给 `node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin`。占位身份与目标替换为当前注入模板，`fileId` 使用上传回执 `data.id`；为本次发送保存独立、稳定的 `deliveryId`：

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<approved-complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "00000000-0000-4000-8000-000000000001", "fileSha256": "<upload-data.sha256>", "text": "报告文件。" }
}
```

- 使用 `fileId` 时必须同时提交 `fileSha256=上传 data.sha256`（64 位小写十六进制），把引用绑定到原始内容，防止 TTL 到期后 UUID 复用改变旧引用的文件字节。发送 callback 在 lease 内核对实际 hash，不匹配即拒发。
- `payload.text` 可省略；`replyToMessageId` 必须是具体来源消息 ID 或明确不引用的空字符串，原引用核对和 tracking 要求不变。
- `fileId` 仅用于 `channel=napcat`、`target=group`、`type=file`，与 `path`/`url`/`fileName` 互斥；不能借此发送图片、语音或其它渠道。显示文件名（`displayName`）取自上传元数据，不由发送请求另行覆盖。
- Manager 内部可信 resolver 每次请求重新核对授权、归属、完整性和 TTL，并持有 inflight lease 防止在途文件被清理；不扩大 `allowedFileRoots`，原本地 `path` 流程及其根目录检查照旧。
- 渠道仍须允许发送并支持 `file`；`onlyPrimary` 仍核对可信 provider、精确 Route 的远端实例/节点与 Agent 绑定、获批会话及 `primary_persona` 身份。上传成功不是群发送成功，必须检查 `/api/agent/send` 的 Manager 与 NapCat 回执；发送不确定时查询原 `deliveryId` 回执。
- NapCat 已接受群文件但随后 caption 失败时，仍保留 `status=sent`，只补发文本，不重发文件。当前 NapCat 接口读取 Manager 交给它的文件路径；异机 NapCat 必须能够通过共享目录读取该路径。本功能只解决远端 Agent 到 Manager 的上传，不解决任意跨机 NapCat 文件可读性。
- 这不扩大远端线程桥权限：仍只支持 `responsePolicy: "none"` 单向投递，`required`、`inReplyToRequestId` 正式回复和远端到远端投递仍拒绝。

当图片或文件已经作为受管计划附件存在时，可用 `payload.planAttachment` 按 ID 引用，不必先复制到 `allowedFileRoots` 里的目录：

```json
{
  "deliveryId": "send-plan-attachment-001",
  "sender": { "agentType": "codex", "sessionId": "<当前会话 ID>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": {
    "type": "image",
    "text": "[CQ:at,qq=<qq>] 截图见下。",
    "planAttachment": { "roleId": "<role-id>", "planId": "plan-...", "attachmentId": "<attachment-id>" }
  }
}
```

- `planAttachment` 只接受 `type=image` 或 `type=file`，与 `path`/`url`/`fileId` 互斥；`roleId` 为拥有该计划的人格角色 ID。
- Manager 每次请求从真实计划存储解析该附件，并再次核对解析结果仍位于该计划的受管附件目录内；计划或附件不存在、类型不符、逃出受管目录都拒发。它**不**扩大 `allowedFileRoots`，普通 `path` 流程的根目录检查完全照旧。
- 与 `fileId` 一样，信任边界是「按 ID 引用受管对象」，不是「任意路径可读」；未接入该 resolver 的运行环境会明确失败而不是退回读取原路径。

`payload.text` 中的 CQ 码按固定白名单解析为真实消息段，而不是按纯文本发送：

- 支持 `[CQ:at,qq=<QQ或all>]`、`[CQ:reply,id=<消息ID>]`、`[CQ:face,id=<表情ID>]`，参数值按 URL 解码；`at` 的 `qq` 必须是数字或 `all`。
- 其余 CQ 形态（`image`、`record`、`video`、`file`、`json`、`xml`、`forward`、`node`）会被明确拒绝，因为文本注入这些段会绕过渠道的 `payloadKind` 策略和 `allowedFileRoots` 校验；需要发这些内容请改用带 `path`/`url`/`planAttachment` 的类型化 payload。
- 无法识别的 CQ 样式 token（例如缺少必需参数）会从文本中剥离，不再作为字面文本进入群聊。正文里若要展示 CQ 字样，请改用全角字符或拆分书写。

Agent 可以主动向自己已经掌握的群号或企业微信群 chat id 发送推进消息，不需要引用原消息，但必须明确 `channel` 和目标参数。是否能发由消息端发送开关、消息端可用性和 payload 策略决定。

主动投递到 RabiLink 眼镜也使用同一个动作安全门，不要直接绕过到 Relay：

```json
{
  "deliveryId": "send-rabilink-active-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主人格完整会话 ID>" },
  "routeId": "RabiLink",
  "channel": "rabilink",
  "params": { "proactive": true, "source": "scheduler", "targetDeviceKinds": ["glasses"] },
  "payload": { "type": "text", "text": "该休息一下了。" }
}
```

`routeId` 必须指向启用了 RabiLink 输出策略且已配置 Relay 的 Route。主动发送必须明确 `targetDeviceIds` 或 `targetDeviceKinds`；普通来源回复还要提供 `sourceMessageId`。

企业微信群聊也使用同一个发送接口。Agent 必须填写 `channel=wecom` 和 `params.chatId`；来源上下文里的 `wecomReqId` 只用于可选关联，不再决定渠道。

企业微信回复示例：

```json
{
  "deliveryId": "send-wecom-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主人格完整会话 ID>" },
  "routeId": "main",
  "channel": "wecom",
  "params": { "chatId": "wrCHATID", "userId": "zhangsan", "reqId": "REQ_ID" },
  "payload": { "type": "text", "text": "收到，我来整理一下。" }
}
```

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "sent",
  "channel": "napcat",
  "routeId": "main",
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
  "reason": "Only current QQ group/private source replies can be sent automatically.",
  "draft": {
    "text": "这条只能作为草稿。",
    "targetType": "group",
    "groupId": "456"
  }
}
```

## Codex 正式线程桥

某些调用方没有注入 `codex_app__list_threads`、`codex_app__read_thread`、`codex_app__create_thread`、`codex_app__send_message_to_thread` 等 Codex Desktop 连接器工具。提示词不能补出未注册工具，也不能因此自行启动另一个 Runtime。

这类回合需要改用 RabiRoute Manager 提供的本机线程桥：

```http
POST <managerBaseUrl>/api/agent/threads
```

线程桥提供六个动作：

- `list`：从 Desktop 状态按标题查询本机任务，使用 `offset` / `limit` 分页访问全部结果。
- `read`：通过完整 `threadId` 只读读取 Desktop 任务元数据。返回的任务名统一来自 Codex 左侧聊天栏索引；SQLite `threads.title`、首轮初始化提示和 Route 中缓存的旧名称都不能覆盖它。
- `resolve`：先读取精确 ID。有效 ID 且未归档时直接绑定；请求中的 cwd 作为本轮执行目录，不与任务保存的默认 cwd 比较。可变的 Desktop/SQLite 标题和超过新建上限的展示标题也不会否定该绑定；保存 ID 指向已归档任务时返回 `409 archived`。只有 ID 为空、非法或确实失效时才按保存名称和可选 cwd 查找，一个或多个同名同 cwd 候选按 `updatedAt` 自动绑定唯一最新者、零匹配按需幂等创建、最大时间并列时返回候选。
- `create`：在已配置工作区创建空任务，再把初始提示词通过 Desktop IPC 投给该任务 owner。Codex 任务名上限为 240 个 JavaScript 字符单元；更长的输入会由 RabiRoute 安全截断并加省略号，响应和后续配置保存实际创建的名称。
- `rename`：按完整 `threadId` 修改 Desktop 任务名称，已配置 cwd 只提供本次 Desktop IPC 上下文，不改变任务身份；用于持久计划协助槽从单个扩容为多个时，把原“协助处理计划”任务改名为“协助处理计划1”。
- `send`：通过 Desktop IPC 向已有任务 owner start/steer。

`send` 可选传 `imagePaths`，最多 8 个图片绝对路径。每个文件必须存在、位于目标 `cwd` 工作区内，并使用 PNG/JPEG/GIF/WebP/BMP 扩展名。Manager 校验后把它们作为 Desktop `localImage` 输入发送；该字段主要供消息入口把已经保存的来源图片交给处理任务，不能用于读取工作区外文件。

查询示例：

```json
{
  "action": "list",
  "query": "工会入口",
  "limit": 100,
  "offset": 0
}
```

自动解析或创建示例：

```json
{
  "action": "resolve",
  "threadId": "可选；旧配置可能为空或无效",
  "title": "RabiLink",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "createIfMissing": true
}
```

调用方不要让 AI 或用户手改 UUID。下拉保存名称、完整 ID 和 workspace；用户明确输入新名称时前端先清空旧 ID。对 Codex，有效 ID 是稳定任务身份，workspace 决定本次执行目录；任务保存的默认 cwd、返回标题变化或标题长度超过新建限制都不影响继续该 ID。`resolve` 返回 `id`、`name` 或 `created`；重名最大时间并列时返回 HTTP 409 和 `candidates`。

读取示例：

```json
{
  "action": "read",
  "threadId": "019f0000-0000-7000-8000-000000000001"
}
```

创建示例：

```json
{
  "action": "create",
  "title": "[Example][Research] 比较两种接入方案",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000010",
    "sessionName": "当前调查会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000010",
  "sourceAgentType": "agent",
  "responsePolicy": "none",
  "prompt": "读取现有实现和项目规范，比较两种方案并给出验证计划；未经明确授权不要修改文件。",
  "sandbox": "workspace-write"
}
```

续投示例：

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "sandbox": "workspace-write",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000002",
    "sessionName": "计划秘书会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000002",
  "sourceAgentType": "plan_secretary",
  "responsePolicy": "required",
  "responseInstruction": "完成下一步后返回结果、验证证据和后续动作",
  "prompt": "补充新的约束和验证证据，请续接原任务。"
}
```

所有带有非空 `prompt` 的 `create` 和 `send` 都必须提供 `messageSource`。字段 `type` 必填，统一支持四种消息源：

| `messageSource.type` | 必填身份 | 可选补充 |
| --- | --- | --- |
| `message_adapter` | `messageAdapter`、`conversationType`、`conversationId`、`messageId`，以及 `senderName` 或 `senderId` | `conversationName`、`messageGroupId`、消息路线名称/ID |
| `agent` | `agentAdapter`、`sessionName`、完整 `sessionId` | `agentType`、`workspace` |
| `plan` | `planName`、`planId` | 只有实际 Agent 发起且能核对时才附带 `sourceAgent` |
| `system` | `eventType`、`eventName`、`eventId` | `actorType`、`actorName`、`actorId`、消息路线名称/ID |

RabiRoute 渲染后的正文固定从以下两段开始，相关上下文和回传参数只能放在它们之后：

```text
[消息源]
消息源类型：<消息端 | Agent | 计划 | 系统>
<该类型的名称、完整 ID、会话、计划或路线字段>

[消息内容]
<prompt>
```

正式回复使用精简模板：`[消息内容]` 内只保留一份 `[回复结果]` 和 `[下一步]`；`prompt` 中与这两个字段完全相同的文字不重复输出，其余文字保留为 `[相关上下文]`。模板不概括或截断证据。回复合同保留投递 ID、原请求 ID、后续请求 ID、回复要求和完整 POST 参数；不再另列一遍接收任务身份或重复说明无需回复。工作区限制由目标 `AGENTS.md` 提供，投递模板不再添加通用协作提醒，也不按项目名称硬编码。

新投递使用 `[回传参数]` 和完整 JSON 请求。发送前由请求记录保存结构化回复与实际正文校验值；`reconcile_delivery` 核对接收正文后从记录恢复结果，不依赖展示标题。旧格式仅用于尚未关闭的历史预留；详见[模板归属与退出条件](message-delivery-templates.md)。

Agent 调用线程桥时通常使用 `type=agent`。`agentAdapter` 填实际 Agent 端，例如 `codex`、`dsh`、`copilotCli`、`marvis` 或 `astrbot`；`sessionName` 和完整 `sessionId` 都不能省略。Agent 间投递还必须提供自己的完整 `sourceThreadId`、`sourceAgentType` 和 `responsePolicy`，且 `messageSource.sessionId` 必须等于 `sourceThreadId`。`sourceAgentType` 可为 `primary_persona`、`message_processing`、`plan_secretary`、`plan_agent` 或通用的 `agent`；`responsePolicy` 只能是 `required` 或 `none`。选择 `required` 时还必须填写 `responseInstruction`，Manager 会生成 `requestId` 并把正式回复参数写进目标任务收到的内容。选择 `none` 表示本次投递不要求目标返回。

带正文的 `create` 与 `send` 使用同一来源核对规则。`type=agent` 时两者都必须提供 `sourceThreadId`；Manager 从实际 Codex Desktop 或 DSH owner 读取来源会话名称并覆盖调用方提交的旧名称。计划进展、审批和 QA 等 Manager 计划事件只显示计划名称和计划 ID；只有计划任务本人回传结果时才附带并核对 `sourceAgent`。

`contextBlocks` 排在消息内容之后，`controlBlocks` 再排在上下文之后。回传参数与本次必要的发送要求放入控制块；通用协作段不再注入。两个字段都不能包含 `[消息源]`、`[消息内容]` 或 `[投递源]`。旧 `[投递源]`、旧嵌套信封和旧 Agent 回复会自动迁移；旧重放记录无法还原来源时显示“历史投递记录”，不猜来源身份。

正式回复仍使用同一个 `send` 动作。回复方必须把 `inReplyToRequestId`、`result` 和 `nextAction` 送回原请求任务，并再次填写 `responsePolicy`：如果新的下一步还要求原请求方处理后返回，使用 `required` 并填写新的 `responseInstruction`；如果本次往返到此结束，使用 `none`。回复中的 `messageSource.agentAdapter`、`messageSource.sessionId`、`sourceThreadId` 和 workspace 必须描述当前正在回复的接收会话；`inReplyToRequestId` 单独指向原请求，不能把原请求会话或回复目标写成回复来源。

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000002",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000001",
    "sessionName": "计划业务会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000001",
  "sourceAgentType": "plan_agent",
  "inReplyToRequestId": "请求中给出的 requestId",
  "result": "已经完成调查并核对证据",
  "nextAction": "由秘书更新计划并决定是否继续实现",
  "responsePolicy": "none",
  "prompt": "调查结果和证据摘要。"
}
```

普通 Codex 最终回答不算正式回复。目标 Agent 每轮结束时，`Stop` Hook 会检查待回复请求；仍未回复时，从该轮结束起五分钟后向同一个精确任务投递提醒。提醒触发的新一轮结束后仍未回复，会再从该轮结束起等待五分钟。请求状态可通过 `GET /api/agent/requests` 或 `GET /api/agent/requests/:requestId` 查询；维护者可用 `POST /api/agent/requests/:requestId/cancel` 取消不再需要的请求。

Desktop 偶尔会在消息已经写入目标任务后才返回启动或追加轮次超时。Manager 会用正文中的唯一 `deliveryId` 回读目标任务最近的 rollout：确认标记后提交请求/回复状态；有界等待后仍未确认时返回 HTTP `202`、`code=-1`、`status=delivery_unconfirmed` 和 `error.retryable=false`，保留原 `deliveryId`、`requestId` 及 `pending_delivery` 请求，不删除记录、不再次发送。调用方先查询原请求和目标任务，不把 HTTP `202` 当成送达成功。

原目标任务正式回复一个 `pending_delivery` 请求时，线程桥先核对双方完整任务 ID、工作目录和原目标 rollout 的精确投递标记；按需流式读取该任务记录，不再因标记超出最后 4 MiB 而漏判。证据齐全才恢复为 `awaiting_response` 并继续原回复。缺少标记或身份不符时返回 `error.code=agent_reply_state_conflict`，并包含 `requestId`、`currentState`、`expectedState`、`reason`、`commitState` 和 `nextAction`。原因区分发送任务不符、接收任务不符、工作目录不符、原始接收证据缺失或不可读；`commitState=not_started` 仅表示这次回复没有发送，不能据此重发原任务。迟到的原投递提交不会把已回复请求重新打开。

核对已送达但未入账的回复，调用 `POST /api/agent/threads`，正文为 `{"action":"reconcile_delivery","threadId":"<接收回复的原来源任务 ID>","deliveryId":"<原回复投递 ID>"}`。此动作不投递正文，也不接受调用方提供的结果：按需流式读取指定 Desktop 任务的原始用户消息，核对原 reservation、双方任务/工作目录、投递 ID 和后续请求合同，再经请求存储提交。读取限定于开始时的文件长度及 30 秒期限；超时或不可读保留未确认状态，不重发。成功返回 `receipt_recovered`；重复核对返回 `already_recorded`。原请求变为 `responded`，同次要求继续返回的新请求只恢复为 `awaiting_response`，不视为业务已完成。普通工具输出、助手引用或单独 ID 不构成恢复证据。

提醒触发前也执行上述核对。证据仍不完整时保留 reservation、写入 `lastReminderError` 并停止本次“未回复”提醒，不无限重试或要求重发；下一次任务结束或显式核对可重新检查。读取超时、身份/合同不符及旧版本已删除的 `404` 请求均不凭猜测重建，必须保留正式回传未记录的差异。

Agent 间 `create` 与 `send` 投递时，Manager 按 `messageSource.agentAdapter + sourceThreadId` 向实际 owner 核对来源会话。Codex 读取 Desktop 任务状态和左侧聊天栏名称；DSH 通过 apiproxy `session.list` 读取会话名称、工作目录和运行状态。来源不存在、工作目录冲突或来源 ID 与 `messageSource.sessionId` 不一致时失败关闭。所有 RabiRoute 非空投递都先显示 `[消息源]`，再显示 `[消息内容]`。消息端来源显示消息端、会话、发送者和消息 ID；Agent 来源显示 Agent 端、会话名称和完整会话 ID；计划来源显示计划名称和计划 ID；系统来源显示事件类型、名称和 ID。提醒、初始化消息、RabiLink 复盘和重放也使用同一信封。

安全边界：

- `create` / `send` 的 `cwd` 必须属于当前 RabiRoute 已配置的 Codex 或 DSH 工作区；不能用线程桥在任意路径启动会话。
- 所有带有非空 `prompt` 的 `create` / `send` 都必须提供完整 `messageSource`。`type=agent` 时，`agentAdapter`、`sessionName` 和完整 `sessionId` 都必填；Agent 互投还必须提供可核对的 `sourceThreadId`，并保证它与 `messageSource.sessionId` 相同。`sourceAgentType` 只声明发送方当前职责，任务名以 Desktop 查询结果为准。
- Agent 互投正文必须是针对目标任务重新编写的交接内容。Manager 拒绝含 `[rabi:bind]`、消息处理 Agent 初始化或计划秘书初始化的正文，也拒绝来源与目标为同一任务；整份注入上下文不能跨任务复制。消息处理 Agent 的任务 ID如果与主人格 ID相同，消息池会拒绝初始化和投递。
- `sandbox` 字段仅为接口兼容参数，不能覆盖目标 Desktop 任务的模型、工具、沙箱或审批；这些能力以 Desktop owner 为唯一真源。
- 创建线程使用固定的调查边界；没有明确实施授权时，只能调查、整理证据和输出方案。
- `create` 的固定开发说明和所有 `send` 续投都会追加工作区交付约束；未经当前用户明确授权，不得新建额外工作副本、稀疏检出、复制工程或旁路目录；工作区 `AGENTS.md` 有更严格限制时以它为准。具体项目允许的工作副本、同步方向及历史指令的有效性由该工作区当前规则决定。只有改动已经进入用户实际运行或验收的目标工作区，并完成适用的资源关联、构建或编译及运行验证，才能称为“已修复”或“可验收”。
- `create` 按“任务名 + 工作目录”幂等解析。相同创建请求并发到达、调用方等待超时后重试，或任务刚创建但 Desktop 索引尚未及时显示时，都会复用同一次创建结果；不得因为第一次 HTTP 超时再次创建同名任务。返回 `resolution=created` 表示本次新建，`resolution=name` 表示复用了同名同工作目录任务。
- Manager 在运行期 `data/.runtime/codex-thread-creations/` 持久保存创建 reservation。状态按 `reserved → creating → thread_created → naming → initial_turn → completed` 推进。`creating` 超过 5 分钟、没有 `threadId`，并且第二次 `action=list + lookupMode=state_db` 明确确认同名同工作目录任务不存在时，Manager 才先转为 `failed_before_create`，再允许同键重试。记录已有 `threadId`、索引查询失败、查到候选任务或其它证据不足时转为 `uncertain`，后续请求返回 `409` 并禁止自动再次创建。
- `create` 返回 `initialTurnStatus`。若任务已经创建但初始 turn 启动失败，应记录返回的 `threadId` 并用 `send` 重试，不能重复创建同名任务。
- 创建调用超时后，先用 `action=list + lookupMode=state_db + 原任务名` 从本地任务索引回读。这个模式不启动 app-server 元数据扫描，适合判断慢创建是否稍后产生了任务；完整任务列表仍使用默认 `lookupMode=complete`。
- Agent 正式回复仍会比较本轮 workspace，并使用统一的路径规范化规则；Windows 普通盘符路径、`\\?\` 扩展盘符路径、UNC 与扩展 UNC 的等价形式不会因为字符串写法不同而被误判为其它工作区。该校验不参与 Codex 任务身份判定。
- 当前 Route 开启“强制使用 RabiAgent 消息投递接口”后，Codex Hook 会拒绝绕过 Rabi 的持久任务工具；DSH `RabiRoute Agent` 插件会拒绝 Shell 直接调用 `/api/agent/threads`、`/api/agent/send` 或 `session.prompt`。两端都必须使用线程桥并填写 `sourceThreadId`、`sourceAgentType` 和 `responsePolicy`。临时子 Agent 的本地协作不属于这项限制；关闭开关只停止绕过检查，已有待回复请求仍继续检查和提醒。
- Manager 线程桥最终投给目标会话的同一个 owner：Codex 使用 Desktop IPC，DSH 使用该会话的 apiproxy owner。两者都不启动或改投备用 Runtime。
- Codex Desktop 未启动、IPC 不可用或目标任务无法加载时返回失败；DSH Endpoint 不可用、会话不存在或工作目录冲突时也返回失败。两端都不得转给另一 Agent adapter 或备用 Runtime。

## 计划接口

计划是 Agent 需要关注的事项。计划不按短期、长期拆目录，而是通过状态和字段表达当前进展、优先级、项目归属和下一步。`plan.status` 只保存当前人格 `personaConfig.json.planWorkflow.statuses` 中启用状态的 key；下面十项是默认模板，不是代码枚举。

```text
分析中
待补充信息
待审批
执行中
等待打包
等待 QA
待讨论
暂停
完成
关闭
```

默认模板的稳定状态 key `等待 QA` 显示为“等待 QA 验收”，英文显示为“Awaiting QA acceptance”；状态 key 不变。

默认“待补充信息”只表示：分析已完成，但现有信息仍无法形成可审批的具体方案，且缺失信息会影响原因、改法、实施范围或验收合同。暂未复现、疑似历史已修复、等待目标包、等待 QA 验收或等待是否关闭都不使用该状态；这些情况应继续分析，或按证据进入“等待打包”“等待 QA 验收”“关闭”。

Agent 可以在已授权任务范围内主动创建和调整计划、修改步骤及更新真实进度，无需为每次计划维护另行审批。实际业务动作的授权、验收证据与计划维护分开判断。版本校验只防止覆盖并发修改，不限制由 Agent 维护计划。

计划、状态目录和反馈写入失败时，响应包含 `message`（具体原因）、`reason`（错误类别）、`commitState`（`not_started/unknown/committed`）、`nextAction` 和 `retryable`。`412 revision_conflict` 要先读取最新计划并合并；`committed` 表示写入已完成、回读暂不可用；`unknown` 只能保留原载荷和原幂等键核对，不应新建替代计划。反馈提交和后台反馈更新只回读目标计划，不再因无关计划目录读取失败而把已提交反馈报错。

计划审批、QA 续投和完成通知检查线程桥的结构化送达状态；HTTP 202 的 `delivery_unconfirmed` 或 `delivered_tracking_failed` 保留待确认，不标记已通知，也不自动重发正文。

查询计划：

```http
GET /roles/:roleId/plans
GET /roles/:roleId/plans/:planId
```

查询和维护人格计划状态：

```http
GET    /api/roles/:roleId/plan-statuses
POST   /api/roles/:roleId/plan-statuses
PATCH  /api/roles/:roleId/plan-statuses/:statusKey
DELETE /api/roles/:roleId/plan-statuses/:statusKey
```

写请求必须携带 `If-Match` 和 `Idempotency-Key`。新增或修改请求体使用状态定义字段；状态 key 不可原地修改。删除请求体必须提供 `replacementKey`，Manager 会先迁移未归档计划，再将旧定义保留为 `retired`，使归档计划和历史快照继续可读。

新增计划：

```http
POST /roles/:roleId/plans
```

请求体示例：

```json
{
  "title": "完善计划和记忆机制文档",
  "focus": "计划和记忆机制文档",
  "status": "分析中",
  "archiveStatus": "未归档",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "confirm-contract",
  "currentStep": "确认接口文档注入方式",
  "nextAction": "补充 Rabi Agent 接口文档",
  "blockedBy": "",
  "attachments": [
    { "name": "plan-preview.png", "mimeType": "image/png", "contentBase64": "<base64>" },
    { "name": "acceptance-checklist.pdf", "path": "C:/Path/To/acceptance-checklist.pdf" }
  ],
  "steps": [
    { "id": "inspect-existing", "title": "检查现有计划接口", "startedAt": "2026-07-27T08:00:00.000Z", "completedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "confirm-contract", "title": "确认步骤数据契约", "startedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "update-docs", "title": "更新双语接口文档" }
  ],
  "keywords": ["计划", "记忆", "接口", "上下文"],
  "source": {
    "kind": "agent",
    "summary": "Agent 根据用户讨论新增计划"
  },
  "taskBinding": {
    "agentType": "codex",
    "sessionId": "exact-source-session-id",
    "sessionTitle": "计划执行任务",
    "workspace": "C:/Path/To/Project",
    "completionHook": {
      "enabled": true,
      "gatewayId": "Role__reminder"
    }
  }
}
```

新增计划必须提供有序的 `steps`。`plan.status` 只能写当前人格状态目录中的 enabled key。`archiveStatus` 独立，只允许“未归档、已归档”。步骤不保存独立状态；`currentStepId` 表示当前步骤，`completedAt` 表示已经完成。Manager 返回 key 及其配置的 label、description、palette、order 和 views，WebGUI 与托盘只消费这些字段。

仍在调查、分析完成但无法形成可审批具体方案、完整审批等待和获批执行分别写 `planWorkflow.roles.analysis`、`roles.informationNeeded`、`roles.approval`、`roles.execution` 所指的 key。包体、QA、讨论和暂停同样通过 roles 查找；步骤名称、说明、`waitingFor` 与审批合同不再覆盖 `plan.status`。

只有代码、Prefab、资源、配置等会产生项目内容变动的计划才应采用“实施/开发验证/适用同步提交 → 等待打包 → 等待 QA 验收 → QA 通过完成；失败回实施”的流程。调查、设计评审、运营、资料收集、外部依赖与控制面维护按自身真实步骤推进；Agent 或批处理不得为这些计划虚构 package 或 QA 步骤。Manager 不根据标题、说明或 `kind` 自动补流程。

`attachments` 可选。新附件可提供本机 `path`，或提供 `name`、可选 `mimeType` 与 `contentBase64`；最多 8 个，单个不超过 10 MiB、总计不超过 25 MiB。Manager 把内容复制到人格私有 `plans/attachments/<planId>/`，计划文件只保留安全元数据，不保存 Base64。PATCH 未提供 `attachments` 时保留原列表，提供空数组时清空记录；如需在 PATCH 中保留指定旧附件，可把 GET 返回的对应附件对象原样带回。Manager 对外计划 DTO 不返回本机 `path`。

读取附件：

```http
GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId
```

图片和视频附件使用 `inline` 响应；WebGUI 以紧凑固定宽度的 16:9 缩略图展示 PNG、JPEG、WebP、GIF 与 MP4/M4V、WebM、Ogg Video、MOV/QuickTime，容器不足时才等比缩小，点击后分别打开页内大图或带控制条的视频预览。视频可使用 HTTP 字节范围读取，实际解码能力由浏览器决定；普通文件使用下载响应。该接口只读取计划元数据中已登记且真实路径仍位于本计划受管目录内的文件。

请求审批前，Agent 应 PATCH 当前步骤的完整 `approvalRequest`。Manager 的完整性判断不阻止计划保存，但缺项时返回 `presentation.approval.state=incomplete`、`enabled=false` 和 `missing[]`；计划卡列出缺项，并禁用审批输入、附件与提交。Agent 必须在同一计划补齐审批人、决定、推荐与备选、reason、真实路径、完整命令、外部目标、验证、回退、排除范围、请求来源与回执后，才允许正式审批。

`taskBinding` 可在 POST 或 PATCH 中写入，用于精确绑定一个 Codex 执行会话。当前只接受 `agentType=codex` 和非空完整 `sessionId`；`completionHook.enabled` 必须是布尔值。启用后，Codex `Stop` Hook 把官方 `last_assistant_message` 交给 Manager，Manager 再经同人格的角色面板 / Forwarding / AgentPacket 链提醒目标处理会话。`gatewayId` 在同人格有多个 Route 时必填。提醒按 `sessionId + turnId` 去重，不会自动 PATCH 计划、推进步骤或写记忆。

完成提醒来自计划独立业务任务。主人格必须在同一轮安排计划管理秘书消费结果、更新计划与记忆，并在计划仍可推进时使用 `/api/agent/threads` 的 `send` 动作向计划自身 `taskBinding.sessionId + workspace` 精确续投业务任务。秘书 ID 不得写入 `taskBinding`，秘书轮转或计划暂停也不得清空业务绑定。主人格检查全部未终态计划、秘书槽与业务任务，结束前满足“可推进但无人管理的计划数 = 0”以及“可推进但空闲的业务任务数 = 0”；这些决策与写入属于 Agent，不由 Stop Hook 或 Manager 自动执行。

完成提醒失败不会阻断源 Codex 最终回答，但会记录失败并返回非阻塞系统警告。workspace、人格、gateway 或源/目标任务冲突均失败关闭；未完成双真实 Desktop 任务验收前，该接口能力为实验状态。

### 计划引导与审批意见接口

```http
GET  /api/roles/:roleId/plans/:planId/feedback
POST /api/roles/:roleId/plans/:planId/feedback
```

RibiWebGUI 用该接口记录 `presentation.acceptsGuidance=true` 且未进入审批的计划级引导；WebGUI/托盘也继续用它记录当前审批步骤的正式意见。两者均可选择只保存；选择“提交并投递”才请求 Manager 通过独立 `plan_feedback` 系统事件通知 Agent。计划引导只带 `planId`，不能带 `stepId`：

```json
{
  "feedbackId": "webgui-guidance-12345",
  "gatewayId": "route-id",
  "text": "先收窄整体范围，再根据结果调整后续步骤。",
  "kind": "guidance",
  "author": "user",
  "source": "webgui",
  "notifyAgent": true
}
```

审批意见继续关联审批步骤。用户 `approval_suggestion` durable 保存时，反馈、附件与计划标记变更在同一 WAL 事务发布，`markerStatus` 取人格 `planWorkflow.roles.approved` 指向的 key，`activationStatus` 不变。`presentation.approval.state=approved` 表示意见已提交，不表示全部选项获批，也不自动实施。`notifyAgent=false` 只保存；`notifyAgent=true` 先保存再投递，只有 confirmed 成功回执匹配同一 `feedbackId` 且计划版本未变时，才更新为 `roles.analysis`。`pending/failed` 或不确定回执不能触发该转换；旧回执不能覆盖新提交或后续计划变更。`guidance` 与 Agent 回复不触发上述状态转换。

结构化审批表单使用可选 `formData: { questions: PlanQuestion[], approvalContract?: PlanApprovalRequest, answers: Record<string, PlanQuestionAnswer>, text: string }`；共用类型位于 `src/shared/planFeedbackFormData.ts`。`questions` 保存源 `currentStep.questions` 快照，`answers` 使用 `question:<id>` 及默认 `approval-decision` 答案 ID，`text` 保存补充文字。审批表单的 `approvalContract` 必须与当前 `step.approvalRequest` 匹配；只有问题与审批合同快照均匹配才可回填。Manager 从 `formData` 生成权威 `feedback.text`，不采用与表单冲突的手写正文；可选 `reuseFeedbackId` 从同计划原反馈复用全部附件，不接收本机路径。重新提交追加新记录，同一提交重试保持原 `feedbackId`、表单与完整正文。审批合同变化后必须重新确认，不能复用旧选择。以下示例为不带结构化表单的审批意见：

```json
{
  "feedbackId": "qq-message-12345",
  "gatewayId": "route-id",
  "stepId": "review-plan",
  "text": "同意方向，但先补充回归范围。",
  "attachments": [
    { "name": "review.png", "mimeType": "image/png", "contentBase64": "<base64>" }
  ],
  "planAttachmentIds": ["attachment-design-preview"],
  "kind": "approval_suggestion",
  "author": "user",
  "source": "qq",
  "notifyAgent": false
}
```

`attachments` 可选。每项使用 `name`、可选 `mimeType` 和 `contentBase64`；最多 8 个，单个不超过 10 MiB、总计不超过 25 MiB。Manager 校验后把内容保存到人格私有的 `plans/feedback/attachments/<feedbackId>/`，记录与 Agent 通知只携带安全元数据和本地路径。同一 `feedbackId` 重试必须保持相同文字、步骤和附件内容。

`planAttachmentIds` 也可选，用于引用当前计划顶层 `attachments` 中已有的受管附件；最多 8 个且必须唯一。RibiWebGUI 在审批输入框键入 `@` 时显示当前计划附件候选，选中后插入可读的 `@附件「文件名」` 标记，并提交对应附件 ID。Manager 以 ID 校验附件确实属于当前计划，把附件元数据与本地路径作为本次审批审计快照保存，并随同一 `plan_feedback` 投递给 Agent；WebGUI 不读取或提交任意本机路径。同一 `feedbackId` 重试也必须保持相同的计划附件引用。

当反馈关联当前结构化 `qa-* / verify-*` 步骤时，Manager 只把用户或外部入口提交的 `approval_suggestion` 视为 QA 判定候选。`guidance`、`guidance_response`、`approval_response`、`author=agent` 的执行报告，以及正文里的裸 `passed / verified` 测试计数都只作普通反馈记录，不会完成或回退 QA。候选正文明确表示失败或仍复现时，Manager 在同一计划插入或复用 `investigate-<qaStepId>`，清除 QA 步骤的 `completedAt`，按问题类型把最小缺失证据写入 `waitingFor`；证据齐全后继续原 `taskBinding.sessionId + workspace`。只有“QA 明确通过”“验收通过”“确认未再复现”等明确结论才完成当前 QA 步骤。

当 `notifyAgent=true` 时，POST 在反馈成功落盘后立即以 HTTP `202` 返回，通常为 `deliveryStatus=pending`。计划引导与审批意见复用同一 `taskBinding` 投递链：存在完整绑定时，Manager 只通过 `/api/agent/threads` 的 Desktop IPC 主链投向原业务任务；绑定不完整时才把完整反馈交给人格 Agent。owner 未加载时保持 `pending` 并有界重试，只有目标 owner 接受 `start/steer` 才记录 `delivered`。事件不写角色面板 timeline 或统一会话账本，也不注入最近消息；终态通过 `plan_feedback_changed` 通知。

Agent 处理计划引导时使用 `kind=guidance_response`、`author=agent`、`source=agent`、`notifyAgent=false`，只回写 `planId`，不带 `stepId`。Agent 必须先读取整个计划，按引导更新计划说明、范围、优先级或路径，并在需要时调整后续步骤。审批处理仍使用 `kind=approval_response` 并关联 `planId / stepId`。两类 Agent 记录都按 `record_only` 保存，不改变状态；这不同于用户审批保存及确认投递触发的配置标记转换。

AgentPacket 的共用计划 API 提示会直接包含上述计划引导、审批记录入口与“记录后另行 PATCH 计划”的约束，因此不要求每个人格 Skill 重复维护同一套接口。

更新计划：

```http
PATCH /roles/:roleId/plans/:planId
```

常见用途：

- 更新标题。
- 更新、保留或清空计划附件。
- 更新全部步骤及唯一的当前步骤。
- 更新下一步、等待对象和阻塞原因。
- 更新关键词。
- 将状态改为当前人格状态目录中的 enabled key；需要表达生命周期语义时，通过 `planWorkflow.roles` 选择对应 key。
- 暂停或讨论结束后，按实际阶段恢复为 analysis 或 execution role 指向的 key。
- 验收完成后使用 completed role；取消、失效或由后继计划替代时使用 closed role。

计划归档通常不需要 Agent 处理。状态定义同时满足 `terminal=true` 与 `archiveEligible=true` 的未归档计划，超过 `personaConfig.json.planWorkflow.archiveAfterHours` 后，由角色知识快照把独立的 `archiveStatus` 改为 `已归档`，但保留原 `plan.status` key。默认模板延迟为 72 小时；已归档计划不参与关键词召回。

归档计时以计划的 `updatedAt` 为准。Agent 更新计划后，RabiRoute 会刷新 `updatedAt`，该计划重新进入活跃窗口；是否可归档由当前状态配置决定，不由显示名称判断。

## 近期记忆接口

近期记忆是 Agent 主动记录、仍处于可修改或待沉淀窗口内的记忆。近期记忆没有计划状态。

查询近期记忆：

```http
GET /roles/:roleId/memory/recent
GET /roles/:roleId/memory/recent/:memoryId
GET /api/roles/:roleId/memory?counts=1
```

`counts=1` 只返回近期记忆、沉淀记忆、已归档记忆来源和沉淀记录的数量，不读取或返回记忆卡片正文；WebGUI 直达“计划与记忆”页面时用它填充标签计数。

新增近期记忆：

```http
POST /roles/:roleId/memory/recent
```

请求体示例：

```json
{
  "title": "计划和记忆由 Agent 主动维护",
  "focus": "计划和记忆的维护责任",
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

近期记忆可以通过 ID 修改，用于修正、补充、合并或降噪。近期记忆是否允许修改由 RabiRoute 按当前固定的 24 小时可编辑窗口判断；目前这个窗口还不是 `personaConfig.json` 的公开配置字段。

近期记忆的可编辑窗口取 `updatedAt` 和 `viewedAt` 中较新的时间。Agent 按 ID 查询近期记忆时，RabiRoute 会刷新 `viewedAt`；Agent 更新近期记忆时会刷新 `updatedAt` 和 `viewedAt`。沉淀的 24/72 小时窗口另取 `updatedAt` 和 `recalledAt` 中较新的时间，普通按 ID 查询不会推迟沉淀。

Agent 新增或更新近期记忆时，应主动填写 `keywords`。RabiRoute 在消息投递前只使用标题和 `keywords` 做轻量召回，不对记忆内容进行实时智能分词。当前消息命中近期记忆标题或 `keywords` 时，RabiRoute 会同时刷新该条记忆的 `viewedAt` 和 `recalledAt`。

近期记忆列表的 `lifecycle` 由 Manager 动态返回：`triggersNextConsolidation` 标记最早到达 72 小时的记忆，`willEnterNextConsolidation` 表示该记忆在同一触发时刻是否已经超过 24 小时输入窗口。该结果随记忆目录缓存，记忆新增、修改或命中召回后重新计算；调用端不得根据本地时钟另算候选范围。

`keywords` 是必填项。新增近期记忆时必须提供至少一个关键词；更新近期记忆时如果改写 `keywords`，也必须保留至少一个关键词。

## 写入聚焦与长度校验

新增计划、近期记忆和沉淀结果都必须显式填写单行 `focus`。`focus` 只描述一个主题：一个计划只推进一个目标，一个记忆只记录一个事实、偏好、结论或问题；出现独立事项时创建新条目。标题可用于展示，不能代替 `focus`。

RabiRoute 会按角色 `personaConfig.json` 的 `knowledgeLimits.plan` 和 `knowledgeLimits.memory` 校验标题、`focus`、正文/步骤、来源摘要、单个关键词、关键词数量和总文本长度。未配置字段使用系统默认值；超限写入返回 `400`，不会截断后静默保存。

检查当前角色全部计划和记忆：

```http
GET /api/roles/:roleId/knowledge-validation
```

返回的 `data.ok` 表示是否全部合规，`data.limits` 是实际生效限制，`data.issues` 列出旧条目或手工文件中的违规项。旧文件仍可读取，但下一次写入应先拆分或压缩到限制内。完整默认值和配置示例见 [计划和记忆机制](plan-and-memory-model.md#聚焦与长度校验)。

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

当前触发来源：

- 用户触发 `triggerId=memory-consolidation` 的内置手动触发项。
- 调用 Manager API 显式创建整理 request。

时间窗口用于判断本次 request 是否到期以及哪些近期记忆进入输入；当前没有仅凭时间流逝就在后台自行启动整理的常驻调度器。

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
        "focus": "计划和记忆的维护责任",
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
      "focus": "计划和记忆的维护责任",
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
      "focus": "计划和记忆的维护责任",
      "content": "计划和记忆由 Agent 主动维护；RabiRoute 负责提供接口、注入索引、按人格配置归档符合条件的计划，并触发记忆沉淀流程。"
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

## 远端 Agent 设备接口（旧协议兼容）

当前远端 Agent 作为 Agent 执行端接入，见[远端接入](lan-rabi-agent-bootstrap.md)。消息端独立配置入口已移除；以下接口仅描述存量 bridge 的兼容行为。

> 成熟度：实验。协议、安全边界和 Manager API 已实现并有测试，仍需要按真实局域网、VPN/TLS 和目标设备环境做端到端验收。

当路由启用了“远端 Agent”消息端时，本机 Agent 可以把需要特定设备/系统完成的任务投递给远端 Agent 设备。远端机器只需要运行 `plugin-adapters/remote-agent-rabiroute` bridge，不需要安装完整 RabiRoute。

安全边界：

- 本机 loopback 调用用于 WebGUI 和本机人格线程。
- RabiGUI/manager 先扫描局域网远端 bridge，再由用户输入设备密码连接。bridge 不再提供公知默认密码：未配置时每次启动生成高熵临时密码并只显示在远端终端；长期部署应设置至少 16 字节的 `REMOTE_AGENT_PASSWORD`。协议 v3 使用逐连接、角色分离的双向 HMAC-SHA256 challenge，不在 WebSocket 中发送密码原文；连接成功后只在本机运行期数据中记住密码。
- bridge 连接设备本机由远端 Agent 自己拥有的 runtime；不得通过用户级 endpoint 把桌面应用改成依赖 RabiRoute。远端 task 只能在 `REMOTE_AGENT_ALLOWED_CWDS` 内使用 `workspaceWrite`，默认禁止网络，不存在 `dangerFullAccess` 路径。
- WebSocket 控制通道只传 role-separated HMAC proof，不传密码原文。默认 `ws://` 只提供双方身份确认，不提供链路加密；跨不可信网络时应放在受信 VPN 内，或由 TLS 终结层提供 `wss://` 并通过严格的 `REMOTE_AGENT_PUBLIC_CONTROL_URL` 公布入口。
- 任务事件必须来自任务所属的 `deviceId`；其他设备不能把别人的任务标记为 completed/failed。
- 文件传输默认限制为单文件 10 MiB、单任务 25 MiB；可通过 `REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES` 或 `REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES` 调整。

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
- bridge 会从 `turn/completed` 的最终 `agentMessage` 提取答案并回传，因此默认禁止网络时任务也能闭环；callback 只用于可选的详细进度和附件。
- 远端 Codex 完成后，可在本机 callback 中填写 `artifactPath`、`logPath` 或 `files`；路径会先解析真实路径，而且只能位于当前任务 cwd 内，junction/symlink 越界会被拒绝。
- 同一“规范 cwd + 线程名”的任务会一直串行到 terminal；恢复到仍有活跃 turn 的线程时先有限等待，无法安全复用就创建独立线程，不把不同任务 steer 进同一个 turn。
- Manager 会把回传文件保存到 `data/remote-agent-files/<taskId>/`，并在任务事件的 `savedFiles` 中记录本机保存路径、大小和 sha256。

远端结果会先回到本机 RabiRoute，再投递回发起任务的本机人格线程。远端 Agent 不应直接回复 QQ；是否回复 QQ 仍由本机人格通过明确发送接口决定。

查询整理轮次：

```http
GET /roles/:roleId/memory/consolidation-runs
GET /roles/:roleId/memory/consolidation-runs/:runId
```

## YeYu Gamer Manager 本机门面

实验性的 YeYu Gamer 接入不是通用 Agent 执行器。启用后，本机 Agent 只能通过 RabiRoute Manager 读取 `/api/agent/yeyu-gamer/{health,meta,snapshot,capabilities}`，以及向 `/api/agent/yeyu-gamer/work-items` 派发 `mode: "plan"` 的 work item。调用方必须使用新鲜 snapshot 的 `stateVersion` 和稳定的幂等键；成功回执只证明 Manager 已记录计划项。

门面只接受 loopback 调用，目标固定为 `http://127.0.0.1:8877/api/v1`。凭据来自 YeYu Gamer 本机运行目录的独立 `rabiroute.token`，不得写入 RabiRoute 配置或返回给调用方。接口不提供 claim、decision、capability invocation、Shell、路径、点击或旧脚本入口。配置、请求和无游戏启动验收方式见 [YeYu Gamer Manager 本机接入](yeyu-gamer-manager-integration.md)。

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
data/roles/<RoleId>/skills/<skill-folder>/SKILL.md
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

### 下载指定技能目录

`GET /api/roles/:roleId/skills/:skillId/download` 返回该技能的完整 ZIP；`GET /roles/:roleId/skills/:skillId/download` 是同权限别名。不接受查询参数、任意文件路径或批量人格导出。远端调用需要已登记节点凭据、准确 Agent 的 Manager API 授权，以及该人格 Route 中的 `instanceId + agentId` 配置；与读取人格技能相同，不增加逐技能授权。本机管理保留原认证。

目录型技能保留所有普通文件、子目录和字节，包括 `scripts/`、`references/`、`agents/`、隐藏文件及二进制配套文件，ZIP 顶层为 `<skillId>/`。平面 Markdown 技能只生成 `<skillId>/SKILL.md`。按技能索引 ID 找真实入口，不假定 frontmatter `id` 等于目录名；重复 ID 返回冲突。不沿 Markdown 引用追踪根外路径或其他技能，需要另一技能时单独下载。下载的是当前 Manager 管理的技能内容，不会将其复制到公开 `resources` 或发布包。

示例（Bash；使用 Hook 给出的已安装连接程序路径，替换占位符，不在远端使用本机 Host 或猜端口）：

安装 launcher 会以当前不可变 release 目录作为工作目录，`./` 不指向用户 shell 或项目目录。请明确选择本机 Rabi Agent 安装目录外、已存在的父目录，并为 `--output` 提供绝对文件路径；最终文件必须不存在。以下 Bash 示例仅在你已选择并确认 `$HOME/Downloads` 存在且位于安装目录外时使用；否则替换为你选择的已有目录，不自动创建目录。`$HOME` 由 shell 展开为绝对路径。

```bash
node rabi-agent.mjs --api GET "/api/roles/<roleId>/skills/<skillId>/download" --agent "<agentId>" --output "$HOME/Downloads/selected-skill.zip"
```

连接程序从私有配置读取 `managerUrl` 和节点凭据，前后核对 `/meta` 的 generation 与实例身份，拒绝重定向。`--output` 仅用于上述 GET 下载；目标父目录须存在，不覆盖已有文件，不自动解压、安装或运行脚本。客户端流式校验 `Content-Length`、`x-rabiroute-content-sha256` 与 ZIP 签名后，以不覆盖方式完成本地文件；返回 `ok`、本地路径、字节数和 SHA-256。失败删除临时文件，不把 JSON 错误保存为 ZIP。普通 `--api` 的 JSON 输出不能用作二进制下载。原子非覆盖完成依赖目标文件系统支持硬链接；不支持的 Mac/NAS 文件系统明确失败，不自动降级为可能覆盖的复制或重命名。若目标已完成但临时文件清理失败，固定错误会以 `committed:true` 提示目标可能已经存在，应先检查现有文件并与可信 SHA-256 人工核对，不自动重下。下载失败保留固定的本地错误码及允许的 HTTP 状态，不回显服务端正文、传输异常或凭据。

响应为 `application/zip`，包含安全 `Content-Disposition: attachment`、`Content-Length`、`x-rabiroute-content-sha256`、强 ETag 和 `Cache-Control: private, no-store`；不承诺 Range/断点续传。服务端在有界交互工作进程中先完整生成并校验，再流式响应；IPC 不传整包 Buffer/base64。默认限单文件 16 MiB、原始累计 64 MiB、4096 个文件/目录条目、深度 32、ZIP 68 MiB。路径穿越、软链/junction、硬链接、非普通文件、不安全跨平台名称或大小写/Unicode 规范化名称冲突会使整包失败；超限也不截断或静默漏文件。读取期间源目录变化返回冲突。技能目录只能由受信本机拥有者维护；Node 的路径检查不等于抵抗拥有本机写权限者的任意并发替换。

| HTTP | 含义与处理 |
| --- | --- |
| 401 | 凭据缺失或无效；核对已登记连接配置，不公开凭据。 |
| 403 | 节点/Agent 或人格未授权，或技能路径/链接不安全；修正绑定或由技能拥有者检查源目录，不绕过限制。 |
| 404 | 已授权人格中不存在该技能；刷新技能列表并核对 ID。 |
| 409 | 技能 ID/归档名称冲突或生成期间源内容变化；由拥有者解决后重新下载。 |
| 413 | 文件、条目、深度或包大小超限；明确缩小技能包，不接受残缺文件。 |
| 503 | 队列忙、超时或工作进程退出未确认；不当作空技能包，不自动反复重试。 |
| 500 | 内部生成或传输失败；保留错误码交 Manager 拥有者排查。 |

整个 Manager 最多同时持有 4 份下载租约，覆盖生成、慢客户端传输和退出未确认的隔离工件；超过上限在创建临时目录前返回 503。成包后的传输限时 30 秒，超时断流并清理，不让慢客户端无限占盘。客户端断连取消生成/传输并清理私有临时工件；退出未确认时保留隔离工件和名额至工作进程实际关闭；清理失败也不提前释放名额。Mac 上的 Node 可以下载 `.ps1`，但这不证明已安装 PowerShell、脚本路径适用于 Mac 或脚本已通过执行门禁。下载成功仅证明文件完整性，不是执行授权。本合同面向已登记 Rabi Agent 到配置 Manager 的连接；公网 RabiLink 大包转发和实际跨机下载仍须单独验收，不能以本地测试代替。

计划可选 `messageChannels` 列表，Agent 可在创建计划或 PATCH 时绑定；省略或 `[]` 均合法，不阻断建计划、执行或人格事件投递。每项为 `{channel, gatewayId, params}`，复用事件投递的 NapCat 群／个人 QQ 与语音参数。计划渠道只用于绑定 Codex 任务的最终结果；与人格规则共同匹配，同一任务、轮次、目标去重。Hook 自动通知不要求原始群消息编号，也不被旧引用式进度通知的失败阻断；Agent 主动回复仍尽量引用来源。


计划与记忆摘要搜索及自动增量缓存接口见 [搜索合同](knowledge-search.md)。

### 错误原因与语言

Manager 失败响应附带 `errorMessages`，包含 zh-CN 和 `en`，并保留原始 message、机器码、提交状态和请求编号。WebGUI 按当前语言显示。已登记的参数、附件、版本冲突和存储错误显示本地化原因；未登记的第三方异常保留诊断原文，不推断未知原因。

正式回传的 inReplyToRequestId 关联受管请求时可省略 prompt，result 与 nextAction 仍必填；普通发送仍要求 prompt。新回复不生成历史结束标记。
