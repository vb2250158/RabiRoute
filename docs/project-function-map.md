<!-- docs-language-switch -->
<div align="center">
<a href="./project-function-map_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 项目功能手册

> 状态：当前事实地图。模块和成熟度已按当前代码复核；涉及外部系统的真实环境验收仍以 [当前能力与成熟度](current-capabilities.md) 为准。

本文是 RabiRoute 的通用项目功能手册。它面向产品设计、GUI 改造、代码维护、排障和新 Agent 交接，不只服务某一个页面或某一次需求。

RibiWebGUI 的 `/#/docs` 现在是面向软件使用者的“使用手册”，直接展示 `docs/user-guide/` 的双语 Markdown。本文属于开发者事实地图，通过使用手册的深入资料链接或仓库文档索引进入。

## 使用方式

- 想知道某个能力归谁管：先看“功能索引”。
- 想设计新 UI：先看“边界规则”和对应功能的“真源 / 消费点 / 生效时机 / 副作用”。
- 想改代码：先看“分层地图”和“常见修改入口”。
- 想排障：先看“运行数据与日志”。
- 想确认功能是不是已有：先查[当前能力与成熟度](current-capabilities.md)，再用本文定位入口和代码 owner。

## 一句话定位

RabiRoute 是消息网关、消息分诊台和策略调度层。它负责消息进入、事件记录、路由判断、上下文包装、处理端投递、回传审批和状态观测；处理端负责真正回答、执行、调用工具和维护自己的会话。

```text
Message Adapter
  -> Event Store
  -> RouteDecision
  -> AgentPacket
  -> Agent Adapter
  -> Outbox / Reply
```

Codex 集成按五层理解：OpenAI 是 provider，Codex 是 agent/runtime，Desktop IPC 是 transport，Codex/ChatGPT Desktop 是必需的 task owner，具体 GPT 版本是目标任务的 model。功能地图中的 `codex` 始终指 adapter id 和 Codex runtime，不指桌面应用或模型名。

## 分层地图

| 层 | 负责 | 不负责 | 关键代码 |
| --- | --- | --- | --- |
| Message Adapter | 接入 QQ、Webhook、眼镜端、WeCom、heartbeat、role panel 等入口，把外部事件转成内部 record | 拼 Agent prompt、决定处理端如何回答；RabiLink 是系统转接服务，不属于消息端 | `src/adapters/*` |
| Event Store | 写原始入口/投递审计 JSONL，以及人格级统一双向会话账本 | 做业务判断、替代数据库事务、用归档代替自动上下文 | `src/history.ts`、`src/messageContextStore.ts`、`src/deliveryReplayLedger.ts` |
| RouteDecision | 在单个 route profile 内判断规则是否命中 | 选择人格、读取记忆、投递 Agent | `src/routing/routeDecision.ts` |
| Forwarding | 遍历 active routeProfiles，写日志，构造 packet，调用 Route 选定的主控 Agent adapter | 平台协议细节、UI 表单逻辑、失败后自动改投其他 Agent | `src/forwarding.ts` |
| AgentPacket | 生成处理端最终收到的消息、replyContext、上下文和接口说明 | 决定 route 是否命中、替代 Agent 读取计划/任务或自动完成业务状态回写、外发消息 | `src/routing/agentPacket.ts` |
| Agent Adapter | 把 AgentPacket 投给 Codex、Copilot、AstrBot、Marvis 等处理端 | 定义路由语义、直接写外部平台、依赖桌面宿主 | `src/agentAdapters/*`、`src/codexRuntime.ts`、`src/codexAppServerClient.ts`、`src/copilotCli.ts`、`src/marvis.ts` |
| Outbox / Send | 接收带发送 Agent 类型与会话 ID 的明确请求，校验 Route、渠道、目标参数、内容和策略后发送并保存追溯回执 | 让处理端绕过 RabiRoute 写平台，或从来源上下文猜测目标 | `src/agentSend.ts`、`src/outbox.ts` |
| 消息处理看板 | 保存消息发送需求、处理阶段、转交、决定和 Outbox 回执；把计划进展重新通知来源会话 | 代替 Agent 回答、从日志猜测状态、把普通群消息全部设为必须回复 | `src/messageProcessing/board.ts`、`src/messageProcessing/persistence.ts`、`src/manager/controlPlaneRoutes.ts`、`ribiwebgui/src/components/MessageProcessingBoard.vue` |
| Manager 控制面 | 管配置、进程、扫描、状态、WebGUI 静态资源和 HTTP API | 具体平台实时消息处理 | `src/manager/*`、`src/manager.ts` |
| WebGUI | 展示和编辑配置、状态、日志和人格规则 | 成为配置唯一真源 | `ribiwebgui/src/*` |
| Role Knowledge | 管角色计划、记忆、技能和上下文快照；Manager 展示层统一派生状态和排序，并按精确绑定读取任务 Agent 状态 | 决定消息是否路由命中，或根据计划生命周期猜测 Codex 是否工作 | `src/roleKnowledge.ts`、`src/roleKnowledgePresentation.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/planAgentStatus.ts`、`src/manager/controlPlaneRoutes.ts` |

## 功能索引

| 功能 | 当前状态 | 真源 / 数据 | 消费点 | 生效时机 | 副作用 | 入口 | 关键代码 | 文档 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| route 配置 | 已有 | `data/route/<configName>/adapterConfig.json` | manager 启动 gateway、`config.ts` 环境变量 | 保存配置并重启 / 同步 runtime 后 | 写配置文件，可能启停子进程 | WebGUI 路由页、`POST /gateways` | `src/manager/configRepository.ts`、`src/shared/gatewayConfigModel.ts` | `docs/routing-configuration.md` |
| 人格绑定 | 已有，route 固定绑定 | `adapterConfig.json.agentRoleId`、`agentRoleFile` | `rolePathsForRoute(route)`、AgentPacket | 下一次 gateway 配置生效后 | 影响 AgentPacket 的人格路径和角色数据目录 | WebGUI 人格页 / 路由页 | `src/config.ts`、`src/shared/routePaths.ts` | `docs/routing-and-personas.md` |
| 人格目录与跨人格消息 | 自动化合同已验证；待真实双人格 Desktop 验收 | 共享人格目录、Manager 运行时注册表、Route + 人格绑定凭据、持久投递回执 | Agent 查询可联系人格；POST 经统一角色面板服务投递，先由处理端接收再记成功；同 `deliveryId` 不重复执行 | 查询时读取；POST 时真实投递 | 目标 timeline 记录发送人格和 Route；失败只记尝试，不报告已送达 | `GET /api/personas`、`GET /api/personas/:personaId`、`POST /api/personas/:personaId/messages`、`GET /api/personas/messages/receipts/:deliveryId` | `src/manager/personaCatalog.ts`、`personaMessageAuthority.ts`、`personaMessagingRoutes.ts`、`rolePanelDelivery.ts` | `docs/rabi-agent-interfaces.md` |
| 人格正文 | 已有 | `data/roles/<RoleId>/persona.md` | AgentPacket 注入人格路径，WebGUI 预览 | 下一次投递或页面刷新 | 无直接外发 | WebGUI 人格页、打开文件 | `src/routing/agentPacket.ts`、`ribiwebgui/src/pages/PersonaTemplatePage.vue` | `docs/routing-and-personas.md` |
| 人格头像 | 已有 | `personaConfig.json.avatar` 指向人格目录内 PNG/JPEG/WebP/GIF | Manager 读取并通过受限图片 API 提供给 WebGUI；Qt 从既有 RoleContext 仓库读取同一配置事实 | 上传、移除或页面刷新后 | 内容寻址写入新图片并原子切换配置，成功后清理旧托管头像；不改变 Agent 语义 | 人格页、快速配置、Route 总览、语音页、角色面板 | `src/personaAvatar.ts`、`src/manager/personaAvatarRoutes.ts`、`ribiwebgui/src/components/PersonaAvatar.vue` | `docs/routing-and-personas.md` |
| 人格自动化 | 已有；定时器由 Heartbeat Fiber 管理 | `data/roles/<RoleId>/personaConfig.json.automationRules`；旧 `notificationRules` 兼容迁移 | 消息触发复用 `RouteDecision`；定时触发由 heartbeat adapter 唤醒；动作通知 Agent 或进入受限脚本执行器 | 下一条命中消息或指定时间 | 可能投递 Agent，或在 Route 本机授权后运行人格 `scripts/` 文件；Fiber 卸载会清除未来定时器并写 `disabled`，已经开始的动作继续完成 | WebGUI 人格页“收到消息时 / 定时任务”动态编辑器 | `src/automation/personaAutomationRuntime.ts`、`src/adapters/heartbeatAdapter.ts`、`src/runtime/messageAdapterRuntime.ts`、`src/forwarding.ts`、`src/manager/configRepository.ts` | `docs/user-guide/personas-and-rules.md` |
| 分消息端最近上下文 | 已有 | `personaConfig.json.recentMessageLimits` | AgentPacket 读取当前人格、逻辑消息端和会话的双向记录；Heartbeat 在读取账本前短路 | 下一次 AgentPacket 构造 | 普通消息端分别限制 `0–200`，默认 `12`；`0` 只关自动注入，不停止记录；Heartbeat 固定为 `0` | WebGUI 人格页滑条 + 精确数字输入（不展示 Heartbeat） | `src/shared/gatewayConfigModel.ts`、`src/routing/agentPacket.ts` | `docs/agent-context-injection.md` |
| 人格级统一双向会话账本 | 已有 | `data/roles/<RoleId>/conversation/current.jsonl` | AgentPacket 自动上下文、Agent 显式查证 | 入站记录、成功 Outbox/处理端回传时 | 双向合计占额度；附件只保存安全元数据；归档为 `archive/<n>~<m>.jsonl` + `index.json` | 人格页与 AgentPacket 路径 | `src/messageContextStore.ts`、`src/messageContext.ts` | `docs/agent-context-injection.md` |
| ASR 热投递 / 关键词唤醒 | 已有 | Route `adapterConfig.json.speechPushMode`；人格 `personaConfig.json.speechTriggerKeywords` | RabiPC 语音消息端 | 每段 ASR 转写完成后 | `hot` 每段立即投递；`keyword` 始终先记录，只在命中人格名/唤醒词时投递；空关键词永不回退热投递 | Route 页“热投递”开关；人格页关键词 | `src/routing/speechPushPolicy.ts`、`src/index.ts` | `docs/rabispeech-plugin.md` |
| 配置归一化 | 已有 | `GatewayDefinition`、`RouteProfileDefinition` | manager 读写配置、WebGUI 保存 | 读写配置时 | 可能自动补默认值、分配端口 | manager API | `src/shared/gatewayConfigModel.ts` | `docs/code-architecture.md` |
| Manager 控制面 | 已有 | `data/manager.json`、runtime registry | WebGUI、远端 API、子进程管理 | manager 启动和 API 调用时 | 启停子进程、写配置 | `npm run manager`、`src/manager.ts` | `src/manager/controlPlaneRoutes.ts`、`src/manager/runtimeRegistry.ts` | `docs/windows-launcher-and-packaging.md` |
| WebGUI | 已有 | manager HTTP API | 用户配置和排障 | 页面加载 / 用户操作时 | 调用 manager API，可能写配置或触发动作 | `ribiwebgui` | `ribiwebgui/src/router.ts`、`ribiwebgui/src/stores/gatewayStore.ts` | `docs/code-architecture.md` |
| WebGUI 局域网访问 | 已有，默认关闭 | `data/Config.json.webguiLan` | Manager HTTP 门禁、WebGUI fetch/SSE/私有资源适配、Route 作用域导航 | 本机启用并重启 Manager 后 | 监听从回环切换到局域网；本机回环 URL 自动重定向到优先局域网 IP 并保留当前 Route/页面；非本机控制面请求必须带访问密钥，轮换立即使旧链接失效；左侧当前 Route 切换会保留页面类型并重定向 `#/routes/<Route配置名>/overview|adapters|persona|knowledge|speech|runtime` | 控制台“局域网访问 WebGUI”、复制 Route 控制台/知识库链接、`GET/PATCH /api/webgui-access` | `src/manager/webguiLanAccess.ts`、`src/manager/controlPlaneRoutes.ts`、`ribiwebgui/src/managerApi.ts`、`ribiwebgui/src/webguiLanRedirect.ts`、`ribiwebgui/src/routeScopedNavigation.ts`、`ribiwebgui/src/App.vue`、`ribiwebgui/src/pages/OverviewPage.vue` | `docs/user-guide/interface-and-status.md` |
| WebGUI 中英切换与使用手册 | 已有 | 浏览器 `rabiroute:webgui:locale`、人工词库、`docs/user-guide/*.md` | 导航、表单、状态、诊断和用户手册 | 用户切换语言或页面重渲染时 | 只改变界面展示和 `<html lang>`，不写项目配置 | 顶栏 `中 / EN`、`/#/docs` | `ribiwebgui/src/i18n/*`、`LocaleSwitcher.vue`、`ProjectDocsPage.vue` | `docs/user-guide/README.md` |
| QQ / NapCat 消息端 | 已验证，含一键恢复与账号唯一归属保护 | NapCat WS / HTTP、route config、`group-messages.jsonl`、`private-messages.jsonl` | forwarding、Outbox QQ 发送 | 收到 QQ 事件时；或用户点击“打开 NapCat”时 | 写消息日志，可能投递 Agent；合并转发通过 `get_forward_msg` 展开；Outbox 在 `replyToSource=true` 时生成真实 QQ 引用回复；明确点击后先用 OneBot 探测同 QQ 的在线实例，保留现有会话并拒绝重复启动，再按需请求有效 quick login、修复 OneBot 配置并打开已鉴权 WebUI；过期身份、验证码和设备验证交由用户完成 | route 消息端、路由页“打开 NapCat”、NapCat 管理 API | `src/adapters/napcatAdapter.ts`、`src/napcat.ts`、`src/napcatForwardMessages.ts`、`src/messageEndpoints/napcatManager.ts` | `docs/napcat-unattended.md` |
| QQ route kind 判断 | 已有 | OneBot event、回复链日志 | `forwardMessage(routeKind, record)` | 收到群消息时 | 影响规则匹配 | NapCat adapter | `src/adapters/napcatAdapter.ts` | `docs/routing-and-personas.md` |
| Webhook / XiaoAi / FenneNote 旧兼容 | 实验支持 / 退役兼容；通用 Webhook 已迁移 Fiber 生命周期 | HTTP payload、`voice-transcripts.jsonl` | forwarding、设备回调、可选 RabiLink record-first 观察 | HTTP callback 到达时 | 写转写日志；通用 Webhook 启动等待 listener 就绪，失败回滚，Fiber 卸载关闭端口并写 `disabled`；FenneNote 不再提供新增 UI，只在旧 Route 存在时兼容 | webhook 端口 / 路径、Route 变量 | `src/adapters/webhookAdapter.ts`、`src/runtime/messageAdapterRuntime.ts`、`src/rabilinkObservationRecorder.ts`、`src/messageEndpoints/webhookLikeScans.ts` | `docs/voice-interaction-workstation.md` |
| 眼镜端（经 RabiLink） | 实验支持，内部兼容键 `rabilink` | 眼镜 observation、`rabilink-voice-transcripts.jsonl`、`rabilink-replies.jsonl` | forwarding、眼镜下行回复 | 眼镜消息到达；或本地调试 POST `/rabilink` | 写兼容消息 / 回复日志，按 route 规则决定是否投递 Agent | route 消息端“眼镜端（经 RabiLink）”、`/rabilink`、`/rabilink/replies` | `src/adapters/rabilinkAdapter.ts`、`src/adapters/rabilinkReplies.ts`、`src/adapters/rabilinkRelayWorker.ts` | `docs/rabilink-relay-server.md` |
| 智能手表 / 手环健康消息端 | 实验支持，内部键 `wearable` | Relay `wearable.health` observation、Health Connect 或受信 ADB bridge | 角色健康时间线、Manager health API、`wearable_health_alert` | 手机/桥上报真实样本时；Agent 查询时 | 健康样本去重并分日落盘；普通样本不唤醒 Agent，规则命中才投递；秘钥字段被丢弃 | route 消息端、`/api/roles/:roleId/health/*` | `src/adapters/wearableAdapter.ts`、`src/wearableHealth.ts`、`src/manager/wearableHealthRoute.ts` | `docs/rabilink-wearable-health.md` |
| RabiLink 系统转接服务 | 实验支持（内部契约已测试） | 全局开关、Relay URL / 应用 token / device id、远程 WebGUI HTTP/SSE / 语音 / observation 队列、下行设备回执 | Manager 常驻 SSE、远程 WebGUI、语音 API、眼镜端和后续系统扩展 | Manager 启动且全局开关开启后订阅 `/api/rabilink/events`；队列变化推送 available 事件；另订阅本机 Manager `/api/events` 并逐事件推送远程页面；移动端按 cursor 单次查询补漏 | Manager 登记 PC 并只在事件到达时即时领取；远程 API/附件/下载经受限请求队列，媒体保留 Range/206；WebGUI 事件按账号应用和 PC 定向发布；明确目标下行在 `delivered` 前不按 TTL 清理；持久化 `delivered/played/playback_failed` 并发布 `outbox_receipt`，但不猜测播放；cursor 本身不决定 route，也不拥有 Agent | `data/Config.json` 全局 RabiLink 配置、控制台 Rabi 实例、Relay scripts | `src/manager/rabiLinkRelayRuntime.ts`、`scripts/rabilink-event-hub.mjs`、`scripts/rabilink-relay-server.mjs` | `docs/rabilink-relay-server.md` |
| 多电脑人格同步 | 实验支持 | 本地人格目录、可重建持久化 manifest 索引、持久待对账范围、同应用 peer 清单、每 peer 共同哈希、归档、未解决与已解决冲突证据 | Manager 启动一次性校准后由文件事件维护索引；`PersonaSyncAutoReconciler` 在文件变化、peer 上下线和 Relay 重连时执行一次 manifest 补漏，LAN 直连优先、Relay 受限中转兜底；人格页和 Agent/API 可显式同步及处理冲突；完整 Manager/WebGUI 和诊断/冲突控制不因 P2P 暴露 | 人格文件事件只增量更新索引并标记对应人格待对账；Relay `ready`/peer 事件补查全量；人工 `/api/persona-sync/sync` 可立即运行；路由消息明确要求 Agent 处理同步时才注入 API 合同 | 待对账范围写 `data/persona-sync/auto-sync-state.json`，断网/重启不遗失；目标离线等待事件，在线故障有界退避，不固定轮询；JSONL 并集合并，普通文件按共同版本快进，删除/编辑并发保留冲突证据；WebGUI 支持发现、当前人格同步、证据预览、`keep_local/use_remote`，`use_merged` 仍归 Agent/API；声纹语义冲突回人格归类显式收敛；`npm run check:persona-sync:dual-node` 使用真实 Relay 和 LAN listener 验收 | `/api/persona-sync/*`、`/api/rabilink/peers`、`/api/rabilink/persona-sync/proxy` | `src/personaSync.ts`、`src/personaSyncManifestIndex.ts`、`src/personaSyncCoordinator.ts`、`src/personaSyncAutoReconciler.ts`、`src/manager/personaSyncRoutes.ts`、`src/manager/personaSyncLanServer.ts`、`ribiwebgui/src/components/PersonaSyncCard.vue`、Relay server | `docs/persona-data-sync.md` |
| RabiSpeech TTS / ASR 服务 | 实验支持，同步直接 API + RabiPC 语音消息端 + 动态模型发现 + 会议说话人分离 + 按日语音记录 + 24 小时 TTS 音频缓存 + 性能报告 | RabiSpeech 配置、主机声纹 embedding、`data/speech/messages/YYYY-MM-DD.jsonl` 通用语音消息、人格 `voice-transcripts.jsonl` / `conversation/current.jsonl`、人格声线与缓存；Android/普通远端都只传 PCM，主机拥有 ASR/VAD、切句和不透明声纹/聚类证据，Route/人格解释关系并决定投递 | 一段 ASR 只写一次主机消息；本机/普通远程声卡按 `speech` 消息端投递，Android 连续 PCM 流在 PC 完成处理后按 `rabilink` 投递，各人格保留完整分段；主机不写人名，不判断声纹是谁或谁是用户，手机回复默认回原 `sourceDeviceId` | 本地 Provider 默认可用；WebGUI 页级滑轨经 Manager 安全启停当前 Windows 工作区 RabiSpeech，开启通过健康检查后才显示参数，关闭收起整页内容；ASR 页另有持久主机总开关，开启即持续录音和识别，Route 订阅只控制结果分发，没有订阅时仍保存主机记录，关闭总开关不影响手动音频识别；外部 API Provider 与 RabiLink 语音中转分别显式启用 | `/v1/events` 经 Manager `/api/speech/events` 推送麦克风、播放、音频流和成功落盘的 `records_changed`；Android chunk 严格递增，稳定 `chunkId` 支持 ACK 丢失后的跨流幂等，系统网络/SSE 事件主动续传，有界缓冲避免恢复后永久滞后；每个成功 chunk 重置一次性 15 秒失活事件；`GET /api/speech/messages` 查询主机原始消息和 Route receipts，`POST` 返回逐 Route 终态；`npm run check:speech-ingress-separation` 用隔离构建产物验证主机库、两个消息端、人格历史和稳定回复设备 | `/v1/events`、`/v1/models`、`/v1/records`、`/v1/audio-streams/rabilink/*`、`/api/speech/events`、`/api/speech/runtime/start|stop`、`/api/speech/selection-reader/settings`、`/api/speech/*`、`/#/speech` | `plugin-adapters/rabi-speech/`、`desktop/tray-task-window/rabiroute_tray/system_selection.py`、`src/manager/selectionSpeechSettings.ts`、`src/speechIngressStore.ts`、`src/manager/speechRuntimeControl.ts`、`src/manager/speechControl.ts`、`src/routing/speechIngressForwarding.ts`、`src/acceptance/speechIngressSeparation.ts` | `docs/rabispeech-plugin.md` |
| 本机语音模型管理 | 实验支持 | `plugin-adapters/rabi-speech/model-catalog.json` 固定允许清单、插件私有 `.deps`、外置模型目录和安装清单 | 标准安装不附带语音依赖或模型；用户在主机级页面安装核心语音环境，再逐个下载 TTS、ASR 或说话人权重 | Manager 同一时间只运行一个仓库内安装脚本，只接受固定模型别名；任务状态由 `/api/events` 推送，重连补一次快照，不轮询；响应不返回私有绝对路径 | “权重已下载”只证明文件和安装清单，不证明隔离运行环境、真实推理、波形或设备验收；授权 ONNX-VITS 包仍需手动导入 | `/#/models`、`GET /api/speech/model-management`、`POST /api/speech/model-management/runtime/install`、`POST /api/speech/model-management/models/:alias/install` | `src/manager/speechModelManager.ts`、`src/shared/speechModelManagement.ts`、`ribiwebgui/src/pages/ModelManagementPage.vue`、`ribiwebgui/src/speech/speechModelManagementClient.ts` | `docs/local-speech-model-downloads.md` |
| 语音消息端账号（兼容数据） | 已有，已并入“身份关系”页面 | 人格 `voice/voice-identities.jsonl` 追加事件；兼容键为 `sourceHostId + voiceprintId`，概念上对应语音平台、处理主机/识别模型命名空间和声纹 ID | 当前接收语音的绑定人格 | 人格根据自身会话、记忆和关系确认或修正时；用户明确询问全天/区间说话人归类时，AgentPacket 只为本次任务注入查询和修正合同；身份关系页的语音区域进入/切换/人工操作或收到语音、关系、同步事件时查询一次 | 同一录音可含多个语音账号；保存人格自己的称呼、关系、可选 `isUser`、别名和说明；相同更新幂等，修正/删除追加事件或 tombstone；主机、RabiSpeech、Route 不写人格结论；只读视图按时间和 `user/other/unknown/conflict` 联结会话证据；“标记下一段”只高亮候选，不自动认人；多 PC 冲突显式显示并可再次确认收敛；在统一身份数据迁移完成前仍以兼容接口为准 | WebGUI 人格页“身份关系 → 语音消息端账号”、`GET/PUT /api/roles/:roleId/voice-identities`、`GET /api/roles/:roleId/voice-transcripts`、AgentPacket `voiceIdentitiesPath` | `src/personaVoiceIdentities.ts`、`src/personaVoiceTranscriptView.ts`、`src/manager/personaVoiceTranscriptRoutes.ts`、`ribiwebgui/src/persona/personaVoiceIdentityClient.ts`、`ribiwebgui/src/persona/personaVoiceConfirmation.ts`、`ribiwebgui/src/pages/PersonaTemplatePage.vue`、`src/routing/agentCapabilityHints.ts` | `docs/rabispeech-plugin.md`、`docs/user-guide/personas-and-rules.md` |
| 人格身份关系 | 已有，自动建立陌生账号候选、追加事件、同步冲突保护与可审阅的情景记录 | 人格 `identity-relations/events.jsonl` 和 `conversation/situations/*.json`；账号键为 `platform + endpointIdentityNamespace + senderStableId`，并关联参与者和关系卡 | 当前投递消息绑定的人格 | 稳定陌生账号在真实投递时自动建立“待认识”候选；同一账号复用候选，处理 Agent 只在出现新线索时追加候选观察；人格页可查看、确认、纠正参与者、账号映射与关系卡，并回看最近不含聊天正文的情景记录 | 昵称、群权限、Route、关键词和一次发言都不能自动确认身份；候选和冲突记录不能支持称呼、授权或项目归属；预览不写身份；候选观察 API 不能写 `confirmed` 或覆盖冲突；适用于当前会话的项目关系只进入 AgentPacket 和情景记录，允许参与讨论但不能据此管理项目计划、任务或长期记忆；多 PC JSONL 并集合并保留并发头，完整修正替代所有当前头 | 人格页、`GET/PUT /api/roles/:roleId/identity-relations`、`POST /api/roles/:roleId/identity-relations/observations`、`GET /api/roles/:roleId/conversation-situations`、AgentPacket `[身份关系]` 与 `[情景记录]`、`semanticConflicts` | `src/identityRelations.ts`、`src/routing/identityContext.ts`、`src/routing/conversationSituation.ts`、`src/conversationSituationStore.ts`、`src/manager/controlPlaneRoutes.ts`、`ribiwebgui/src/components/PersonaIdentityRelationsCard.vue` | `docs/agent-context-injection.md`、`docs/plan-and-memory-model.md`、`docs/persona-data-sync.md` |
| Rabi 局域网语音客户端 | 实验支持 | RabiSpeech 私有 `remote_audio` 配置、独立音频流密钥和当前音频流选择 | 会议室电脑只作为远程麦克风/喇叭，持续传 PCM、接收 WAV；独立 GUI 维护主机连接、设备选择、实时电平与采集/播放状态；主机继续执行 VAD、切句、ASR、TTS、FIFO 和 Route 广播 | RabiSpeech 启用 `remote_audio`，GUI 通过 UDP 自动发现或指定地址，并用 Bearer 密钥连接 TCP WebSocket；无人值守可用 `--headless` | 默认本机；远程断线不自动回退；RabiLink 独立且不是局域网连接前置配置 | 客户端 GUI；语音服务页顶部“音频流类型” | `plugin-adapters/rabi-speech/rabispeech/remote_audio.py`、`desktop/rabi-voice-client/` | `desktop/rabi-voice-client/README.md` |
| RabiLink 眼镜云日志 | 已有 | AIUI/设备诊断批次、应用 token、设备/版本/会话元数据 | Relay 管理账号日志中心 | 眼镜前台运行并产生诊断事件时异步入队；断网恢复后补传 | 客户端与服务端双重脱敏，按账号持久化并按设备/来源/级别查询；不采集 ASR、Agent 正文或无权限的系统全局日志 | `POST /api/rabilink/devices/logs`、`GET /manage/api/device-logs` | `scripts/rabilink-device-log-store.mjs`、`scripts/rabilink-relay-server.mjs`、`apps/rabilink-aiui/pages/home/index.ink` | `docs/rabilink-relay-server.md` |
| RabiLink 手机边缘通讯枢纽 | 首版契约 + 播放回执闭环 | 应用 token、设备身份、设备独立 cursor、目标/展示信封、手机私有可靠队列 | Android companion、Rokid 眼镜、未来 Wear OS / 耳机适配器 | 网络/SSE 事件唤醒后按 cursor 单次补漏；已知断网时 SSE/可靠发送等待系统网络事件，仅在已知离线期间用五分钟 OS 网络检查兜底厂商漏回调；SSE 45 秒无 keepalive 时只重建半开传输，联网服务失败才 1–30 秒退避；文字/媒体/回执断网补传；PCM 有界追实时 | 手机承担网络、状态、崩溃去重、消息连接恢复意图和外设扇出，不拥有 Agent/账本；离线兜底与 SSE 停滞 deadline 都不读取 Relay 业务消息；已启动连接在重启后恢复，明确停止才关闭恢复；`delivered` 只表示呈现，手机/眼镜各自只在 AudioTrack marker 后回 `played`；眼镜确认暂停采集后才接收 PCM，销毁时明确失败；可靠队列满时显式拒绝新项目，不删除旧项目 | `/api/rabilink/devices/input`、`/api/rabilink/devices/messages`、`POST /api/rabilink/devices/message-receipts`、Android `RabiRouteSdk` | `scripts/rabilink-relay-server.mjs`、`packages/android-sdk/rabiroute-sdk/`、`apps/rabilink-android/` | `docs/rabilink-phone-edge-hub.md`、`docs/mobile-message-endpoint.md` |
| 主动智能实体环境验收状态 | 已有，失败关闭 | 真人声纹 manifest/正式报告、双 PC 同步证据、Android soak、Rokid 真机摘要、人工物理观察 | 脱敏汇总 JSON 与 CI/人工验收终态 | 人工/Agent 显式运行一次；不启动测试、不轮询设备 | 四领域分别输出 `missing/partial/passed/stale/invalid`；自动化只作前置，合成声纹不能冒充正式证据；汇总仅保留哈希、时间和检查项 | `npm run check:active-intelligence:physical` | `scripts/check-active-intelligence-physical-acceptance.mjs` | `docs/rabilink-active-intelligence-requirements.md` |
| RabiLink 统一会话账本与审阅器 | 已有 | `rabilink-conversation.jsonl`、审阅 cursor、route review variables | 固定 Codex 线程、空闲审阅、周期反思、触摸板 turn steer | 新 observation 稳定后、线程空闲时、周期到期或眼镜请求立即审阅时 | 原子推进 cursor；可把显式白名单内的常驻转写源归一为 observation；可能唤醒或 steer Codex；不在 ASR 请求内同步等待 | 角色目录运行数据；`examples/data/route/RabiLink/` 提供脱敏配置模板 | `src/rabilinkConversationLedger.ts`、`src/rabilinkObservationRecorder.ts`、`src/rabilinkConversationReviewer.ts` | `docs/rabilink-relay-server.md` |
| 企业微信消息端 | 实验支持 | WeCom SDK frame、route config、`wecom-messages.jsonl` | forwarding、Outbox WeCom 回复 | WebSocket 收到消息时 | 写消息日志，可能投递 Agent | route 消息端 | `src/adapters/wecomAdapter.ts`、`src/wecom.ts`、`src/messageEndpoints/wecomManager.ts` | `docs/wecom-integration.md` |
| 个人微信消息端 | 实验原型 | OpenClaw/iLink 二维码、长轮询、context token、`weixin-messages.jsonl` | forwarding、Outbox 来源会话文本回复 | 登录轮询或收到消息时 | token 写运行期 `data/`；文本可能投递 Agent，媒体只记录 | route 消息端 | `src/adapters/weixinAdapter.ts`、`src/weixinOpenClaw.ts` | `docs/current-capabilities.md` |
| 定时任务运行入口 | 已验证 | `automationRules[].trigger.schedule`、`heartbeatSkipWhenAgentBusy`、`messageProcessingAgents.codex`、Route 本机脚本权限 | heartbeat adapter、AgentPacket、受限脚本执行器、Codex active 状态、消息处理 Agent 池 | 定时器触发时 | 通知 Agent 时写 heartbeat 与投递日志且不注入聊天历史；运行脚本时写独立自动化执行记录；同一规则不重叠运行 | Route 启用 heartbeat；脚本动作还要明确打开本机权限 | `src/adapters/heartbeatAdapter.ts`、`src/automation/personaAutomationRuntime.ts`、`src/scheduling/heartbeatSchedules.ts`、`src/forwarding.ts` | `docs/configuration.md` |
| Manual trigger | 已验证，真实投递 | manager request、`manual-trigger-events.jsonl` | `triggerManualRule`、forwarding | 用户点击 / API 调用时 | 写手动触发日志、router 日志、replay ledger，可能投递 Agent | `POST /gateways/:id/manual-trigger` | `src/manualTrigger.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| Role panel message | 已验证，真实投递 | `data/roles/<RoleId>/role-panel/messages.jsonl` | role panel 子进程、forwarding | 用户在角色面板发送时 | 写 timeline，可能投递 Agent | `POST /api/role-panel/messages` | `src/rolePanelTimeline.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/routing-and-personas.md` |
| RouteDecision | 已有 | route profile、event record、extra values | forwarding、未来 preview | 每次投递时 | 本身无写入；调用方可能写日志 | 代码内部 | `src/routing/routeDecision.ts` | `docs/persona-route-workbench-plan.md` |
| Forwarding | 已有 | active routeProfiles、record、extra values、Route 的 `primaryAgentAdapter` 与消息处理 Agent 策略 | 主控 Agent adapter、消息处理 Agent 池、history、delivery replay | 每次真实消息进入时 | 普通逐条路由只投递主控 Agent；已形成的消息组和启用模式后的 heartbeat 投给消息处理 Agent；失败时不自动改投不同类型 Agent | `forwardMessage` / `forwardMessageAndWait` | `src/forwarding.ts`、`src/messageAgentPool.ts` | `docs/code-architecture.md` |
| AgentPacket | 已有 | RouteDecision、role paths、logs、role knowledge、Route 的计划管理秘书绑定、统一 `messageSource` | Agent adapter | 命中规则后 | 输出同时保留结构化 `messageSource`、未包装 `content` 和最终 `message`；最终正文固定以 `[消息源]`、`[消息内容]` 开头。来源类型统一为消息端、Agent、计划和系统，各自携带名称与完整 ID。构造时会触发 roleKnowledgeSnapshot，可能刷新记忆 viewedAt；只有显式 memory-consolidation 触发才评估并创建待整理 run | 代码内部；preview 仍未实现 | `src/shared/rabiMessage.ts`、`src/routing/agentPacket.ts`、`src/roleKnowledge.ts` | `docs/agent-context-injection.md` |
| Codex adapter | 已验证，正式主链为 Desktop owner | route agent config、Desktop 任务状态、精确任务 ID 与工作目录 | Codex Desktop IPC | 每次已匹配的普通消息/AgentPacket 投递时 | 普通逐条路由直接尝试 steer 当前活跃 turn，无活跃 turn 则 start。消息处理 Agent 模式开启后，消息组和 heartbeat 使用独立消息处理任务；关闭时 heartbeat 才可由 `heartbeatSkipWhenAgentBusy` 跳过 | route Agent 端 | `src/codexDesktopBridge.ts`、`src/codexRuntime.ts`、`src/messageAgentPool.ts` | `docs/code-architecture.md` |
| DSH adapter | 实验支持 | Route 的 `dshSessionId`、`dshSessionName`、`dshCwd`、`dshBaseUrl` 与 DSH 工作空间注册表 | DSH apiproxy `workspace.create`、`session.create`、`session.prompt` | 保存或投递需要解析 DSH 会话时 | 有效 ID 与工作目录一致时续投原会话；零匹配才幂等创建。创建前注册或复用 `dshCwd` 对应的 DSH 工作空间，并把 `workspaceId` 交给 `session.create`，因此新建的主人格、消息处理、计划秘书和记忆整理会话直接进入对应分组；失败时不切换备用 Agent | Route Agent 端；WebGUI 按 API 地址、工作目录、会话完成扫描和绑定 | `src/dshSessionBridge.ts`、`src/agentAdapters/agentAdapter.ts`、`ribiwebgui/src/pages/RouteConfigPage.vue` | `docs/configuration.md` |
| Rabi Codex Context 插件 | 0.4 统一上下文与完成 Hook 版本 | 真实 Codex session ID、显式 RoleId 绑定、Rabi Manager 角色配置 | Codex `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` Hook，以及 RabiRoute `message_delivery` | 插件已安装且变更后的 Hook 已信任；上下文注入要求 session 显式绑定，计划完成匹配以计划 `taskBinding` 为准 | WebGUI 可分别控制会话入口、推理刷新和计划完成三组 Manager 响应，默认全开且不改插件注册；入口注入受限人格与轻量索引，推理期只注入本 turn 新命中的必读路径；`Stop` 成功时无输出，失败只警告 | `[rabi:use <RoleId>]` 等严格控制标记；Rabi PC 也可按完整 session ID 主动绑定 | `src/context/rabiContextManager.ts`、`src/manager/codexHookContext.ts`、`plugins/rabi-codex-context/`、`.agents/plugins/marketplace.json` | `docs/rabi-codex-context-plugin.md` |
| 计划会话任务完成提醒 | 实验支持，代码与 mock 链路已测试 | 计划独立业务 `taskBinding`、Codex `Stop` 的 `session_id/turn_id/cwd/last_assistant_message`、人格 Route/gateway 精确绑定 | `Stop` Hook → Manager → 角色面板 timeline → Forwarding / AgentPacket → 主人格分配计划管理秘书消费结果并精确续投原业务任务 | 绑定业务会话完成一轮，且计划未暂停、计划与目标 Route 均未关闭完成通知时；计划省略 `completionHook` 默认开启 | 路由层按 `sessionId + turnId` 去重且不自动修改计划；秘书只更新计划/记忆、核对并续投业务任务，不执行业务。秘书轮转或计划暂停不清空 `taskBinding`。workspace、人格、gateway、多计划绑定及源目标同会话冲突失败关闭；尚未完成真实 Desktop 纵向验收 | 计划 POST/PATCH 的 `taskBinding.completionHook` 与 Route `codexHooks.planTaskCompletionEnabled` | `src/manager/codexHookContext.ts`、`src/manager/planTaskCompletionDelivery.ts`、`src/manager/controlPlaneRoutes.ts`、`plugins/rabi-codex-context/` | `docs/plan-and-memory-model.md`、`docs/rabi-codex-context-plugin.md` |
| Agent Codex 任务桥与必回复请求 | 已有；五分钟提醒仍需本机 Hook 纵向验收 | Desktop 任务状态、已配置的工作区、统一 `messageSource`、`data/.runtime/agent-requests.json` | 主人格、计划 Agent、计划秘书、消息处理 Agent、Codex/DSH 任务 owner | Agent 调用 `/api/agent/threads`、目标轮次触发 `Stop`，或绕过投递触发 `PreToolUse` 时 | 带正文的 `create` / `send` 必须传完整 `messageSource`。Agent 来源必须包含 Agent 端、会话名称和完整会话 ID；Agent 互投还要核对 `sourceThreadId`。正文固定以 `[消息源]`、`[消息内容]` 开头，并可建立必回复请求 | `POST /api/agent/threads`、`GET /api/agent/requests` | `src/shared/rabiMessage.ts`、`src/agentThreads.ts`、`src/agentRequests/`、`src/manager/agentCommunicationHookPolicy.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| 消息处理看板与发送需求 | 实验支持，状态机、接口和 WebGUI 已构建测试 | `data/.runtime/message-processing-board.json`、消息组来源、引用链与附件证据、结构化转交、计划变动和 Outbox 回执 | 消息处理 Agent、heartbeat、WebGUI | 消息组进入处理、Agent 转交/提交判断、计划统一写入、Outbox 返回结果时 | 直接 @、直接回复、私聊和计划进展生成必须处理项；普通群讨论保留 Agent 判断；NapCat 图片收到后立即保存并作为 Desktop 图片输入，当前讨论片段优先于宽泛历史；原消息、引用链或附件核对不完整时不能回复，附件不可读时只能重试或转交；群消息引用 Agent 外发消息时按发送回执会话增加池内任务权重；回复前读取最新双向上下文并把短期审核绑定到上下文版本、完整会话、目标和正文，精确来源超出近期窗口时只从该人格正式群消息记录恢复唯一同 Route 消息；新消息、已有回复、记录缺失/重复/冲突或请求变化时失败关闭；显示处理任务、转交、不回复原因、发送失败、超时和空闲无结果；计划通知通过写入事件触发，不扫描目录 | `GET /api/message-processing/board`、`POST /api/message-processing/requirements/:id/outcome`、`GET/POST /api/message-processing/requirements/:id/send-context`、`POST /api/agent/threads`、`POST /api/agent/send`、`GET /api/agent/send/traces` | `src/napcatMedia.ts`、`src/messageProcessing/sourceEvidence.ts`、`src/messageProcessing/board.ts`、`src/messageProcessing/persistence.ts`、`src/messageProcessing/sendContextReview.ts`、`src/messageProcessing/sourceContextRecovery.ts`、`src/messageProcessing/managerClient.ts`、`src/messageAgentPool.ts`、`src/manager/controlPlaneRoutes.ts`、`ribiwebgui/src/components/MessageProcessingBoard.vue` | `docs/group-message-batching-and-triage-plan.md`、`docs/rabi-agent-interfaces.md` |
| Copilot CLI adapter | 实验支持 | route agent config、Copilot CLI | Copilot CLI | AgentPacket 投递时 | 启动 / 调用 CLI | route Agent 端 | `src/copilotCli.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| AstrBot adapter | 实验支持 | AstrBot dashboard / plugin API | AstrBot | AgentPacket 投递时 | 调用 AstrBot API | route Agent 端 | `src/agentAdapters/astrbotAdapter.ts`、`scripts/rabiroute_agent/` | `docs/code-architecture.md` |
| Marvis adapter | 人工接力 | Marvis 本地能力 | Marvis | AgentPacket 投递时 | 写 prompt、复制剪贴板、打开应用；不能保证后台会话注入 | route Agent 端 | `src/marvis.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| Outbox / Send | 已有 | 必填稳定 `deliveryId`、`sender.agentType + sender.sessionId`、精确 `routeId`、`channel`、渠道专用 `params` 和 `payload` 的明确发送请求 | QQ / WeCom / RabiLink / speech / role panel 等发送出口 | Agent、定时器或规划器调用 `/api/agent/send` 时 | 可能写 draft、阻止、外发、写发送日志；发送前持久化 reservation，同 ID 同请求只执行一次，超时/重启先查询 `/api/agent/send/receipts/:deliveryId`，也可按渠道和 `sentMessageId` 反查发送会话，uncertain 不自动重发；来源上下文不参与目标推断；NapCat 群聊必须显式提交 `replyToMessageId`，真实 ID 引用消息，空字符串表示明确不引用，省略则向 Agent 返回可行动错误；引用消息含图片时，发送前按来源图片数量和顺序校验 `replyImageDescriptions`，成功后在图片旁写同名 `.md` 并返回会话映射；本地群文件校验 `allowedFileRoots` 后走 `upload_group_file`；RabiLink 必须明确目标设备 | `POST /api/agent/send`、`GET /api/agent/send/receipts/:deliveryId`、`GET /api/agent/send/traces` | `src/agentSend.ts`、`src/replyImageDescriptions.ts`、`src/manager/agentSendIdempotency.ts`、`src/outbox.ts`、`src/napcat.ts` | `docs/rabi-agent-interfaces.md` |
| Pipeline presets | 已有 | route `pipelinePreset` / `pipeline` | AgentPacket、Outbox | route 配置生效后 | 影响输出模式和自动回复策略 | route 配置页 | `src/pipelines.ts` | `docs/pipeline-presets.md` |
| 计划 | 已有 | `data/roles/<RoleId>/plans`、追加式 `plans/history/*.jsonl` 与私有 `attachments/<planId>/` | roleKnowledgeSnapshot、Agent 接口、WebGUI 与托盘只读页 | AgentPacket 构造或 API 调用时 | 可通过 API 创建 / 更新五种顶层生命周期状态与受管附件；Manager 根据结构化当前步骤、审批合同和权威证据统一派生绿色“进行中”、蓝色“等待打包”、紫色“等待 QA”、灰色“暂停”、红色“待审批”、橙色“待人工核验”，并提供 `counts.stages`、色板与顺序。外部等待原因只保留为内部 `waitingFor`。项目内容计划只有完成适用 Main/Release/Art 同步、SVN 提交和无冲突回读后才进入蓝色等待打包，目标包证明纳入后进入紫色 QA；QA 发送回执只决定 `send_qa_request` 或 `wait_for_qa_result`。调查、设计评审、运营、资料收集、外部依赖与控制面维护保持真实流程。WebGUI 与 Qt 只透传 DTO，缺失 `presentation` 时显示中性未知状态，不建立第二套分类器 | `/api/roles/:roleId/plans`、`GET /api/roles/:roleId/plans/:planId/history`、`GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId` | `src/roleKnowledge.ts`、`src/planAttachments.ts`、`src/roleKnowledgePresentation.ts`、`src/roleKnowledgePagination.ts`、`src/manager/planAttachmentRoutes.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/plan-and-memory-model.md` |
| 计划反馈与 QA 判定 | 已有 | `data/roles/<RoleId>/plans/feedback/*.jsonl`、私有 `attachments/<feedbackId>/` 与当前计划受管附件 | 绑定业务任务、人格 Agent、WebGUI、Qt 托盘 | 用户从计划页提交文字/附件、在输入框用 `@` 引用计划附件，或 Agent 记录 QQ/其它入口的反馈时 | 普通引导和审批校验并落盘后按原 `taskBinding` 投递，不直接更新计划；只有当前结构化 `qa-* / verify-*` 步骤收到用户或外部入口的 `approval_suggestion` 明确 QA 结论时，Manager 才消费判定。失败或仍复现会回到同计划调查、索取最小必要证据并继续原业务任务，明确 QA 通过才完成；Agent 执行报告、引导/回复及裸 `passed / verified` 计数保持普通记录 | `GET/POST /api/roles/:roleId/plans/:planId/feedback` | `src/planFeedback.ts`、`src/manager/planQaFeedback.ts`、`src/manager/planApprovalFeedbackDelivery.ts`、`src/manager/controlPlaneRoutes.ts`、`src/routing/systemEventRules.ts` | `docs/plan-and-memory-model.md`、`docs/rabi-agent-interfaces.md` |
| 近期记忆 | 已有 | `data/roles/<RoleId>/memory/recent/*.md`，兼容旧 JSON | roleKnowledgeSnapshot、Agent 接口、Markdown 阅读器 | AgentPacket 构造或 API 调用时 | 读取命中项刷新 viewedAt/recalledAt；更新刷新 updatedAt/viewedAt | `/api/roles/:roleId/memory/recent` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 沉淀记忆 | 已有 | `data/roles/<RoleId>/memory/consolidated/*.md`，兼容旧 JSON | roleKnowledgeSnapshot、Agent 接口、Markdown 阅读器 | 整理结果、读取或召回时 | 命中必读项刷新 viewedAt/recalledAt；已有沉淀记录不再进入整理输入 | `/api/roles/:roleId/memory/consolidated` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 记忆整理 | 已有 | `memory/consolidation-runs` | AgentPacket、Agent 回传 API、可选独立 Codex 记忆整理任务 | Manager 到达最早 72 小时截止时间、显式 `memory-consolidation` 手动触发或 Manager API request | 固定 72 小时触发时的 24 小时候选范围；自动到点创建并投递 run；提交 result 后标记来源并写沉淀记忆 | `/api/roles/:roleId/memory/consolidation-*` | `src/roleKnowledge.ts`、`src/memoryConsolidationAgent.ts`、`src/manager/memoryConsolidationScheduler.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/plan-and-memory-model.md` |
| 角色技能 | 已有 | `data/roles/<RoleId>/skills/*.md` | roleKnowledgeSnapshot、AgentPacket 技能索引 | AgentPacket 构造时 | 一般只读 | `/api/roles/:roleId/skills` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| Runtime log | 已有 | runtime stdout/stderr、adapter logs | WebGUI 日志页、排障 | 运行时持续产生 | 只读展示 | WebGUI 日志诊断 | `src/manager/runtimeRegistry.ts`、`ribiwebgui/src/pages/RuntimeLogPage.vue` | `docs/troubleshooting.md` |
| Delivery replay | 已有 | `delivery-replay-ledger.jsonl` | replay API / manager child process | 投递后记录，用户触发 replay 时重放 | replay 会再次进入真实投递链路 | `/gateways/:id/delivery-replay` | `src/deliveryReplay.ts`、`src/deliveryReplayLedger.ts` | `docs/troubleshooting.md` |
| Remote Agent | 实验支持 | remote-agent devices / tasks | 远端设备、manager API | 设备连接 / 任务创建 / 事件回报时 | 创建任务、接收任务事件，完成后可投递回本地 Agent | `/api/remote-agent/*` | `src/messageEndpoints/remoteAgentManager.ts` | `docs/rabi-agent-interfaces.md` |
| Rabi 多实例 API | 已有 | `manager.json`、runtime identity | 远端 / 多实例控制面 | API 调用时 | 代理其它实例的 routes / binding / replies | `/api/rabi/*` | `src/manager/rabiApi.ts` | `docs/rabi-agent-interfaces.md` |
| RabiRoute Desktop | 已有 | 与 RibiWebGUI 同源的 Manager HTTP API、打包资源 | Windows 桌面入口 | 用户启动 RabiRoute Desktop 时 | 作为一个 Windows 应用启动和退出本机 Manager 后端，并异步显示 DTO；不直接读取 `data/`。WebGUI“设置”页开启滑词菜单后，系统托盘入口支持鼠标拖选和 `Shift` 键盘扩选；普通软件通过 UI Automation 读取文字与选区矩形，Unity 编辑器在不可用时发送受保护的临时复制并恢复剪贴板。悬浮条按选区横向居中，向上拖选放上方，向下或同一行拖选放下方；无系统插入符时使用同一窗口最近一次点击位置。点击才执行；关闭“滑词朗读”后只保留“投递至” | `/gateways?summary=1`、`/api/roles/:roleId/*`、`RabiRoute-Desktop.exe` | `desktop/tray-task-window/`、`scripts/build-desktop-exe.ps1` | `docs/windows-launcher-and-packaging.md` |
| 示例数据 | 已有 | `examples/data/` | 初次初始化、公开示例 | 首次无 data 目录时可复制 | 只默认启用 `main`；其他接入模板保持禁用；不应包含真实账号和 token | 仓库示例 | `examples/data/roles`、`examples/data/route` | `examples/data/README.md` |
| 项目内 Skills | 已有 | `skills/` | Codex / Agent 开发指南 | Agent 读取 skill 时 | 无运行时副作用 | 仓库文件 | `skills/*/SKILL.md` | `skills/create-rabiroute-persona/SKILL.md` |
| 人格路由工作台预览 | 拟新增 | route profile + simulated record | dry-run RouteDecision / AgentPacket / roleKnowledge | 用户点击生成预览时 | 必须无副作用：不投递 Agent、不写日志、不刷新 viewedAt | 未来人格页 | `docs/persona-route-workbench-plan.md` | `docs/persona-route-workbench-plan.md` |

## 边界规则

- 没有“智能命中人格”。Route 通过 `agentRoleId` 固定绑定人格；`createRouteDecision` 只匹配当前 Route 中由消息触发、动作是通知 Agent 的自动化规则。脚本动作由自动化运行时单独执行。
- 真实投递会遍历 gateway 子进程里的 active routeProfiles；如果某个 UI 只选定单 route，就只能称为“单 route profile 试算”。
- 消息端、Agent 端列表和主控 Agent 选择归 route：真源是 `adapterConfig.json`；WebGUI 只编辑，配置归一化层负责保证主控仍在列表中。
- 人格正文、模板规则、计划、记忆和技能归 role：真源是 `data/roles/<RoleId>/`。
- WebGUI 不是配置事实源。前端负责表单和展示，配置不变量应落在 `src/shared/gatewayConfigModel.ts` 或 manager 后端。
- WebGUI locale 只是浏览器 UI 偏好。route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据不翻译；使用手册按语言读取 `docs/user-guide/` 对应文件。
- 预览能力目前是拟新增设计，应走后端 dry-run，不能调用 `forwardMessageAndWait`。
- 真实外发必须经过 Outbox / Action Gate。处理端不要绕过 RabiRoute 直接写 QQ、WeCom、RabiLink 或外部系统。
- 持久计划秘书控制面按 `planId` 保持单 writer，不同计划可并行推进；共享账本在短锁内合并并原子替换。锁元数据完整写入后原子发布，stale/损坏锁失败关闭并只允许 quiescent 维护修复；同 key 的认领/澄清先记 reservation，结果不明确时不自动重发。audit 使用前后快照区分稳定 invalid 与并发 incomplete，一个 active cycle 不会成为 audit 或 reconcile 的全局屏障。
- 腾讯表、direct/generic 用户请求和已有效引用认领的工作群问题，都通过受管 `register-external` 登记后进入秘书 `begin → finish`。工作群来源固定为群 `474222421`，要求真实 `sourceMessageId` 以及同一问题键下 `status=sent` 且含 `sentMessageId` 的认领回执；登记同时校验计划/任务唯一性、至少两轮查重和输入/计划/任务三方 workspace，生成 `governanceVersion=3` 映射。腾讯表稳定行键和用户请求规范签名语义保持不变；不允许手改 `issue-threads.json`。
- 旧版统一 Outbox 认领没有写入专用回执账本时，登记器只在本地会话出站记录与 NapCat 实时消息回读同时证明同群、同发送消息和同引用目标后恢复回执；单凭登记输入或单侧日志不能补账，恢复过程不重发群消息。
- 工作群 `begin` 使用登记映射、计划绑定和 Desktop 回读的完整任务 ID + workspace 作为业务任务身份；PangHu 接受 `[PangHu][明确任务类型] ...`，RabiRoute 治理任务当前只接受 `[RabiRoute][Bug] ...`。新登记拒绝非法 live 标题；既有映射的非法旧标题只在同一任务和工作目录的 live 标题合法时，通过问题账本锁原子迁移。标题不能替代稳定身份、来源、认领回执、查重和唯一性校验。
- Codex adapter id 保持 `codex`；Codex/ChatGPT Desktop 是实际任务 owner，Desktop IPC 是唯一真实消息 transport。
- 不为真实消息增加共享 4510、独立 stdio app-server 或 fallback。项目锁定的 app-server 只做空任务元数据 bootstrap。
- 模型、工具、沙箱和 runtime approval 由目标 Desktop 任务拥有；它与业务 Action Gate 仍是两道独立边界。
- 运行期 `data/`、日志、token、真实账号、真实 QQ 群号和 Cookie 不进仓库。
- 已匹配的普通消息默认直接进入 Desktop owner：活跃 turn 用 `steer`，空闲用 `start`。只有明确策略才例外，例如 Heartbeat 忙碌跳过和语音关键词唤醒。
- `speechPushMode=hot` 表示每段 ASR 完成后立即投递；`keyword` 表示仍完整记录，只在命中当前人格 `speechTriggerKeywords` 时唤醒。关键词为空时不会暗中回退 `hot`。

## 运行数据与日志

| 数据 | 路径 | 写入者 | 用途 |
| --- | --- | --- | --- |
| route 配置 | `data/route/<configName>/adapterConfig.json` | manager 配置保存 | Gateway 启动和运行配置 |
| 人格配置 | `data/roles/<RoleId>/personaConfig.json` | manager / WebGUI | 可选 `avatar`、`automationRules`、`speechTriggerKeywords`、`recentMessageLimits` |
| 人格声线与 TTS 缓存 | `data/roles/<RoleId>/voice/voice-profile.json`、`voice/cache/tts-audio/` | 用户 / RabiSpeech | TTS 模型、声线、语言、表达配置与按文件时间戳保留 24 小时的可重建成品音频；界面只显示安全相对路径 |
| 语音消息端账号兼容归类 | `data/roles/<RoleId>/voice/voice-identities.jsonl` | 当前人格 | 在统一身份页面中按处理主机 + 声纹 ID 保存称呼、关系和可选用户判断；追加事件可参与多电脑 JSONL 合并，完成统一数据迁移前仍是语音归类真源 |
| 当前双向会话 | `data/roles/<RoleId>/conversation/current.jsonl` | forwarding、Outbox、各消息端/Manager 旁路 | 当前人格的完整入站/出站证据；无条数上限，自动注入只读本文件 |
| 会话归档 | `data/roles/<RoleId>/conversation/archive/<n>~<m>.jsonl`、`index.json` | `messageContextStore` | 存在超过 72 小时记录时，归档连续前缀中超过 24 小时的完整记录；保留供显式查证 |
| 人格正文 | `data/roles/<RoleId>/persona.md` | 用户 / 示例数据 | Agent 人格说明 |
| 群消息 | `group-messages.jsonl` | NapCat adapter、forwarding role dir copy | 来源协议审计与 CQ 引用链兼容；自动最近上下文以统一双向账本为准 |
| 私聊消息 | `private-messages.jsonl` | NapCat adapter、forwarding role dir copy | 来源协议审计与 CQ 引用链兼容；自动最近上下文以统一双向账本为准 |
| 语音转写 | `voice-transcripts.jsonl`、`rabilink-voice-transcripts.jsonl` | webhook / RabiLink 兼容 adapter | 语音入口事件与旧链路调试记录 |
| RabiLink 统一会话 | `data/roles/<RoleId>/rabilink-conversation.jsonl` 及审阅 cursor | RabiLink Relay worker、conversation ledger / reviewer、Outbox | AIUI observation、Agent 主动下行、空闲审阅与恢复 |
| 企业微信消息 | `wecom-messages.jsonl` | WeCom adapter | 企业微信入口事件 |
| 个人微信消息 | `weixin-messages.jsonl` | Weixin adapter | 个人微信入口事件；媒体首版只记录 |
| 心跳事件 | `heartbeat-events.jsonl` | heartbeat adapter、forwarding role dir copy | 定时触发记录 |
| 手动触发事件 | `manual-trigger-events.jsonl` | manual trigger | 手动测试 / 触发记录 |
| 投递通知 | `agent-packets.jsonl` | forwarding | AgentPacket 投递审计 |
| replay ledger | `delivery-replay-ledger.jsonl` | forwarding | 失败回放、投递复盘 |
| adapter 日志 | `*-adapter.log.jsonl` | adapters / forwarding | 排障 |
| RabiLink 回复 | `rabilink-replies.jsonl` | Outbox / RabiLink reply path | RabiLink 下行查询和 relay worker |
| role panel timeline | `data/roles/<RoleId>/role-panel/messages.jsonl` | role panel API / outbox | WebGUI 角色面板会话 |

## 常见修改入口

| 需求 | 优先看 | 注意 |
| --- | --- | --- |
| 新增消息入口 | `src/adapters/<name>Adapter.ts`、`src/adapters/messageAdapter.ts`、`src/index.ts`、`src/shared/gatewayConfigModel.ts` | 不要塞进 NapCat adapter；route kind 和配置 normalize 要补齐 |
| 新增处理端 | `src/agentAdapters/types.ts`、`src/agentAdapters/agentAdapter.ts`、`src/agentAdapters/managerApi.ts` | Agent adapter 只投递 AgentPacket，不定义路由语义 |
| 改 Codex 投递 | `src/codexRuntime.ts`、`src/codexDesktopBridge.ts`；空任务元数据才看 `src/codexAppServerClient.ts` | Desktop IPC 是唯一真实消息主链；有效 ID 优先，任务无法加载就失败，不加第二 Runtime、WebSocket 或 fallback；模型、工具和审批由目标 Desktop 任务拥有 |
| 改自动化触发或动作 | `src/automation/personaAutomationRuntime.ts`、`src/adapters/heartbeatAdapter.ts`、`src/routing/routeDecision.ts`、`src/shared/gatewayConfigModel.ts` | 消息匹配不要在 adapter 或前端复制；脚本权限与路径限制不能交给人格模板决定 |
| 改 Agent 收到的消息 | `src/routing/agentPacket.ts`、`docs/agent-context-injection.md` | 不要在消息端拼 prompt；具体业务闭环应由对应人格或处理端 Skill 定义，不要硬编码到所有 AgentPacket |
| 改通用投递文案 | `src/shared/agentCommunicationPolicy.ts`、`src/agentThreads.ts`、`src/messageAgentPool.ts`、`src/shared/codexPlanAssistantSessions.ts` | 稳定规则只保留一次；接口字段保留，长解释移到文档或 Skill |
| 改外发语言风格校验 | `src/languageStyleValidation.ts`、`src/agentSendLanguageStyle.ts`、`src/manager/languageStyleRoutes.ts` | `styleValidation=1` 默认校验，`0` 只跳过本次；失败停在 Outbox 前 |
| 改人格规则 GUI | `ribiwebgui/src/pages/PersonaTemplatePage.vue`、`ribiwebgui/src/stores/gatewayStore.ts`、`src/manager/configRepository.ts` | 人格规则写回 `personaConfig.json`，route 字段仍归 `adapterConfig.json` |
| 改 route GUI | `ribiwebgui/src/pages/RouteConfigPage.vue`、`src/shared/gatewayConfigModel.ts` | 不变量放 shared model |
| 改 Outbox / 回传 | `src/outbox.ts`、`src/pipelines.ts`、`docs/rabi-agent-interfaces.md` | 外部写入必须保留 action gate |
| 改计划 / 记忆 / 技能 | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/controlPlaneRoutes.ts` | 注意 viewedAt / consolidation run 的副作用 |
| 改 manager API | `src/manager/controlPlaneRoutes.ts`，必要时拆到 `src/manager/*` 或 `src/messageEndpoints/*` | 避免把所有逻辑堆回 controlPlaneRoutes |
| 改 WebGUI 导航 | `ribiwebgui/src/router.ts`、`ribiwebgui/src/App.vue` | 页面显示不应成为事实源 |

## 设计新功能检查单

每个新增 UI、字段、API 或自动化能力都必须回答：

| 问题 | 要求 |
| --- | --- |
| 真源在哪里？ | 明确写入哪个文件、API、运行时状态或外部系统。 |
| 谁消费？ | 指向具体代码路径、接口或处理端。 |
| 什么时候生效？ | 保存后、下一次消息、下一次 route 启动、页面刷新，还是点击后立即生效。 |
| 有什么副作用？ | 是否写日志、投递 Agent、外发平台、更新记忆、创建任务、启动进程。 |
| 如何验收？ | 给出可复现检查方式，优先复用现有模块、日志和测试入口。 |
| UI 放哪里？ | route 字段归路由页，role 字段归人格页，runtime 状态归总览 / 日志页。 |

## 搜索关键词

- 人格 / persona / role / `agentRoleId`：看人格绑定、人格正文、人格自动化、计划、记忆、技能。
- 自动化 / automationRules / route kind / schedule / run_script：看人格自动化、RouteDecision、Heartbeat 和脚本运行时。
- QQ / NapCat / OneBot：看 QQ 消息端、QQ route kind、Outbox QQ 回复。
- RabiLink / Relay / Rokid：看 RabiLink 本地兼容入口、Relay worker、RabiLink 回复。
- WeCom / 企业微信：看企业微信消息端、Outbox 回传。
- Codex / Copilot / AstrBot / Marvis：看 Agent adapter。
- 回复 / 外发 / draft / approval：看 Outbox / Reply、Pipeline presets。
- 记忆 / 计划 / 技能 / viewedAt / consolidation：看 Role Knowledge。
- replay / logs / delivery：看日志、回放、Runtime log。
