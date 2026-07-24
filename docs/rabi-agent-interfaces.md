<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-agent-interfaces_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent 需要关注的 Rabi 接口

> 状态：现行 Agent 接口指南。远端 Agent 设备链路仍为实验能力；其它接口按当前 Manager API 和测试核对。

本文说明 Agent 在处理 RabiRoute 消息时需要关注的 Rabi 内置接口。它不是普通用户操作手册，而是给 Agent 注入上下文后使用的接口说明。

这些接口用于让 Agent 主动维护计划和记忆，并把普通回复交回 RabiRoute。RabiRoute 负责存储、权限边界、已完成计划的延迟归档、显式记忆整理请求、上下文注入和回复回传；Agent 需要关注的是：什么时候新增或更新计划、什么时候记录近期记忆、收到记忆整理请求时如何返回沉淀记忆，以及需要普通聊天回复时把内容交给回传接口。

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

### 只启用知识接口的本机 Manager 模式

直接在 Codex 中维护角色计划或记忆、但不希望 Manager 自动启动已启用网关、RabiLink Relay 或局域网发现时，可以在启动 Manager 前设置：

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

此模式仍提供 `/meta`、计划、记忆和校验等 Manager HTTP 接口；`GET /meta` 会返回 `managerAutostart: false`。它只关闭自动启动和自动同步，不移除显式运行控制接口，因此调用方仍不得在没有相应授权时请求启动、重启、触发、回传或外发动作。生产托盘和正常消息路由不设置该变量，行为保持不变。

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

普通回复上下文会一并注入：

```text
普通回复 API：http://127.0.0.1:8790/api/agent/replies
当前回复上下文：{"gatewayId":"main","runtimeRouteId":"main","routeProfileId":"main","routeKind":"direct_at","targetType":"group","messageId":123,"groupId":456,"userId":789,"targetGroupId":456,"instanceId":"default","replyApiUrl":"http://127.0.0.1:8790/api/agent/replies","groupLogPath":"data/route/main/group-messages.jsonl","privateLogPath":"data/route/main/private-messages.jsonl","outputAdapter":"agent","outputPipeline":"agent","replyToSource":false}
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

### 语音消息端人格回复

当注入的 `replyContext` 同时包含 `routeKind=voice_transcript`、`adapterType=speech` 和 `characterTtsDialogue=true` 时，本轮来自 RabiPC 语音消息端。Agent 不能只在 Codex 线程里显示文字：应把适合朗读、与最终可见回复同义的 `text` 连同完整 `replyContext` POST 到 `/api/agent/replies`。Outbox 只接受文本，按来源消息重新绑定 Route，并从 Route 读取人格、声线、TTS 模型、语言、情绪指令、`sessionId` 和 `speechAutoPlay`；成功时返回 `sent`，开启播放时表示音频已进入 RabiSpeech 主机级 FIFO，而不是扬声器已经播放完毕。

这个状态只由 `speech` / RabiSpeech 消息端的转写事件注入。不要把 QQ、角色面板或其它文字入口手工标记成语音状态，也不要绕过 Outbox 直连 worker，否则会丢失来源绑定、策略检查和会话隔离。

手机音频流虽然复用同一套 RabiSpeech ASR，但注入的是 `routeKind=rabilink`、`adapterType=rabilink`，并携带稳定的 `sourceDeviceId/sourceDeviceKind`、临时 `sourceStreamId` 和 `channelType=rabilink.mobile_audio`。Agent 仍把完整 `replyContext` POST 到 `/api/agent/replies`；Outbox 只把稳定 `sourceDeviceId` 转成 `targetDeviceIds`，不会把本次 PCM 流 ID 当设备，因此回复只回到原始手机。它不是 `speech` 消息端，也不触发独立语音端的人格 TTS/FIFO 规则。

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

省略 `roleId` 表示同步全部人格。同步器优先局域网直连，失败后经 Relay 受限中转。Agent 必须检查逐文件结果、`fileConflicts` 和 `semanticConflicts`；后者会在同一次同步响应中列出已成功并集合并、但人格声纹关系仍有并发分支的处理主机、声纹、字段和事件候选，不需要另行轮询覆盖率。`conflicts > 0` 或 HTTP `409` 表示仍有待处理冲突，不能声称同步完成。

普通文件冲突由本机 Agent 使用 `GET /api/persona-sync/conflicts`、`GET /api/persona-sync/conflicts/content` 和 `POST /api/persona-sync/conflicts/resolve` 处理。解决动作支持 `keep_local`、`use_remote`、`use_merged`，并应携带列表返回的 `expectedLocalHash` 防止覆盖刚发生的新修改。三条冲突控制接口仅允许回环调用，不经 LAN listener 或 Relay 暴露。底层 manifest、文件读取、单文件 merge 和完整请求字段见 [多电脑人格数据同步](persona-data-sync.md)。

当当前路由消息明确提到多台电脑、人格/角色同步或 persona sync 时，AgentPacket 会把上述回环地址、当前 `roleId`、一次性执行要求和冲突判定直接注入绑定人格的当前任务；普通聊天不注入这段能力说明。默认只同步当前人格，只有用户明确要求时才允许省略 `roleId` 同步全部人格；peer 不唯一时必须先确认目标，不能猜测，也不能用轮询等待覆盖率。

NapCat 群聊需要真实引用原消息时，在 `replyContext` 中同时提供源 `messageId` 和 `replyToSource: true`：

```json
{
  "text": "【工会入口无响应】我先接手调查，有结论后继续引用这里同步。",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "groupId": 456,
    "messageId": 123,
    "instanceId": "default",
    "replyToSource": true
  }
}
```

Outbox 会在字符串消息前添加 OneBot `[CQ:reply,id=123]`，或在消息段数组前插入 `reply` 段。正文已经包含 CQ reply 或结构化 reply 段时不会重复添加。`replyToSource=false`、没有 `messageId`、私聊和主动无源群消息都不会自动添加引用。

发送本地 QQ 群文件时使用同一个回复接口：

```json
{
  "text": "【构建包】版本、渠道和签名已确认，文件已上传。",
  "payloadType": "file",
  "filePath": "C:/Path/To/Allowed/ReleasePkg/build.apk",
  "fileName": "build.apk",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "groupId": 456,
    "messageId": 123,
    "instanceId": "default",
    "replyToSource": true
  }
}
```

对应 NapCat 策略必须允许 `file`，并配置 `messageAdapterPolicies.napcat.allowedFileRoots`。RabiRoute 会校验文件存在、类型和真实路径，再调用 `upload_group_file`；成功结果包含 `sentFileName`，NapCat 返回稳定标识时还包含 `sentFileId`。如果文件上传成功但跟随的说明文本失败，返回仍为 `status=sent` 并在 `reason` 中说明文本失败，调用方只能补发文本，不能重复上传文件。

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
POST http://127.0.0.1:8790/api/agent/threads
```

线程桥提供五个动作：

- `list`：从 Desktop 状态按标题查询本机任务，使用 `offset` / `limit` 分页访问全部结果。
- `read`：通过完整 `threadId` 只读读取 Desktop 任务元数据。
- `resolve`：先读取精确 ID。有效 ID、cwd 一致且未归档时直接绑定，不比较可变的 Desktop/SQLite 标题，也不会因展示标题超过新建上限而否定绑定；保存 ID 指向已归档任务时返回 `409 archived`。只有 ID 为空、非法或确实失效时才按保存名称和可选 cwd 查找，一个或多个同名同 cwd 候选按 `updatedAt` 自动绑定唯一最新者、零匹配按需幂等创建、最大时间并列时返回候选。
- `create`：在已配置工作区创建空任务，再把初始提示词通过 Desktop IPC 投给该任务 owner。Codex 任务名上限为 240 个 JavaScript 字符单元；更长的输入会由 RabiRoute 安全截断并加省略号，响应和后续配置保存实际创建的名称。
- `send`：通过 Desktop IPC 向已有任务 owner start/steer。

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

调用方不要让 AI 或用户手改 UUID。下拉保存名称、完整 ID 和 workspace；用户明确输入新名称时前端先清空旧 ID。有效 ID + workspace 是稳定身份，即使返回标题已变成首条 prompt 或长度超过新建限制也继续该 ID。`resolve` 返回 `id`、`name` 或 `created`；重名最大时间并列时返回 HTTP 409 和 `candidates`。

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
  "prompt": "补充新的约束和验证证据，请续接原任务。"
}
```

安全边界：

- `create` / `send` 的 `cwd` 必须属于当前 RabiRoute 配置中已有的 Codex 工作区；不能用该接口在任意路径启动任务。
- `sandbox` 字段仅为接口兼容参数，不能覆盖目标 Desktop 任务的模型、工具、沙箱或审批；这些能力以 Desktop owner 为唯一真源。
- 创建线程使用固定的调查边界；没有明确实施授权时，只能调查、整理证据和输出方案。
- `create` 返回 `initialTurnStatus`。若线程已经创建但初始 turn 启动失败，应记录返回的 `threadId` 并用 `send` 重试，不能重复创建同名线程。
- 连接器工具可用时可以直接使用连接器；Manager 线程桥只是另一种调用入口，最终仍投给同一个 Desktop owner，不是执行 fallback，也不是 multi-agent 子 Agent。
- Desktop 未启动、IPC 不可用或目标任务无法加载时必须返回失败；不得转给隔离 app-server、Codex CLI 或共享端口继续执行。

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
  "focus": "计划和记忆机制文档",
  "status": "进行中",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "confirm-contract",
  "currentStep": "确认接口文档注入方式",
  "nextAction": "补充 Rabi Agent 接口文档",
  "blockedBy": "",
  "steps": [
    { "id": "inspect-existing", "title": "检查现有计划接口", "status": "已完成" },
    { "id": "confirm-contract", "title": "确认步骤数据契约", "status": "进行中" },
    { "id": "update-docs", "title": "更新双语接口文档", "status": "未开始" }
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

新增计划必须提供有序的 `steps`。`进行中` 计划必须同时提供 `currentStepId`，并让它指向唯一一条状态为 `进行中` 的步骤；界面据此列出全部步骤并标出当前执行位置。阻塞时用当前步骤的 `blockedBy` 记录不能继续的原因，并用 `waitingFor` 记录正在等待的对象；界面优先展示阻塞原因，不重复展示已由步骤列表表达的 `nextAction`。旧计划仍可读取，但下次更新时应补齐结构化步骤。计划进入 `已完成` 或 `已归档` 前，所有步骤都必须为 `已完成`。

`taskBinding` 可在 POST 或 PATCH 中写入，用于精确绑定一个 Codex 执行会话。当前只接受 `agentType=codex` 和非空完整 `sessionId`；`completionHook.enabled` 必须是布尔值。启用后，Codex `Stop` Hook 把官方 `last_assistant_message` 交给 Manager，Manager 再经同人格的角色面板 / Forwarding / AgentPacket 链提醒目标处理会话。`gatewayId` 在同人格有多个 Route 时必填。提醒按 `sessionId + turnId` 去重，不会自动 PATCH 计划、推进步骤或写记忆。

完成提醒失败不会阻断源 Codex 最终回答，但会记录失败并返回非阻塞系统警告。workspace、人格、gateway 或源/目标任务冲突均失败关闭；未完成双真实 Desktop 任务验收前，该接口能力为实验状态。

### 计划审批意见接口

```http
GET  /api/roles/:roleId/plans/:planId/feedback
POST /api/roles/:roleId/plans/:planId/feedback
```

WebGUI/托盘会用该接口记录用户对当前审批步骤的建议，并请求 Manager 通过现有角色面板链路通知 Agent。Agent 从 QQ 等其它入口收到用户审批后，也应调用同一接口补齐计划关联记录：

```json
{
  "feedbackId": "qq-message-12345",
  "gatewayId": "route-id",
  "stepId": "review-plan",
  "text": "同意方向，但先补充回归范围。",
  "kind": "approval_suggestion",
  "author": "user",
  "source": "qq",
  "notifyAgent": false
}
```

Agent 自己的处理说明使用 `kind=approval_response`、`author=agent`、`source=agent`，并保持 `notifyAgent=false`；Agent 记录自动按 `record_only` 保存，不能自我触发新一轮投递。审批意见只记录事实，不推进计划；处理完成后由 Agent 另行 `PATCH /plans/:planId` 更新步骤、阻塞和状态。

更新计划：

```http
PATCH /roles/:roleId/plans/:planId
```

常见用途：

- 更新标题。
- 更新全部步骤及唯一的当前步骤。
- 更新下一步、等待对象和阻塞原因。
- 更新关键词。
- 将状态改为 `进行中`。
- 将状态改为 `已完成`。

计划归档通常不需要 Agent 处理。计划变为 `已完成` 后，角色知识快照会按当前固定的 72 小时窗口把它转为 `已归档`；目前这个归档窗口还不是 `personaConfig.json` 的公开配置字段。

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

记忆时间窗口以活跃时间为准。活跃时间取 `updatedAt` 和 `viewedAt` 中较新的一个。Agent 按 ID 查询近期记忆时，RabiRoute 会刷新 `viewedAt`；Agent 更新近期记忆时，RabiRoute 会刷新 `updatedAt` 和 `viewedAt`；只有距离最后活跃时间超过可编辑窗口的记忆才会进入待沉淀范围。

Agent 新增或更新近期记忆时，应主动填写 `keywords`。RabiRoute 在消息投递前只使用标题和 `keywords` 做轻量召回，不对记忆内容进行实时智能分词。当前消息命中近期记忆标题或 `keywords` 时，RabiRoute 会刷新该条记忆的 `viewedAt`。

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
