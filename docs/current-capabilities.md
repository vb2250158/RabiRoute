<!-- docs-language-switch -->
<div align="center">
<a href="./current-capabilities_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 当前能力与成熟度

本文描述 RabiRoute 当前 `0.1.x` 工作树中实际存在的能力，不把需求稿、设计稿或外部设备设想当成已完成功能。结论来自配置 Schema、运行入口、Manager API、WebGUI、适配器实现和当前自动化测试。

## 成熟度定义

| 状态 | 含义 |
| --- | --- |
| 已验证 `verified` | 项目内有完整实现、配置/诊断入口和自动化契约测试；外部平台仍可能要求账号、登录或真机环境。 |
| 实验支持 `experimental` | 代码链路和配置入口已经存在，也有局部测试或扫描诊断，但真实外部系统的端到端兼容仍需要按环境验收。 |
| 人工接力 `stub` | 只有有限集成，例如打开应用、复制 prompt 或生成交接文件，不应宣传成可靠后台投递。 |
| 设计中 `planned` | 只存在方案或计划文档，当前代码没有对应闭环。 |
| 历史参考 `historical` | 记录旧路线、调研或交接过程，不代表当前主链。 |

成熟度是项目自身扫描接口使用的状态，不等于第三方平台的生产认证。

## 当前主链

```text
Message Adapter / Manager Entry
  -> JSONL Event Store
  -> RouteDecision
  -> AgentPacket
  -> Agent Adapter
  -> Outbox / Reply
```

RabiRoute 负责消息进入、规则匹配、上下文包装、处理端投递、回复路由和审计。处理端负责回答、执行、工具调用和自己的会话状态。

## 消息入口

语音入口当前会把整段 RMS 与峰值连同时间、来源、模型和完整分段保存一次到主机通用消息，再复制为各人格自己的历史/上下文快照。两项响度字段只描述音频，不扩大主机身份判断边界。

仓库另提供多个 TTS 声音合成单 WAV 的本机声纹预检；它验证组合文件内的分段提取和聚类，但显式边界不是 ASR 自动分人证据，合成结果也不具备真人正式校准资格。

| 入口 | 状态 | 实际边界 |
| --- | --- | --- |
| NapCat / OneBot | 已验证 | Gateway 子进程通过 WebSocket 接收 QQ 群聊和私聊；Manager 可扫描、添加、启动、重启、移除和修复多个 NapCat 实例；OneBot HTTP 用于状态查询和外发；合并转发消息会展开为文本/媒体证据。收到的 QQ 图片会立即保存为本机附件；下载失败会保留明确的不可用状态，不让处理端把图片当成已经看过。 |
| 人格自动化 | 本机实现与自动化测试已验证；长期运行待继续观察 | 人格规则统一支持消息或定时触发，并可通知 Agent 或运行受限本机脚本。旧消息模板规则兼容迁移；脚本默认关闭，只能来自人格 `scripts/` 目录，Agent 与脚本结果分开记录。 |
| 定时任务运行入口 | 已验证 | Gateway 子进程承载定时人格自动化；支持间隔、时间窗口、每天指定时间和单次指定时间。通知 Agent 时可选在固定 Codex 线程忙碌时跳过；脚本动作使用独立本机权限。 |
| 角色面板 | 已验证 | Manager/托盘提供的内置本地入口，不是独立网络 listener；使用固定 `role_panel_message` 规则，记录写入角色目录的 timeline。 |
| 跨人格消息 | 自动化合同已验证；待真实双人格 Desktop 验收 | `GET /api/personas` 提供不含正文和本机目录的人格列表；`POST /api/personas/:personaId/messages` 校验 AgentPacket 注入的 Route + 人格绑定凭据，并复用目标 Route 的固定 `role_panel_message` 链。请求必须带稳定 `deliveryId`；同 ID 同内容复用回执，内容变化返回冲突。目标有多个已启用 Route 时必须明确选择，给自己发送和超过 8 跳都会拒绝。普通回复不会自动返回来源人格，回复时必须显式反向投递并沿用会话关联字段。 |
| 计划审批事件 | 已验证 | 审批意见落盘后由 Manager 生成独立 `plan_feedback` 系统事件；不依赖可编辑消息规则，不写聊天 timeline/会话账本，不注入最近消息。 |
| Manual trigger | 已验证 | Manager API 和日志诊断页可真实触发 `manual_trigger` 或 heartbeat 规则；它不是消息适配器。 |
| Remote Agent | 实验支持 | Manager 作为 v3 出站控制端扫描并连接远端 bridge，使用密码挑战握手，支持任务、事件和双向文件；Gateway 子进程只显示占位状态，不另开 listener。 |
| RabiSpeech 语音消息端 | 实验支持 | RabiSpeech 只维护一份 ASR/VAD、声纹处理和 FIFO。Android 手机/眼镜与独立语音客户端一样只持续传 PCM，不切句、不跑模型；PC 对手机流完成处理后只投 `rabilink` Route，本机/普通远程声卡只投 `speech` Route。每段转写先写一次主机级语音消息库，各绑定人格再分别写自己的原始记录和会话上下文。主机只保存不透明声纹/聚类证据，不判断声纹是谁或谁是“用户”；手机回复默认回原设备。正式自动声纹只接受显式确认的真人私有数据集及完整哈希门禁报告，合成 TTS/旧报告始终只作预检。标准安装不含语音环境或模型；模型管理页可列出允许清单并逐个下载权重，但“已下载”不代表独立运行环境或真实推理已经验收。 |
| FenneNote | 已退役兼容 | 不再出现在新增消息端或新规则 UI；只读取旧 Route，并保留历史 webhook/Outbox 兼容以便迁移。 |
| 小米音箱 / 小爱 | 实验支持 | RabiRoute 提供命名回调入口和 PC 侧桥接目录，但必须依赖 open-xiaoai、xiaogpt 或自定义桥把音箱事件送到 PC；不是音箱直连核心。 |
| RabiLink | 实验支持 | 同时存在本地兼容入口、全局 Relay Runtime 和 Route worker；Android 手机/眼镜通过 Relay SSE 收到队列事件后按 cursor 单次补漏，音频只传 PCM，PC 完成 ASR 后进入主机通用语音库和选定 RabiLink Route；主动消息与回复走独立 Relay 下行队列。明确目标下行在 `delivered` 前不按 TTL 删除，手机持久补传 `delivered/played/playback_failed`，而 `played` 只能由手机/眼镜各自 AudioTrack marker 产生。Rokid AIUI AIX 的宿主只提供整包 HTTP、没有 SSE/WS/分块回调，为保证前台主动消息功能保留 25 秒长等待这一受控例外。代码回执闭环已完成，手机/眼镜实际扬声器和穿戴设备仍需真机验收。 |
| 智能手表 / 手环健康消息端 | 实验支持 | `wearable.health` 结构化观测进入按角色分日的健康时间线；Manager 可查询当前状态、历史和摘要，阈值/冷却命中后以 `wearable_health_alert` 投递 Agent。Android 可选 Health Connect 或 PC ADB Companion；Health Connect 优先事件触发，小米 ADB Provider 因没有可靠变更通知，在用户显式启用 Companion 后保留分钟级低频轮询。小米真机已闭环心率、睡眠会话、阶段、睡/醒状态、去重和查询；无需 ADB 的 MiWear SPP 直连仍未作为默认采集器。 |
| 通用 Webhook | 实验支持 | 接收没有专用适配器的外部 POST；已有命名平台应使用自己的适配器，以保留日志和回传语义。 |
| 企业微信 / WeCom | 实验支持 | 使用 `@wecom/aibot-node-sdk` 的智能机器人 WebSocket 长连接，支持群消息进入和 Outbox 回发；需要真实 Bot ID/Secret 验证。 |
| 个人微信 / Weixin | 实验原型 | 通过 OpenClaw iLink API 长轮询个人微信消息；WebGUI 区分安全会话恢复、暂时不可达、明确失效和从未登录，二维码只在用户明确请求后生成。Windows 使用当前用户 DPAPI 保护会话材料，其它平台使用本机 AES-256-GCM。文本可进入 Agent，并可按来源会话回发文本或受控本地文件；入站媒体只记录。长期在线、真实账号风险和稳定性验收仍未完成。 |
| 飞书 / Feishu | 本地实现已验收，待真实凭证联调 | 独立应用事件回调，支持 URL challenge、原始请求体签名校验、Encrypt Key 解密、按 `event_id` 持久去重、按 `chat_id` 隔离上下文并向来源 chat 回发文本。缺少应用凭据或事件订阅确认时监听与出站均关闭；未使用群机器人 Webhook。 |

`disabled` 只是兼容配置值，不是一个消息入口。

## 路由与上下文

- 一条 route 可以配置多个消息适配器、每适配器输入/输出 policy、多个 Agent adapter、pipeline、工作目录和人格绑定。
- 路由规则保存在人格根级 `personaConfig.json` 中；多条 Route 绑定同一人格时复用同一套规则、语音关键词和上下文额度。无人格 route 会生成默认规则；角色面板规则始终存在。
- 当前 route kind：`private`、`group_message`、`direct_at`、`direct_reply`、`indirect_reply`、`heartbeat`、`manual_trigger`、`role_panel_message`、`plan_feedback`、`voice_transcript`、`rabilink`、`wearable_health_alert`、`wecom_message`、`weixin_message`、`feishu_message`。
- `RouteDecision` 只负责规则匹配；`forwarding.ts` 遍历 active route profile、写审计并投递每一条命中规则。
- `AgentPacket` 会注入事件、普通消息端在当前人格/逻辑消息端/会话下的最近双向消息、角色与相对路径、计划/记忆/技能索引、必要读取项、日志路径、明确发送 API、`sendRequestJson` 和只读来源 `replyContext`。普通消息按“最近消息 → 本轮消息 → 当前讨论与引用证据”的顺序呈现；发送模板包含精确 Route、渠道和目标参数，来源上下文不参与目标推断。当前 Route 启用时，`replyContext` 还包含只绑定该 Route 与人格的跨人格投递凭据。持久计划秘书开关开启且已经绑定任务时，还注入每个槽位的完整 ID、名称、workspace 和分配规则。Heartbeat 与 `plan_feedback` 固定省略历史段。
- 持久“协助处理计划”任务是计划管理秘书，不是业务执行 owner。Route 可以用独立勾选开关启用或暂停秘书；暂停时保留完整任务绑定，但不再向人格注入秘书槽，也不自动套用秘书模型。Manager 通过 `codexPlanAssistantModel` 为当前 Route 的全部秘书维护一个统一模型，默认 `gpt-5.6-terra`，秘书数组不再各自保存模型；显式指定某一轮模型时仍尊重调用方选择。计划用独立 `secretaryBinding` 保存负责秘书，`taskBinding` 始终只指向业务任务。WebGUI 引导/审批同时投给业务任务和负责秘书；业务任务完成、普通进展和状态变化优先直达秘书，不再默认唤醒主人格。秘书消费结果、更新计划/记忆并续投业务任务；只有需要决策、批准、授权、补充输入、跨计划裁决、完整收尾或安全外发复核时才升级给主人格。秘书及其临时子 Agent不得修改业务文件，实际调查、实现和验证由业务任务完成。代码、配置和契约测试已覆盖，真实 Desktop 多任务纵向验收仍未完成，因此该能力仍为实验状态。
- Codex Desktop 投递按完整 `threadId + workspace` 分片调度：不同任务可以并发进入 Desktop IPC，同一任务的投递保持顺序，避免两个请求同时尝试启动新 turn。Manager 读取或更新单个计划时按计划 ID 直达标准文件，只在兼容旧的非标准文件名时回退到目录扫描；不同秘书不再因为单计划操作重复读取全部计划和全部审批记录。
- 消息组处理为实验能力。Codex Agent 开启 `messageProcessingAgents.codex.enabled` 后，聊天消息默认先写入原始记录和人格会话记录，再按停顿形成可恢复消息组，不提供逐消息端关闭开关；ASR/语音转写和结构化事件仍直接投递。调度按总分排序：群消息引用到某条 Agent 外发消息时，会按消息端、平台消息 ID 和 Route 反查发送会话，并给池内相同完整会话 ID 增加最高单项权重；原消息组、同消息端、同会话和同说话人的熟悉度仍同时计分。`messageProcessingAgents.codex.maxAgents` 可把池限制在 `1–32` 个任务；达到上限后即使任务正在运行也继续复用已有任务，设置为 `1` 时固定使用“协助处理消息1”。降低上限只从 Route 池状态移除超额任务，不删除 Desktop 任务。旧回执没有发送者、没有匹配池内任务或查询失败时，不会阻塞消息，只按其余分数选择。只有 Codex 当前明确为 `idle` 的任务参与普通空闲复用；`notLoaded` 的已有任务会由 Desktop 正常加载并继续使用。Desktop 离线或当前状态无法读取时，消息组保留并重试；未设置上限时，只有 Desktop 在线且所有已登记任务都明确正在运行或已被本次分配占用时才扩容。任务以人格名称稳定命名为“协助处理消息”，多任务时使用从 1 开始的编号，已有旧名称按原任务 ID 改名，不改变 owner。`agents.json` 只保存任务身份和初始化信息，熟悉度恢复线索另存 `routing-affinity.json`，active/idle/notLoaded 始终来自 Codex 当前状态。消息处理轮次使用 `gpt-5.6-luna` / `medium`。交付期间新到的片段会保留为同组补充，不随上一批确认而删除。明确私聊、直接 @ 和直接回复默认需要给对方一个可见回应，即使本轮不建计划或暂不实施，也要说明已经理解的安排、下一步由谁做和继续处理的条件；“不需要计划操作”不能替代“是否需要回复”的判断。普通群消息仍按行动分配、方向纠正、风险和既有承诺选择性回应，避免逐条刷屏。恢复时会重新校验磁盘状态；缺少可推导的运行字段时使用安全默认值，缺少消息身份、会话或内容等必要字段的分组不会进入调度。“消息处理 Agent 模式”“计划协助会话”和“Hook 管理”由处理端能力声明控制，当前只有 Codex 支持；其他 Agent 卡片不显示这些设置，非 Codex 配置也不会保留。自动化测试已覆盖恢复、去重、离线等待、`notLoaded` 复用、并发补充、引用发送会话加权、数量上限和 HTTP 投递；真实群聊/私聊及四类 Agent 联调仍待验收，因此不是已验证能力。
- 启用 Codex 消息处理 Agent 后，Manager 会保存独立的消息发送需求状态，并在 Route 配置页显示消息处理看板。直接 @、直接回复、私聊和计划进展通知属于必须处理项；普通群讨论仍由消息处理 Agent 判断是否参与。看板直接读取同一份 Manager 状态，显示消息组停在哪一步、当前处理任务、转交目标、不回复原因、Outbox 发送回执、失败和超时。消息投递先列出较宽的最近双向消息，再给出当前来源消息，并让完整引用链和最近五分钟内最接近的讨论片段紧跟当前消息；QQ 图片以 Codex Desktop 可读取的本机图片附件发送。处理结果必须逐项记录已经核对的来源消息 ID、引用链 ID 和附件观察；图片不可用时只能重试或转交，不能凭文字猜测后直接回复。回复前还必须读取最新的有界双向消息，并把审核绑定到上下文版本、完整发送会话、目标和正文；群里出现新消息、已有 Agent 回复、需求状态变化或发送内容变化时会失败关闭。主人格或其它 Agent 回复同一来源消息时也不能绕过需求关联。只有 `status=sent`、发送渠道与原消息端一致，且 QQ 等渠道带真实平台标识时才算完成；TTS 成功不能关闭 QQ 发送需求。计划与来源消息通过结构化转交中的 `planId` 关联，之后通过统一计划写入接口产生的状态、当前步骤、下一步、等待事项或步骤进度变化会自动生成通知需求。来源证据和发送前上下文审核已通过相关单元测试和后端构建；看板 WebGUI 本次没有改动，真实平台发送与长时间运行仍待验收。
- 人格 `recentMessageLimits` 对普通消息端分别限制 `0–200` 条，默认 `12`；`0` 只关闭注入。Heartbeat 始终按 `0` 处理。统一账本 `conversation/current.jsonl` 没有条数上限，时间归档位于 `archive/<n>~<m>.jsonl`，自动上下文不读归档。
- 一条 Route 可以保存多个 Agent 端，但已匹配的普通消息只投递给 `primaryAgentAdapter` 指定的主控 Agent；主控是 Codex 时直接 `steer/start` Desktop owner。主控失败时不会自动切换到其他 Agent。Heartbeat 可专门配置忙碌跳过，语音可专门配置热/关键词投递。
- Delivery replay 已实现：真实投递会写 `delivery-replay-ledger.jsonl`，可按 attempt 或消息记录重新进入投递链。
- 人格路由 dry-run / AgentPacket 预览仍是设计中功能，当前 WebGUI 没有无副作用预览 API。

## 处理端

| 处理端 | 状态 | 实际边界 |
| --- | --- | --- |
| Codex | 已验证 | 真实消息只通过 Desktop IPC 投给 Codex/ChatGPT Desktop 任务 owner。有效任务 ID 与工作目录形成稳定绑定；Desktop 改名、索引标题滞后或 goal 完成都不会触发重复创建。任务未加载时用 deeplink 唤醒并重试，失败时不启动备用 Runtime。app-server 只用于空任务元数据 bootstrap。 |
| Copilot CLI | 实验支持 | 调用本机 Copilot CLI，使用独立 session name 和 cwd，记录输出和状态；扫描接口明确提示尚未完成连续同会话端到端烟测。 |
| AstrBot | 实验支持 | 支持 Dashboard 登录验证、项目/会话扫描、RabiRoute 插件部署和 ChatUI 会话投递；扫描接口明确提示仍需真实连续发送验收。 |
| Marvis | 人工接力 | 写 prompt、复制剪贴板并打开/聚焦 Marvis；不能可靠列出、创建或重复注入同一会话。 |

目标 Desktop 任务的命令、文件、网络、权限和工具审批与 RabiRoute 的外部消息 Outbox policy 是两层不同边界。

## Outbox 与明确发送

`POST /api/agent/send` 是唯一 Agent 外发接口，必须提交稳定 `deliveryId`、发送 Agent 的 `sender.agentType + sender.sessionId`、精确 `routeId`、`channel`、渠道专用 `params` 和 `payload`；旧 `/api/agent/replies` 已删除。接口返回 `sent`、`draft`、`blocked` 或 `failed`，完成回执可按 `deliveryId` 查询，也可用渠道与 `sentMessageId` 反查发送会话。

| 输出 | 当前行为 |
| --- | --- |
| QQ / NapCat | 必须明确群/私聊目标；支持 text/image/voice/file；群文件必须通过 `allowedFileRoots`，使用 `upload_group_file`；群聊必须提交 `params.replyToMessageId`，真实 ID 生成引用回复段，空字符串表示明确不引用，省略字段则返回可行动错误。引用消息含图片时还必须按原图顺序提交 `replyImageDescriptions`；发送成功后，每张图片旁保存同名 `.md` 说明和 Agent 会话映射。 |
| WeCom | 必须提供明确 `params.chatId`；使用 SDK 发送，受 adapter policy 限制。 |
| 个人微信 | 仅支持回复已收到消息并保存了 context token 的来源会话；可发送文本，或发送消息端策略允许且位于 `allowedFileRoots` 内的本地文件。不能主动向任意联系人发消息；图片、语音和视频的专用发送类型未实现。 |
| 飞书 | 仅支持文本，回复到原始 `chat_id`；要求应用凭据、事件订阅确认和 adapter 出站 policy。不会回退到通用 Webhook。 |
| FenneNote | 已退役；只为旧 Route 保留 reply/playback 兼容，不作为新输出方案。 |
| RabiLink | 受 Route policy 控制；必须明确设备 ID 或设备类型，非主动发送还需 `sourceMessageId`。主动下行不需要伪造来源任务。 |
| 角色面板 | 直接追加角色 timeline，可带附件描述。 |

计划页已经支持与 `planId/stepId` 关联的审批意见记录，并可通过独立 `plan_feedback` 系统事件通知 Agent；这只服务于 Agent 维护的计划，不会直接推进计划，也不等于通用、持久化的 Outbox Action Queue。`draft` 仍是 Outbox 的结果和审计状态，不应写成已经完成的统一审批中心。

## Manager 与 WebGUI

- Manager 默认在 `http://127.0.0.1:8790/` 提供 RibiWebGUI 和 HTTP API，管理 route 配置、子进程生命周期、扫描、日志和全局设置。
- Manager 把需要读取大量语音历史的查询放进独立工作线程；同时最多执行 2 个、排队最多 8 个、单次上限 30 秒，超过容量或时限会明确返回 503/504，不再让主 HTTP 线程长时间失去响应。带时间范围的语音查询先根据归档索引排除不相交文件，再读取正文；同时到达、查询范围相同且不需要正文的语音统计只执行一次扫描。`GET /meta` 的 `readWorkers` 可查看当前执行数、排队数和上限。
- 完整 Route 诊断只从 JSONL 文件尾部读取有限记录，并在同一次响应中复用相同文件的读取结果。人格冲突历史尚无快照时，接口立即返回 202，随后由独立的单 worker 目录任务限速整理；它最多等待 1 项、单次上限 5 分钟，不占用语音读取名额，也不会用满速目录遍历争抢页面读取。`GET /meta.catalogWorkers` 可查看状态。Manager 同时限制请求头接收为 10 秒、请求接收为 30 秒、Keep-Alive 空闲为 5 秒，并限制单连接最多 100 次请求；这些值可从 `GET /meta.httpLimits` 查看。
- 控制台可显式开启局域网 WebGUI，并在 `data/Config.json.webguiLan` 生成/轮换独立访问密钥。重启后 Manager 从回环监听切换到局域网监听；此时从本机 `localhost/127.0.0.1` 打开的页面会自动重定向到优先局域网 IP，并保留当前 Route 和页面。非本机的 Manager API、SSE 和私有资源请求必须携带 `webgui_token` 或专用请求头，静态登录壳本身不授予读取权限。开关和密钥只能由运行 Manager 的本机通过回环或自己的局域网地址管理，其他设备仍被拒绝；左侧“当前路由”切换会重定向 `#/routes/<Route配置名>/overview` 或 `knowledge`，控制台可复制对应完整链接。
- 已登录 RabiLink Relay 管理后台后，可从 `https://<Relay>/manage/<账号>/<RabiGUID>/` 访问目标 PC 的完整 WebGUI 控制面。普通 API、图片、附件、音频、文件下载和视频 Range 经应用 token 认证的 PC worker 转发；Manager SSE 经独立事件通道实时推送。管理 Cookie、RabiLink 应用 token 与局域网 `webgui_token` 保持三个独立边界。
- WebGUI 当前有：控制台、消息适配器、人格配置、计划与记忆、语音服务、模型管理、日志诊断和使用手册。模型管理是主机级页面，不随当前 Route 切换；快速配置向导可以选择消息入口、处理端和人格。
- WebGUI 首次进入先读取包含完整 Route 配置但不包含日志、消息文件和人格全文的轻量状态；控制台、消息适配器和日志诊断页再按需补取完整运行诊断。人格页只显示最多 420 字的正文摘要，点击“查看完整正文”后进入独立 Markdown 阅读页；两页通过受控的人格文件接口读取当前 `persona.md`，不再把所有人格全文塞进每次 `/gateways` 首屏响应。
- 人格配置页顶部的“多电脑人格同步”按钮会打开独立工作台；选择电脑后先通过只读 preview 显示 Changed Files，再由用户点击“拉取并同步”。可能需要遍历大量历史证据的冲突目录仍只在用户点击“检查冲突”后读取，后续只有已经检查过冲突的页面才随文件事件刷新该列表。
- “身份定位”分成“已识别身份”和“未识别身份”：前者按人汇总已确认的 QQ、微信、声纹及其他消息端账号，后者按 QQ、微信、声纹等消息端分别展示尚未确认属于谁的账号，不按昵称自动合并。已识别人物使用整张卡片作为入口，打开后可在同一个界面维护基本信息、消息端账号、说话习惯和关系；界面不再使用三点下拉，也不把关系分成长短期两类。声纹可显式关联到一个已确认身份，也可从身份详情解除错误关联。语音区域首次进入不扫描最近 24 小时历史；用户点击“刷新归类”或开始“标记下一段”后才读取统计，此后页面打开期间的新录音和关系变化才触发增量刷新。
- “计划与记忆”页按“当前计划 / 近期记忆 / 沉淀记忆 / 已归档”四个标签分开显示内容；当前计划展示未归档计划，近期记忆只包含尚未沉淀的记录，沉淀记忆展示稳定可召回输出，已归档汇总归档计划和带 `consolidatedAt` 的来源记忆。页面先按 Manager 排序读取首批 8 条计划摘要或 24 条记忆；计划首屏会在挂载卡片前并行补齐首两张完整详情，不显示首屏详情加载提示。随后在页面可见期间自动用最多 50 条的分页补齐当前计划分类，并用最多 100 条的分页补齐当前记忆分类，不需要滚动触发；页面显示已加载数量与总数。标签页隐藏时暂停，重新可见后刷新并继续。每页之间只让出一个渲染帧，不等待正文水合。右侧正文从当前目录目标开始挂载有界的向后窗口，计划卡先挂载 8 张、记忆卡先挂载 24 张，后续批次只追加到阅读位置下方，不把更早卡片插回视口上方。目录跳转把目标详情放入最高优先级，在当前 Manager 与局域网环境按 1 秒交互预算验收；其余正文、步骤、审批和附件元数据只对真正接近视口的卡片补充，每轮提升最近 2 张且最多 2 个并发请求，完整内容搜索时才按需补齐全部详情。图片/视频附件继续使用浅色加载与失败占位及低优先级懒加载，避免大知识库阻塞首屏。
- 近期记忆卡片分别显示记录时间与真实命中召回时间，并安全渲染 Markdown 图文内容。Manager 为最早的 72 小时触发点设置一次性任务，到点时固定触发时间和 24 小时候选上限并自动投递；晚执行不会追加后来才跨过边界的记忆。WebGUI 只在距离触发不足 24 小时时显示独立倒计时、最不活跃记忆、候选数量和卡片标记。已完成沉淀的近期来源不会再次进入候选，生成的沉淀记忆仍可继续召回。
- 控制台管理 Rabi 实例名/GUID、全局 RabiLink Relay 连接、route/role 目录和 route 启停。
- 消息适配器页包含 NapCat 多实例管理、Remote Agent 扫描连接、外部适配器诊断、Agent 扫描、主控 Agent 选择和 pipeline/工作目录配置。
- 人格页管理 persona、route variables、规则、route kind、regex、定时计划和模板；没有实现设计稿中的 dry-run 预览。
- 日志页展示连接状态、Codex 投递通道和最近日志，并能执行手动触发。Delivery replay 已有 Manager API 和 ledger，但当前页面没有回放按钮。
- 顶栏支持简体中文 / English 运行时切换。语言状态统一保存在浏览器 `localStorage` 的 `rabiroute:webgui:locale`，并同步 `<html lang>`；它只是 UI 偏好，不写入 route、role 或 Manager 配置。
- 英文界面只翻译登记过的界面文案和动态状态；route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据保留原文。使用手册直接读取 `docs/user-guide/` 中人工维护的中英文 Markdown，不维护第三份页面内容。
- Manager 还提供 Agent thread bridge、Role Knowledge、Remote Agent、多 Rabi 实例、NapCat 管理和 RabiLink 远程 WebGUI HTTP/SSE 代理 API。

## 角色知识与运行数据

- 计划、近期记忆、沉淀记忆、整理 run 和技能索引均有 Manager API 和文件真源；新记忆使用 Markdown，旧 JSON 继续兼容。
- AgentPacket 的 `message_delivery` 与 Codex 的 session、prompt、PreToolUse、PostToolUse 都进入 `RabiContextManager`；生产代码只有这个入口执行角色知识快照。消息入口使用完整上下文，推理期只注入本 turn 新命中的增量。
- Codex 处理端已有 Hook 管理：会话入口上下文在 `SessionStart` / `UserPromptSubmit` 触发，推理期上下文刷新在 `PreToolUse` / `PostToolUse` 触发，计划任务会话完成通知在计划绑定任务输出最终回答后的 `Stop` 触发；Route 还可开启“强制使用 RabiAgent 消息投递接口”，在 `PreToolUse` 拒绝主人格、计划 Agent、计划秘书和消息处理 Agent 绕过 Rabi 操作其它持久任务。四组默认开启，开关只控制 Manager 响应，不改插件注册。
- Agent 必回复请求为实验能力。Agent 互投必须明确 `responsePolicy=required|none`；必回复请求由 Manager 持久化，正式回复必须带 `requestId`、结果和下一步。目标轮次结束仍未正式回复时，Manager 从该轮结束起五分钟后提醒；消息处理转交的正式回复会把原发布任务恢复为继续处理。请求状态机、接口、Hook 拒绝/Stop 处理、插件输出和 WebGUI 构建已通过自动化测试，真实 Desktop 多任务下的持续五分钟提醒仍待纵向验收。
- 实验性的计划会话任务完成提醒已实现：计划用 `taskBinding` 精确绑定 Codex 执行会话，省略 `completionHook` 时默认开启，也可用 `completionHook.enabled=false` 单独关闭。`Stop` Hook 把官方最终回答交给 Manager，再经角色面板 / Forwarding / AgentPacket 提醒同人格 Route 的主人格会话。路由层按 session + turn 去重且不自行修改计划；提醒合同要求主人格在同一轮读取计划、更新计划和记忆、向原 `taskBinding.sessionId + workspace` 续投，或在完成/暂停时释放并重新分配槽位，结束前校验没有可推进但空闲的计划。冲突失败关闭；目前只有代码、HTTP、插件和 mock RolePanel 链测试，尚未完成双真实 Desktop 任务验收。
- 命中记忆会按统一策略刷新 `viewedAt`；同一 turn 的相同条目修订不会重复刷新。只有显式 `memory-consolidation` 手动触发或 Manager API request 才会创建整理 run，提交结果后才标记输入并写入沉淀记忆；当前没有仅凭时间流逝自动启动的后台整理调度器。Codex Route 可把手动触发投给独立“`<主人格任务名> 记忆整理`”Desktop 任务，默认模型 `gpt-5.6-terra`，失败不回退给主人格。
- Codex 插件只转发 lifecycle 事件和注入 Manager 返回值，不拥有绑定、触发策略或知识副本。内部 `preview` 策略无副作用，但当前仍没有 WebGUI 预览界面。
- 运行记录以 JSONL 为主，包括消息、适配器日志、AgentPacket、Outbox、heartbeat、manual trigger、role panel、RabiLink conversation、按角色的 wearable health 时间线和 delivery replay。
- 运行期 `data/`、日志、token、真实账号、真实群号和 Cookie 不应进入仓库。
- 多电脑人格同步为实验支持：同一 RabiLink 应用 token 下的 PC 可查询 peers，优先经专用局域网数据面直连，失败后经 Relay 受限中转；JSONL 做集合合并，普通文件按共同基线快进，已知基线上的单边删除可传播，删除/编辑并发或双方修改的冲突保存在 `data/persona-sync/conflicts/`。同一人格、路径、peer、远端哈希、删除状态和基线哈希使用固定证据哈希直接定位，不再为自动去重同步遍历旧冲突目录；历史副本只在用户明确检查冲突时异步归组。可重建 manifest 索引只做一次启动校准，之后由文件事件重算变化路径；事件不可用时才在查询前做一次校准。`PersonaSyncAutoReconciler` 把本机文件变化、peer 上下线和 Relay `ready` 作为唤醒信号，持久保存待对账范围并执行一次 manifest 补漏；目标离线时等待事件，在线临时失败只做有界退避，不运行固定业务轮询。本机 Agent 或人格页可查看远端证据并选择保留本地、采用远端/删除或提交合并内容；处理过程校验本地哈希并保留解决审计，随后仅在两端仍匹配证据时把结果即时发布回来源 peer。冲突控制、索引和自动状态诊断不经 LAN/Relay 暴露。语音消息端账号的兼容归类事件带 `supersedes` 分支关系，多 PC 并发判断会保留冲突头并由人格后续 PUT 显式收敛；同步响应立即返回 `semanticConflicts`。`scripts/test-rabi-persona-sync.mjs` 仍可在两台实体 PC 上执行一次显式同步并留下脱敏 JSON 证据。

## 不应宣传为当前完成的能力

- 通用 Action Queue / 审批中心和失败自动补发队列。
- 人格路由、RouteDecision 和 AgentPacket 的无副作用 WebGUI 预览。
- Marvis 的可靠后台会话注入。
- 所有 RabiLink 手机、眼镜、手表和小米健康路线的真机生产闭环；仓库包含实现、探针、验收材料和设计稿，但成熟度不等同于核心路由能力。
- 设计/研究/交接文档中的未来 API、UI 和硬件路线，除非代码、配置入口和测试已经存在。

## 事实源

- 配置与类型：`src/shared/gatewayConfigModel.ts`
- Gateway 运行入口：`src/index.ts`
- Manager API：`src/manager/controlPlaneRoutes.ts`
- 消息端成熟度扫描：`src/messageEndpoints/*`、`src/manager/controlPlaneRoutes.ts`
- Agent 成熟度扫描：`src/agentAdapters/managerApi.ts`
- 路由与上下文：`src/forwarding.ts`、`src/routing/*`
- 回传：`src/outbox.ts`
- Codex Desktop owner：`src/codexDesktopBridge.ts`、`src/codexRuntime.ts`；空任务元数据：`src/codexAppServerClient.ts`
- WebGUI：`ribiwebgui/src/pages/*`
- 自动化契约：`src/**/*.test.ts`
