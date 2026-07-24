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
| NapCat / OneBot | 已验证 | Gateway 子进程通过 WebSocket 接收 QQ 群聊和私聊；Manager 可扫描、添加、启动、重启、移除和修复多个 NapCat 实例；OneBot HTTP 用于状态查询和外发；合并转发消息会展开为文本/媒体证据。 |
| Heartbeat | 已验证 | Gateway 子进程产生内部定时事件；规则支持间隔、时间窗口、每天指定时间和单次指定时间；可选在固定 Codex 线程忙碌时跳过。 |
| 角色面板 | 已验证 | Manager/托盘提供的内置本地入口，不是独立网络 listener；使用固定 `role_panel_message` 规则，记录写入角色目录的 timeline。 |
| Manual trigger | 已验证 | Manager API 和日志诊断页可真实触发 `manual_trigger` 或 heartbeat 规则；它不是消息适配器。 |
| Remote Agent | 实验支持 | Manager 作为 v3 出站控制端扫描并连接远端 bridge，使用密码挑战握手，支持任务、事件和双向文件；Gateway 子进程只显示占位状态，不另开 listener。 |
| RabiSpeech 语音消息端 | 实验支持 | RabiSpeech 只维护一份 ASR/VAD、声纹处理和 FIFO。Android 手机/眼镜与独立语音客户端一样只持续传 PCM，不切句、不跑模型；PC 对手机流完成处理后只投 `rabilink` Route，本机/普通远程声卡只投 `speech` Route。每段转写先写一次主机级语音消息库，各绑定人格再分别写自己的原始记录和会话上下文。主机只保存不透明声纹/聚类证据，不判断声纹是谁或谁是“用户”；手机回复默认回原设备。正式自动声纹只接受显式确认的真人私有数据集及完整哈希门禁报告，合成 TTS/旧报告始终只作预检。 |
| FenneNote | 已退役兼容 | 不再出现在新增消息端或新规则 UI；只读取旧 Route，并保留历史 webhook/Outbox 兼容以便迁移。 |
| 小米音箱 / 小爱 | 实验支持 | RabiRoute 提供命名回调入口和 PC 侧桥接目录，但必须依赖 open-xiaoai、xiaogpt 或自定义桥把音箱事件送到 PC；不是音箱直连核心。 |
| RabiLink | 实验支持 | 同时存在本地兼容入口、全局 Relay Runtime 和 Route worker；Android 手机/眼镜通过 Relay SSE 收到队列事件后按 cursor 单次补漏，音频只传 PCM，PC 完成 ASR 后进入主机通用语音库和选定 RabiLink Route；主动消息与回复走独立 Relay 下行队列。明确目标下行在 `delivered` 前不按 TTL 删除，手机持久补传 `delivered/played/playback_failed`，而 `played` 只能由手机/眼镜各自 AudioTrack marker 产生。Rokid AIUI AIX 的宿主只提供整包 HTTP、没有 SSE/WS/分块回调，为保证前台主动消息功能保留 25 秒长等待这一受控例外。代码回执闭环已完成，手机/眼镜实际扬声器和穿戴设备仍需真机验收。 |
| 智能手表 / 手环健康消息端 | 实验支持 | `wearable.health` 结构化观测进入按角色分日的健康时间线；Manager 可查询当前状态、历史和摘要，阈值/冷却命中后以 `wearable_health_alert` 投递 Agent。Android 可选 Health Connect 或 PC ADB Companion；Health Connect 优先事件触发，小米 ADB Provider 因没有可靠变更通知，在用户显式启用 Companion 后保留分钟级低频轮询。小米真机已闭环心率、睡眠会话、阶段、睡/醒状态、去重和查询；无需 ADB 的 MiWear SPP 直连仍未作为默认采集器。 |
| 通用 Webhook | 实验支持 | 接收没有专用适配器的外部 POST；已有命名平台应使用自己的适配器，以保留日志和回传语义。 |
| 企业微信 / WeCom | 实验支持 | 使用 `@wecom/aibot-node-sdk` 的智能机器人 WebSocket 长连接，支持群消息进入和 Outbox 回发；需要真实 Bot ID/Secret 验证。 |

`disabled` 只是兼容配置值，不是一个消息入口。

## 路由与上下文

- 一条 route 可以配置多个消息适配器、每适配器输入/输出 policy、多个 Agent adapter、pipeline、工作目录和人格绑定。
- 路由规则保存在人格根级 `personaConfig.json` 中；多条 Route 绑定同一人格时复用同一套规则、语音关键词和上下文额度。无人格 route 会生成默认规则；角色面板规则始终存在。
- 当前 route kind：`private`、`group_message`、`direct_at`、`direct_reply`、`indirect_reply`、`heartbeat`、`manual_trigger`、`role_panel_message`、`voice_transcript`、`rabilink`、`wearable_health_alert`、`wecom_message`。
- `RouteDecision` 只负责规则匹配；`forwarding.ts` 遍历 active route profile、写审计并投递每一条命中规则。
- `AgentPacket` 会注入事件、当前人格/逻辑消息端/会话的最近双向消息、角色与相对路径、计划/记忆/技能索引、必要读取项、日志路径、回复 API 和 `replyContext`。
- 人格 `recentMessageLimits` 对 11 个消息端分别限制 `0–200` 条，默认 `100`；`0` 只关闭注入。统一账本 `conversation/current.jsonl` 没有条数上限，时间归档位于 `archive/<n>~<m>.jsonl`，自动上下文不读归档。
- 已匹配的普通消息直接 `steer/start` Desktop owner；Heartbeat 可专门配置忙碌跳过，语音可专门配置热/关键词投递。
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

## Outbox 与回复

`POST /api/agent/replies` 已实现，返回状态为 `sent`、`draft`、`blocked` 或 `failed`。

| 输出 | 当前行为 |
| --- | --- |
| Agent 本地会话 | 默认 legacy pipeline 使用 `outputAdapter=agent`；没有明确外部目标时，回复保留在 Agent 会话，不创建草稿。 |
| QQ / NapCat | 支持来源回复和明确群/私聊目标；支持 text/image/voice/file；群文件必须通过 `allowedFileRoots`，使用 `upload_group_file`；可生成真实引用回复段。 |
| WeCom | 支持来源群聊回复和明确 chat/group 目标；使用 SDK 发送，受 adapter policy 限制。 |
| FenneNote | 已退役；只为旧 Route 保留 reply/playback 兼容，不作为新输出方案。 |
| RabiLink | 受 route policy 控制，回复或主动文本进入连续 Relay 消息流；主动下行不需要伪造一个来源任务。 |
| 角色面板 | 直接追加角色 timeline，可带附件描述。 |

计划页已经支持与 `planId/stepId` 关联的审批意见记录，并可通过现有角色面板链通知 Agent；这只服务于 Agent 维护的计划，不会直接推进计划，也不等于通用、持久化的 Outbox Action Queue。`draft` 仍是 Outbox 的结果和审计状态，不应写成已经完成的统一审批中心。

## Manager 与 WebGUI

- Manager 默认在 `http://127.0.0.1:8790/` 提供 RibiWebGUI 和 HTTP API，管理 route 配置、子进程生命周期、扫描、日志和全局设置。
- WebGUI 当前有：控制台、消息适配器、Rabi 人格、计划与记忆、日志诊断、使用手册六类页面；快速配置向导可以选择消息入口、处理端和人格。
- 控制台管理 Rabi 实例名/GUID、全局 RabiLink Relay 连接、route/role 目录和 route 启停。
- 消息适配器页包含 NapCat 多实例管理、Remote Agent 扫描连接、外部适配器诊断、Agent 扫描和 pipeline/工作目录配置。
- 人格页管理 persona、route variables、规则、route kind、regex、定时计划和模板；没有实现设计稿中的 dry-run 预览。
- 日志页展示连接状态、Codex 投递通道和最近日志，并能执行手动触发。Delivery replay 已有 Manager API 和 ledger，但当前页面没有回放按钮。
- 顶栏支持简体中文 / English 运行时切换。语言状态统一保存在浏览器 `localStorage` 的 `rabiroute:webgui:locale`，并同步 `<html lang>`；它只是 UI 偏好，不写入 route、role 或 Manager 配置。
- 英文界面只翻译登记过的界面文案和动态状态；route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据保留原文。使用手册直接读取 `docs/user-guide/` 中人工维护的中英文 Markdown，不维护第三份页面内容。
- Manager 还提供 Agent thread bridge、Role Knowledge、Remote Agent、多 Rabi 实例、NapCat 管理和 RabiLink 远程 WebGUI 代理 API。

## 角色知识与运行数据

- 计划、近期记忆、沉淀记忆、整理 run 和技能索引均有 Manager API 和文件真源。
- AgentPacket 的 `message_delivery` 与 Codex 的 session、prompt、PreToolUse、PostToolUse 都进入 `RabiContextManager`；生产代码只有这个入口执行角色知识快照。消息入口使用完整上下文，推理期只注入本 turn 新命中的增量。
- Codex 处理端已有 Hook 管理：会话入口上下文在 `SessionStart` / `UserPromptSubmit` 触发，推理期上下文刷新在 `PreToolUse` / `PostToolUse` 触发，计划任务会话完成通知在计划绑定任务输出最终回答后的 `Stop` 触发；三组默认开启，开关只控制 Manager 响应，不改插件注册。
- 实验性的计划会话任务完成提醒已实现：计划用 `taskBinding` 精确绑定 Codex 执行会话，省略 `completionHook` 时默认开启，也可用 `completionHook.enabled=false` 单独关闭。`Stop` Hook 把官方最终回答交给 Manager，再经角色面板 / Forwarding / AgentPacket 提醒同人格 Route 的目标会话。它按 session + turn 去重，不自动推进计划，冲突失败关闭；目前只有代码、HTTP、插件和 mock RolePanel 链测试，尚未完成双真实 Desktop 任务验收。
- 命中记忆会按统一策略刷新 `viewedAt`；同一 turn 的相同条目修订不会重复刷新。只有显式 `memory-consolidation` 手动触发或 Manager API request 才会创建整理 run，提交结果后才标记输入并写入沉淀记忆；当前没有仅凭时间流逝自动启动的后台整理调度器。
- Codex 插件只转发 lifecycle 事件和注入 Manager 返回值，不拥有绑定、触发策略或知识副本。内部 `preview` 策略无副作用，但当前仍没有 WebGUI 预览界面。
- 运行记录以 JSONL 为主，包括消息、适配器日志、AgentPacket、Outbox、heartbeat、manual trigger、role panel、RabiLink conversation、按角色的 wearable health 时间线和 delivery replay。
- 运行期 `data/`、日志、token、真实账号、真实群号和 Cookie 不应进入仓库。
- 多电脑人格同步为实验支持：同一 RabiLink 应用 token 下的 PC 可查询 peers，优先经专用局域网数据面直连，失败后经 Relay 受限中转；JSONL 做集合合并，普通文件按共同基线快进，已知基线上的单边删除可传播，删除/编辑并发或双方修改的冲突保存在 `data/persona-sync/conflicts/`。可重建 manifest 索引只做一次启动校准，之后由文件事件重算变化路径；事件不可用时才在查询前做一次校准。`PersonaSyncAutoReconciler` 把本机文件变化、peer 上下线和 Relay `ready` 作为唤醒信号，持久保存待对账范围并执行一次 manifest 补漏；目标离线时等待事件，在线临时失败只做有界退避，不运行固定业务轮询。本机 Agent 或人格页可查看远端证据并选择保留本地、采用远端/删除或提交合并内容；处理过程校验本地哈希并保留解决审计，随后仅在两端仍匹配证据时把结果即时发布回来源 peer。冲突控制、索引和自动状态诊断不经 LAN/Relay 暴露。人格声纹关系事件带 `supersedes` 分支关系，多 PC 并发判断会保留冲突头并由人格后续 PUT 显式收敛；同步响应立即返回 `semanticConflicts`。`scripts/test-rabi-persona-sync.mjs` 仍可在两台实体 PC 上执行一次显式同步并留下脱敏 JSON 证据。

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
