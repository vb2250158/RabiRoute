# RabiLink 手机消息端与 Route 会话方案

> 状态：设计草案，待确认后实施。  
> 语言说明：本文是会约束后续实现取舍的 plan 类设计文档，不创建机械英文翻译；面向用户的正式能力、配置、Runbook 与版本说明仍在对应中英文文档中同步维护。
> 核心决定：RabiLink 是一个由 RabiPC 管理的共享手机消息端。手机像 QQ 一样显示 Agent 联系人，每个联系人背后绑定一条现有 Route。持续语音是全局采集能力，手机用一组滑动开关决定哪些 Route 同时收听；RabiPC 只运行一套全局共享 ASR，再把同一份转写分发给已开启的 Route。

## 1. 最终结论

用户看到的产品：

    联系人列表
      夜雨
      Rabi Active
      工作助手

    点击夜雨
      打开固定聊天
      可以文字聊天
      可以一直开启持续语音
      可以点击提示 Agent
      可以接收 Agent 主动消息

    点击“正在听”
      夜雨          [开]
      Rabi Active   [开]
      工作助手      [关]

系统内部：

    一次持续语音切句
      -> 共享 RabiLink 手机消息端
      -> RabiPC 全局 ASR 只转写一次
      -> 读取该手机已开启的 enabledRouteIds
      -> 同一 observation 分发给这些 Route
      -> 每条 Route 各自绑定 Persona / Agent / Thread / Workspace / Policy
      -> 各自经过 Outbox / Action Gate 后回到自己的手机聊天

    当前聊天 routeId
      -> 只决定文字、按住说话和“提示 Agent”的明确目标

    手机设备监听配置
      -> RabiPC 身份 + deviceId + enabledRouteIds

手机不绕过 Route 直接调用 Persona，不为多人监听新增群聊或 listenerGroupId，也不新增需要人工维护的 conversationId。多人监听只是一组 Route 开关。

## 2. Chat App Experience Design Skill 做了什么

全局 Skill 位于：

- `<CODEX_HOME>/skills/design-chat-app-experience/SKILL.md`
- `<CODEX_HOME>/skills/design-chat-app-experience/references/conversation-architecture.md`
- `<CODEX_HOME>/skills/design-chat-app-experience/references/source-map.md`
- `<CODEX_HOME>/skills/design-chat-app-experience/agents/openai.yaml`

它完成的是设计方法沉淀，不是 Rabi App 实现：

1. 用 SKILL.md 定义聊天产品的审阅、设计和验收流程。
2. 用 conversation-architecture.md 定义会话列表、聊天详情、未读、通知、离线和重试原则。
3. 用 source-map.md 记录 Android、Apple、Matrix 等来源和证据边界。
4. 用 openai.yaml 注册 Skill 的显示名和默认提示。

它提出 Conversation 是一级对象，但同时明确平台规范不等于 RabiRoute 的精确领域模型。因此本项目不照搬一个新的 Conversation 后端实体，而是把现有 Route 投影成用户可识别的手机会话。

在手机本地，为避免不同 Rabi PC 出现相同 routeId 后混淆聊天记录，使用复合稳定键：

    MobileConversationKey = rabiGuid 或 targetDeviceId + routeId

该键只用于手机消息归属、未读、草稿、通知和恢复。明确发送给某个联系人时仍使用 routeId，不增加第二套后端路由真源。持续语音则上传一次音频，并由 RabiPC 按该手机的 enabledRouteIds 扇出转写结果。

## 3. 为什么绑定 Route，不直接绑定 Persona

Persona 只回答“谁在说话、怎样理解和表达”，不能唯一回答：

- 使用哪个 Agent adapter。
- 使用哪个 Codex/Copilot/AstrBot/Marvis 任务。
- 使用哪个工作目录和线程。
- 使用哪个 pipeline。
- 是否允许 RabiLink 输入和输出。
- 使用哪套语音与主动审阅策略。
- 外部动作经过什么安全策略。

这些事实现在已经由 Route 统一绑定。

方案比较：

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| 手机直接发送 personaId | 表面简单 | 绕过 Route，无法唯一确定 Agent、线程、工作目录和策略 | 不采用 |
| 手机联系人隐藏绑定 routeId | 复用现有模型，边界清楚 | 需要修复 PC 共享入口的精确分发 | 采用 |
| 新增 conversationId 到 routeId 注册表 | 可支持同一 Route 下多个独立实例 | 当前没有需求，产生重复身份和迁移成本 | 暂不采用 |

只有未来出现“一条 Route 下必须同时保存多个长期独立聊天实例”的明确需求，才重新评估独立 conversationId。

## 4. 产品信息架构

### 4.1 联系人列表

每个联系人是一条启用且允许 RabiLink 输入的 Route 投影。

联系人展示：

- 人格名称和头像。
- Route 场景名，例如“日常陪伴”“RabiRoute 开发”。
- 最新消息预览。
- 时间。
- 未读数量。
- 可信的 PC、Route、Speech 状态。
- 主动智能开启、暂停或安静时段状态。

同一 Persona 可以被多个 Route 使用。手机通过场景副标题区分，而不是把它们错误合并。

### 4.2 聊天详情

进入联系人后：

- 文本、按住说话、附件和提示 Agent 都冻结当前 routeId，只发给当前联系人。
- 持续语音不是当前聊天的私有麦克风；它把一次 ASR 结果送给“谁在听”开关中已启用的所有 Route。
- 收到其它 Route 的消息时，不抢走当前页面，只更新对应联系人预览和未读。
- 通知携带 Rabi PC 身份和 routeId，点击直达正确聊天。
- 返回时恢复联系人列表原来的滚动与选择位置。
- 切换联系人后，新消息使用新 routeId；已排队消息保持入队时的原 routeId。

### 4.3 聊天设置

用户看到：

- 持续语音。
- 允许这个 Agent 收听持续语音的滑动开关。
- 主动智能开关。
- 临时暂停。
- 安静时间。
- 介入程度。
- 自动播放回复语音。
- 当前 Persona、Agent、PC 和 Route 状态摘要。

用户不需要看到或填写 routeId。开关背后保存 routeId；高级按钮可以打开 RabiPC 对应 Route 配置。

### 4.4 全局设置

全局设置只放：

- RabiLink 登录和 Relay。
- 默认 Rabi PC。
- 手机与眼镜授权。
- 通知权限和省电引导。
- 本机采集参数。
- RabiPC 当前全局 ASR 的只读状态和跳转入口。
- 队列和诊断。

Route、Agent、主动策略和 PC ASR 模型不在手机保存第二份真源。手机可以修改监听开关，但必须由 RabiPC Manager 保存并回读确认。

### 4.5 谁在听

持续语音页或常驻通知中的“正在听：N 位”可以点开一个简单列表：

    谁在听
      夜雨                         [开]
      Rabi Active                  [开]
      工作助手                     [关]

交互规则：

- 一条允许 RabiLink 输入的 Route 对应一行；显示 Persona 名称和 Route 场景副标题。
- 只有一个滑动开关：开表示接收这台手机的持续语音 observation，关表示不接收。
- 切换后立即提交 Manager；只有收到确认才显示成功，失败则回滚并解释原因。
- 不创建群聊，不要求用户保存一套“监听组”，也不暴露 routeId。
- 当前打开哪个聊天与哪些 Agent 正在听是两个独立状态。
- 关闭监听不影响用户在该联系人聊天中明确发送文字、按住说话或点击提示 Agent。
- Route 是否最终主动发言，继续由各自主动智能和 Action Gate 决定；监听开关不等于强制每次回复。

### 4.6 通知栏必须显示“谁在听”

RabiConversationService 的常驻前台通知不能只写“Rabi 持续会话”，必须显示实际启用监听的 Agent，让用户随时知道同一份转写正在交给谁。通知显示的是 enabledRouteIds 的有效运行投影，不是当前聊天联系人。

推荐通知：

| 真实状态 | 通知标题 | 通知正文 |
| --- | --- | --- |
| 手机麦克风采集中，1 条监听 Route 就绪 | 夜雨正在听 | 手机持续语音 · RabiPC ASR 已连接 |
| 手机麦克风采集中，2 条监听 Route 就绪 | 夜雨、Rabi Active 正在听 | 手机持续语音 · 2 位 Agent |
| 手机麦克风采集中，3 条以上监听 Route 就绪 | 3 位 Agent 正在听 | 夜雨、Rabi Active 等 · 点按管理 |
| 眼镜麦克风采集中，多条监听 Route 就绪 | 3 位 Agent 正在通过眼镜听 | 点按查看名单 |
| TTS 正在播放，采集为防回流而暂停 | Agent 正在说话 | 播放结束后恢复聆听 |
| 用户暂停持续语音 | 持续语音已暂停 | 点按继续聆听 |
| PC 离线但手机仍保留采集队列 | RabiPC 当前离线 | 语音将保存在手机，恢复后只送给原监听对象 |
| 部分 Route 不可用 | 2 位 Agent 正在听 | 1 位不可用 · 点按查看 |
| 没有开启任何 Route | 尚未选择收听 Agent | 点按选择谁可以听 |

“正在听”只在以下条件同时满足时显示：

- 麦克风采集状态为 active。
- 至少有一条已开启且有效的监听 Route。
- 目标 RabiPC 在线。
- 至少一条目标 Route 运行且允许 RabiLink 输入。
- RabiPC 全局 ASR 入口就绪。

如果只是在本地采集和排队，通知必须写“离线、已排队”，不能继续显示“正在听”。

常驻通知操作：

- 点击通知：打开“谁在听”页面；若只有一位监听者，也可以直达对应聊天。
- 暂停聆听 / 继续聆听。
- 管理监听者：展开手机上的 Route 开关列表。
- 停止持续会话：放在展开操作或聊天设置中，避免误触。

Agent 普通回复使用独立的联系人消息通知：

    夜雨
    我已经看过刚才的内容……

该通知携带 Rabi PC 身份和 routeId，点击直达对应聊天。锁屏隐私模式可以隐藏正文，但仍应显示允许公开的人格名称；若用户选择完全隐藏，则显示“Rabi 收到一条消息”。

通知显示名来自 RabiPC 发布的 Route/Persona 投影，手机只允许缓存用于离线展示。通知状态由统一 ListeningStatus 运行投影生成，不在多个 Activity、Service 和 Backend 中各拼一套文案。

## 5. 能力架构

    Android 手机
      联系人列表和聊天详情
      当前 MobileConversationKey
      谁在听开关列表
      RabiConversationService
      Device Capture Profile
      本地可靠队列、cursor、未读和通知
                |
                | 一份音频 + deviceId
                v
    Relay
      认证
      PC 级持久邮箱
      附件
      下行 cursor
                |
                v
    RabiPC 共享 RabiLink 消息端
      单一 Ingress Runtime
      全局 ASR Runtime（每段音频只转写一次）
      手机设备监听订阅 enabledRouteIds
      校验每条 Route 已启用且允许 RabiLink
      同一 observation 扇出到 1..N 条 Route
                |
                v
    Route Runtime A / B / ...
      各自 Persona
      各自 Agent / Thread / Workspace
      各自 TTS Voice Profile
      各自 Proactive Policy
      各自 Persona Context Ledger / Review State
      各自 Outbox / Action Gate

## 6. 模块分工

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| 手机联系人/聊天 UI | 展示 Route 投影、选择当前聊天、管理“谁在听”、未读和消息状态 | 不解析 Persona 文件，不保存 Route 真源 |
| RabiConversationService | 前台服务生命周期、持续收音编排、常驻通知、重启恢复入口 | 不选择人格和 Agent |
| Device Capture Profile | VAD、静音、最短语音、最长切句、pre-roll、本机播放偏好 | 不保存 PC ASR/TTS 模型和主动策略 |
| Relay | 认证、PC 级邮箱、持久上下行、附件和 cursor | 不解释 Persona，不选择 Route |
| RabiPC 全局 ASR Runtime | 对每段音频执行一次 ASR，发布规范 observation | 不为每条 Route 重复加载模型，不选择人格 |
| 手机设备监听订阅 | 按 deviceId 保存 enabledRouteIds，并发布手机可见投影 | 不创建群聊，不复制 Route 配置 |
| 共享 RabiLink Ingress | 单例领取、校验订阅、把同一 observation 精确扇出到已开启 Route | 不拥有 Agent，不做人格判断 |
| Route Runtime | 绑定 Persona、Agent、线程、工作目录、TTS 声线和主动策略 | 不拥有手机采集参数和全局 ASR 模型 |
| Persona | 关系、表达、计划、记忆、技能和介入判断框架 | 不拥有 Relay、设备和审阅毫秒值 |
| 主动审阅器 | 按 Route 策略审阅、反思、静默或提示 | 不绕过 Route 和 Action Gate |
| Outbox / Action Gate | 外发、高风险动作、审批和审计 | 不负责持续收音和联系人选择 |

RabiConversationService 维护的 ListeningStatus 是运行时投影，不是新配置真源。它组合：

- 当前 Rabi PC 身份、deviceId 和 enabledRouteIds。
- 各监听 Route/Persona 的缓存显示名。
- 手机或眼镜采集状态。
- PC、全局 ASR 和各 Route 就绪状态。
- TTS 播放和防回流暂停状态。
- 本地队列数量和暂停原因。

任何来源变化都触发同一个通知刷新入口，避免通知栏显示旧人格或虚假在线状态。

## 7. 配置唯一真源

### 7.1 共享 RabiLink 消息端

唯一真源在 RabiPC Manager：

- Relay URL、凭据和 Rabi PC 设备身份。
- 在线手机和眼镜。
- 共享 Ingress 状态。
- 全局 ASR provider、model、language、设备和就绪状态。
- 每台手机的 enabledRouteIds 监听订阅。
- 全局队列与诊断摘要。

ASR 这部分全 Persona、全 Route 共用，只配置一次。手机提供监听开关 UI，Manager 才是订阅状态真源；这样用户只在手机点开关，不需要去 PC 重复配置每个人格。

### 7.2 Route

唯一真源仍是 data/route 下对应的 adapterConfig.json：

- Route 是否启用。
- 是否允许 RabiLink 输入和输出。
- Persona 绑定。
- Agent、线程、工作目录和 pipeline。
- TTS Voice Profile 引用。
- 主动智能运行策略。
- Route 输入输出 policy。
- 手机联系人显示名覆盖和场景副标题。

手机只读取投影，或通过 Manager API 远程编辑并读回确认。

### 7.3 Persona

Persona 继续负责：

- 人格正文、关系和表达。
- 计划、记忆和技能。
- 消息模板。
- L0 到 L5 的主动介入判断框架。
- 人格默认声线身份。

同一 Persona 被多个 Route 使用时，各 Route 可以有不同的主动智能开关和调度参数。

### 7.4 手机本机

手机只保存：

- 当前 Rabi PC、当前聊天 routeId，以及 Manager 最近确认的 enabledRouteIds 缓存。
- 每条本地聊天的消息、未读、草稿和失败状态。
- 持续收音、眼镜模式和自动播放。
- VAD threshold、静音时间、最短语音、最长切句和 pre-roll。
- 本地队列、cursor、去重和重试状态。

20 秒作为最长切句默认值，可以在高级采集设置中调整，不属于 Persona 或 Route 主动策略。

### 7.5 PC 语音

ASR 和 TTS 不放在同一个作用域：

- ASR provider、model、language 和输入设备属于 RabiPC 共享 RabiLink Speech Ingress，全局一份。
- 一段手机音频无论有几个 Agent 在听，都只做一次 VAD 后 ASR。
- TTS 引擎和 voice 仍可由 Route / Persona voice profile 决定，因为不同 Agent 需要不同声线。

手机只显示 RabiPC 当前 ASR 的友好名称和状态；选择或更换 ASR 跳转到 RabiPC 全局设置，不在每个 Agent 的开关行重复出现模型配置。

## 8. 主动智能配置

主动智能不是新消息端，而是 Route 的结构化运行能力。

第一版建议归 Route：

| 配置 | 作用 |
| --- | --- |
| enabled | 当前 Route 是否启用主动智能 |
| autoReview | 新 observation 稳定后是否自动审阅 |
| reviewInterval | 检查是否需要调度 |
| settleDuration | 等待连续转写稳定 |
| reflectionInterval | 无新语音时低频反思 |
| quietHours 和 timezone | 安静时间 |
| interventionCap | 当前 Route 允许的最高主动介入等级 |
| cooldown | 两次主动提示的最短间隔 |
| contextLinks | 可选的 planId、taskId 引用，不复制正文 |

外发、删除、购买、设备控制等安全规则继续由现有 Outbox / Action Gate 拥有。主动智能配置不能复制一套安全策略。

Persona prompt 解释不同介入等级的角色化判断；Route 的 interventionCap 只限制这个手机会话最高允许主动到什么程度。

## 9. 核心流程

### 9.1 持续语音上行

    用户开启持续语音
      -> 选择一个已开启 RabiLink 消息端的 Route / 人格会话
      -> Android 持续传有序 16 kHz mono PCM，不做 VAD 或切句
      -> RabiPC RabiSpeech 对同一流执行 VAD、切句、ASR 与声纹
      -> 每个完成语段只写一次主机通用语音消息
      -> 按 messageAdapterType=rabilink 与冻结的 routeProfileId 命中目标 Route
      -> Route 按 NapCat 相同关系把消息交给绑定人格
      -> 写入该人格的 voice-transcripts.jsonl 与 conversation/current.jsonl
      -> 人格结合自己的关系、记忆、上下文和主动策略决定安静、准备或回应

未知、已禁用或不允许 RabiLink 的订阅 Route 必须对该 Route 明确失败，但不能让一个失效 Route 阻止其它有效监听者收到 observation。禁止：

- 为每条监听 Route 重复运行 ASR。
- 因为当前聊天打开某联系人，就偷偷把其它已开启监听者关掉。
- 按 Persona 名称模糊匹配。
- 广播给未在 enabledRouteIds 中的 Route。
- 让最先领取 Relay 任务的 Route 决定人格。

监听订阅变更只影响变更确认后的新切句。已经进入本地队列的音频保留入队时的订阅快照，避免离线恢复后悄悄改投另一批 Agent；RabiPC 送达时仍要重新校验 Route 权限。

### 9.2 提示 Agent

    当前聊天点击提示 Agent
      -> review_request 冻结 routeId
      -> 精确找到 Route
      -> 唤醒该 Route 的 Agent
      -> 结果返回同一个 routeId

提示 Agent 仍是明确发给当前聊天的定向动作，不等于提示全部监听者。其它已开启 Route 是否主动回应刚才的 observation，由自己的主动智能策略决定。

### 9.3 主动下行

    Route 审阅器 / 计划 / 定时器
      -> Route 绑定的 Agent
      -> Outbox / Action Gate
      -> Relay 下行携带 routeId
      -> 手机写入正确聊天并通知

主动下行可以脱离某一条上行 taskId，但不能脱离 Route。

### 9.4 PC 离线

- 手机前台服务和本地通知继续存在。
- 音频、文本和附件进入本地可靠队列。
- UI 显示“RabiPC 离线，已排队”，不伪造 ASR 或 Agent 状态。
- PC 恢复后，持续语音按队列项原监听订阅快照补传；明确聊天消息按原 routeId 补传。
- 某条 Route 被删除或禁用时记录该监听者失败，其它快照内有效 Route正常送达，不自动替换监听者。

## 10. 账本与审阅状态

RabiRoute 的 Persona 上下文可以跨 Route 共享，但审阅调度状态必须按 Route 隔离：

- 一段音频只产生一个 observationId；扇出记录保存 deviceId、订阅版本和目标 routeId，不能复制原始音频或重复 ASR。
- Persona 账本每条 RabiLink 记录保存 routeId 来源，并允许用 observationId 去重。
- 审阅游标、最近调度、cooldown 和待处理状态按 Route 保存。
- Route 审阅器默认只消费自己的新增记录。
- Agent 可以按 Persona 规则回看其它入口历史，但跨 Route 读取不等于其它 Route 一起响应。
- Agent 下行写回 routeId，保证通知深链和去重正确。

这样既允许多条已开启 Route 同时听到同一件事，也避免重复转写、重复入账，以及一个定向“提示 Agent”误唤醒所有 Agent。

## 11. 配置界面

### RabiPC 消息适配器页

只配置一个共享卡片：

    RabiLink 手机消息端
      Relay：已连接
      共享 Ingress：运行中
      手机：1 台在线
      眼镜：未连接
      全局 ASR：RabiSpeech / 当前模型 / 就绪
      当前监听：2 条 Route
      查看诊断

这里不选择 Persona。

### RabiPC Route 页

每条 Route 配置：

- 允许 RabiLink 手机聊天。
- 手机联系人预览。
- Persona 和 Agent 绑定。
- TTS Voice Profile。
- 主动智能。
- Route 账本和审阅状态摘要。

### 手机聊天设置

手机显示用户语言：

    夜雨
      持续语音
      允许夜雨收听             [开]
      主动智能
      安静时间
      介入程度
      回复声线
      RabiPC 状态

持续语音主页面还提供统一入口：

    谁在听（2）
      夜雨                       [开]
      Rabi Active                [开]
      工作助手                   [关]

监听开关由手机操作、Manager 按 deviceId 保存；设备采集设置保存手机本地；主动智能等聊天设置远程保存目标 Route；全局 ASR 只在 RabiPC 设置。

## 12. 协议兼容

当前协议使用 routeProfileId。迁移方案：

1. routeId 成为新文档和新请求的规范名称。
2. 接收端在兼容窗口同时接受 routeId 与 routeProfileId。
3. 两者同时存在且不同则拒绝，不猜测。
4. 新手机版本只发送 routeId。
5. 旧 Relay 队列项继续可读，PC 入口归一化后再分发。
6. 超过队列保留期并完成发布迁移后，再评估删除旧别名。

内部继续使用现有 Manager Route id，不人工新增 UID。

## 13. 实施阶段

### 阶段 0：确认模型和并行边界

- 确认一个共享消息端、一个联系人对应一条 Route，持续语音监听者是 Route 开关集合。
- 不新增监听组、群聊或 listenerGroupId。
- 正在进行的 Android 会话列表重构继续，联系人内部使用 Rabi PC 身份加 routeId。
- 本方案不覆盖并行任务正在编辑的 Android 文件。

### 阶段 1：Route 联系人投影

- Manager 只发布启用且允许 RabiLink 的 Route。
- 返回 Route 名称、Persona 展示、状态和能力摘要。
- 手机不再把所有 Route 无条件显示成 Persona。
- 增加本地复合会话键、每会话未读、草稿和通知深链。
- 手机增加“谁在听”Route 列表和单个滑动开关。
- 常驻前台通知显示实际有效监听者；开关、连接或 Route 状态变化时立即刷新。
- 普通消息通知按 Rabi PC 身份和 routeId 分组并深链到正确聊天。

验收：两条 Route 显示为两个联系人；A 打开时收到 B，A 不跳页，B 未读增加；监听开关成功后必须读回 Manager 状态。

### 阶段 2：共享 Ingress

- 把 Relay 任务领取从各 Route worker 竞争改为 Manager 管理的单一 Ingress Runtime。
- RabiPC 只加载一套全局 ASR；每段手机音频只转写一次。
- Manager 按 deviceId 保存 enabledRouteIds 和版本。
- Ingress 先校验订阅，再把同一个 observation 扇出到所有有效监听 Route。
- 精确 Route 集合确定前不写 Persona 账本、不推进审阅状态。
- 某条 Route 不存在或未允许 RabiLink 时只让该分支明确失败。

建议由 Manager 管理独立 runtime/worker，避免把长时数据面全部塞进 Manager HTTP handler。

验收：同时打开两条 Route 的监听开关，发送 100 段音频；ASR 调用 100 次而不是 200 次，两条 Route 各收到同一批 100 个 observationId，未开启的第三条 Route 收到 0 条。

### 阶段 3：Route 专属审阅状态

- Persona 账本记录 routeId。
- 审阅游标、settle、reflection 和 cooldown 按 Route 隔离。
- 手动提示只唤醒目标 Route。
- 主动下行强制使用发起 Route 的 routeId。

验收：同一 Persona 的两个 Route 可以共享 observation，但不抢审阅游标；是否主动回复分别服从各自策略。

### 阶段 4：主动智能配置

- 把现有 routeVariables 中的主动参数迁移为结构化 Route 配置。
- RabiPC Route 页面增加主动智能设置。
- 手机聊天设置增加简化远程界面。
- 增加安静时间、介入上限和 cooldown。
- 安全动作继续走现有 Action Gate。

### 阶段 5：语音和采集配置

- RabiPC 共享 RabiLink Speech Ingress 接管全局 ASR provider、model、language 和设备。
- Route / Persona Voice Profile 保留各自 TTS 声线。
- 手机不再拥有 ASR 模型字符串真源，只显示状态和 RabiPC 设置入口。
- Capture Profile 增加 min speech、max segment 和 pre-roll。
- 20 秒保留为默认值并允许高级调整。

### 阶段 6：真机和长时验收

- Android 后台、锁屏、通知、厂商省电。
- PC 离线和恢复补传。
- Route 停止、删除、换 Persona 和换 Agent。
- 手机与 Rokid 眼镜分别验收。
- 连续运行至少 8 小时观察队列、内存、电量、重复消息和 TTS 回流。
- 验证锁屏、通知折叠/展开、人格切换、PC 离线、Route 停止和 TTS 播放时的通知文案真实变化。

24 小时可使用不等于保存 24 小时原始音频，也不表示 Android 重启后可绕过系统限制自动启动麦克风。

## 14. 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| Route A 为夜雨，Route B 为工作助手，两个监听开关均开启 | 一段持续语音只做一次 ASR，A/B 都收到同一 observation |
| Route A 开启、Route B 关闭 | 持续语音只送 A，B 不收到 |
| A/B 都在听，但当前聊天为 A | 文字、按住说话和提示 Agent 只送 A；持续语音仍送 A/B |
| A/B 使用同一 Persona、不同 Agent | 上下文可共享，审阅和回复不串线 |
| A 打开时 B 收到消息 | A 不跳页，B 预览和未读更新 |
| 点击 B 通知 | 直达 B，返回联系人列表 |
| 点击提示 Agent | 只唤醒当前聊天 Route，不广播全部监听者 |
| 只有夜雨监听开关开启 | 常驻通知显示“夜雨正在听” |
| 夜雨和工作助手都开启 | 常驻通知显示两者名称或“2 位 Agent 正在听” |
| 切换当前聊天但监听开关不变 | 常驻通知名单不变 |
| 关闭夜雨监听开关 | Manager 确认后通知立即移除夜雨 |
| TTS 播放导致采集暂停 | 通知显示“正在说话”，不得仍显示“正在听” |
| PC 离线 | 通知显示离线和排队状态，不伪造正在听 |
| 点击常驻通知 | 打开“谁在听”列表；只有一位时可直达该聊天 |
| 点击其它 Route 的消息通知 | 打开该 Route 聊天，不改变原聊天的未读状态 |
| 排队后修改监听开关 | 旧持续语音队列保持原订阅快照，新切句使用新订阅 |
| PC 离线 | 手机排队并明确显示离线 |
| Route 删除或禁用 | 明确失败，不默认投递其它 Route |
| 定向消息缺少 routeId | 失败，不按 Persona 或第一条 Route 猜测 |
| 持续语音没有监听者 | 不运行 ASR 或不上传，并明确提示选择谁可以听 |
| routeId 与 routeProfileId 冲突 | 失败并写诊断 |
| 高风险动作 | 继续要求现有审批 |
| 修改最长切句 | 真机按新 Capture Profile 分段 |

## 15. 明确不做

- 不让手机绕过 Route 直连 Persona。
- 不为每个 Persona 创建一个 RabiLink 消息端。
- 不为一组监听开关创建 listenerGroupId 或隐藏群聊。
- 不新增没有当前消费需求的后端 conversationId。
- 不把全部主动配置塞进 Persona。
- 不让手机成为 Route、Agent、模型或安全策略的第二真源。
- 不让定向的提示 Agent 广播多个 Agent；多人持续监听只由明确打开的开关产生。
- 不为每条监听 Route 重复加载或调用 ASR。
- 不把持续收音的每句话都当命令。
- 不长期保存 24 小时原始音频。

## 16. 完成标准

最终必须可以用一句用户语言解释：

> 手机像 QQ 一样显示 Agent 联系人。明确聊天消息发给当前联系人背后的 Route；持续语音只转写一次，再按手机上的滑动开关同时交给所有已开启的 Agent。用哪个 ASR 只在 RabiPC 全局设置，各 Route 继续决定自己的人格、Agent、回复声线和主动策略，所有外部动作仍经过安全门。

工程上同时满足：

- 用户无需看到或填写 routeId。
- 手机本地用 Rabi PC 身份加 routeId 稳定区分聊天。
- 明确聊天消息在 PC 只有一个目标 Route；持续语音 observation 可以有多个显式开启的目标 Route。
- 无论开启多少监听者，每段音频只执行一次全局 ASR。
- 每台手机的监听开关由 Manager 保存、手机编辑并读回确认。
- 多 Route、多 Persona、同 Persona 多 Route 均不串线。
- 消息端全局配置只有一份。
- Route、Persona、设备、语音、主动策略和安全策略各有唯一真源。
- 离线、失败和未就绪状态可解释、可恢复。
