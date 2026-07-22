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
| Forwarding | 遍历 active routeProfiles，写日志，构造 packet，调用 Agent adapter | 平台协议细节、UI 表单逻辑 | `src/forwarding.ts` |
| AgentPacket | 生成处理端最终收到的消息、replyContext、上下文和接口说明 | 决定 route 是否命中、替代 Agent 读取计划/任务或自动完成业务状态回写、外发消息 | `src/routing/agentPacket.ts` |
| Agent Adapter | 把 AgentPacket 投给 Codex、Copilot、AstrBot、Marvis 等处理端 | 定义路由语义、直接写外部平台、依赖桌面宿主 | `src/agentAdapters/*`、`src/codexRuntime.ts`、`src/codexAppServerClient.ts`、`src/copilotCli.ts`、`src/marvis.ts` |
| Outbox / Reply | 接收 Agent 回传，按 pipeline 决定草稿、阻止、审批或外发 | 让处理端绕过 RabiRoute 写平台 | `src/outbox.ts` |
| Manager 控制面 | 管配置、进程、扫描、状态、WebGUI 静态资源和 HTTP API | 具体平台实时消息处理 | `src/manager/*`、`src/manager.ts` |
| WebGUI | 展示和编辑配置、状态、日志和人格规则 | 成为配置唯一真源 | `ribiwebgui/src/*` |
| Role Knowledge | 管角色计划、记忆、技能和上下文快照 | 决定消息是否路由命中 | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/controlPlaneRoutes.ts` |

## 功能索引

| 功能 | 当前状态 | 真源 / 数据 | 消费点 | 生效时机 | 副作用 | 入口 | 关键代码 | 文档 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| route 配置 | 已有 | `data/route/<configName>/adapterConfig.json` | manager 启动 gateway、`config.ts` 环境变量 | 保存配置并重启 / 同步 runtime 后 | 写配置文件，可能启停子进程 | WebGUI 路由页、`POST /gateways` | `src/manager/configRepository.ts`、`src/shared/gatewayConfigModel.ts` | `docs/routing-configuration.md` |
| 人格绑定 | 已有，route 固定绑定 | `adapterConfig.json.agentRoleId`、`agentRoleFile` | `rolePathsForRoute(route)`、AgentPacket | 下一次 gateway 配置生效后 | 影响 AgentPacket 的人格路径和角色数据目录 | WebGUI 人格页 / 路由页 | `src/config.ts`、`src/shared/routePaths.ts` | `docs/routing-and-personas.md` |
| 人格正文 | 已有 | `data/roles/<RoleId>/persona.md` | AgentPacket 注入人格路径，WebGUI 预览 | 下一次投递或页面刷新 | 无直接外发 | WebGUI 人格页、打开文件 | `src/routing/agentPacket.ts`、`ribiwebgui/src/pages/PersonaTemplatePage.vue` | `docs/routing-and-personas.md` |
| 人格头像 | 已有 | `personaConfig.json.avatar` 指向人格目录内 PNG/JPEG/WebP/GIF | Manager 读取并通过受限图片 API 提供给 WebGUI；Qt 从既有 RoleContext 仓库读取同一配置事实 | 上传、移除或页面刷新后 | 内容寻址写入新图片并原子切换配置，成功后清理旧托管头像；不改变 Agent 语义 | 人格页、快速配置、Route 总览、语音页、角色面板 | `src/personaAvatar.ts`、`src/manager/personaAvatarRoutes.ts`、`ribiwebgui/src/components/PersonaAvatar.vue` | `docs/routing-and-personas.md` |
| 消息模板规则 | 已有 | `data/roles/<RoleId>/personaConfig.json.notificationRules` | `createRouteDecision`、heartbeat schedules、AgentPacket template | 下一次消息 / heartbeat / manual trigger | 可能导致投递 Agent | WebGUI 人格页 | `src/manager/configRepository.ts`、`src/routing/routeDecision.ts` | `docs/persona-route-workbench-plan.md` |
| 分消息端最近上下文 | 已有 | `personaConfig.json.recentMessageLimits` | AgentPacket 读取当前人格、逻辑消息端和会话的双向记录 | 下一次 AgentPacket 构造 | 11 个消息端分别限制 `0–200`，默认 `100`；`0` 只关自动注入，不停止记录 | WebGUI 人格页滑条 + 精确数字输入 | `src/shared/gatewayConfigModel.ts`、`src/routing/agentPacket.ts` | `docs/agent-context-injection.md` |
| 人格级统一双向会话账本 | 已有 | `data/roles/<RoleId>/conversation/current.jsonl` | AgentPacket 自动上下文、Agent 显式查证 | 入站记录、成功 Outbox/处理端回传时 | 双向合计占额度；附件只保存安全元数据；归档为 `archive/<n>~<m>.jsonl` + `index.json` | 人格页与 AgentPacket 路径 | `src/messageContextStore.ts`、`src/messageContext.ts` | `docs/agent-context-injection.md` |
| ASR 热投递 / 关键词唤醒 | 已有 | Route `adapterConfig.json.speechPushMode`；人格 `personaConfig.json.speechTriggerKeywords` | RabiPC 语音消息端 | 每段 ASR 转写完成后 | `hot` 每段立即投递；`keyword` 始终先记录，只在命中人格名/唤醒词时投递；空关键词永不回退热投递 | Route 页“热投递”开关；人格页关键词 | `src/routing/speechPushPolicy.ts`、`src/index.ts` | `docs/rabispeech-plugin.md` |
| 配置归一化 | 已有 | `GatewayDefinition`、`RouteProfileDefinition` | manager 读写配置、WebGUI 保存 | 读写配置时 | 可能自动补默认值、分配端口 | manager API | `src/shared/gatewayConfigModel.ts` | `docs/code-architecture.md` |
| Manager 控制面 | 已有 | `data/manager.json`、runtime registry | WebGUI、远端 API、子进程管理 | manager 启动和 API 调用时 | 启停子进程、写配置 | `npm run manager`、`src/manager.ts` | `src/manager/controlPlaneRoutes.ts`、`src/manager/runtimeRegistry.ts` | `docs/windows-launcher-and-packaging.md` |
| WebGUI | 已有 | manager HTTP API | 用户配置和排障 | 页面加载 / 用户操作时 | 调用 manager API，可能写配置或触发动作 | `ribiwebgui` | `ribiwebgui/src/router.ts`、`ribiwebgui/src/stores/gatewayStore.ts` | `docs/code-architecture.md` |
| WebGUI 中英切换与使用手册 | 已有 | 浏览器 `rabiroute:webgui:locale`、人工词库、`docs/user-guide/*.md` | 导航、表单、状态、诊断和用户手册 | 用户切换语言或页面重渲染时 | 只改变界面展示和 `<html lang>`，不写项目配置 | 顶栏 `中 / EN`、`/#/docs` | `ribiwebgui/src/i18n/*`、`LocaleSwitcher.vue`、`ProjectDocsPage.vue` | `docs/user-guide/README.md` |
| QQ / NapCat 消息端 | 已验证，含一键恢复 | NapCat WS / HTTP、route config、`group-messages.jsonl`、`private-messages.jsonl` | forwarding、Outbox QQ 发送 | 收到 QQ 事件时；或用户点击“打开 NapCat”时 | 写消息日志，可能投递 Agent；合并转发通过 `get_forward_msg` 展开；Outbox 在 `replyToSource=true` 时生成真实 QQ 引用回复；明确点击后可启动绑定实例、请求已有 quick login、修复 OneBot 配置并打开已鉴权 WebUI；验证码和设备验证仍由用户完成 | route 消息端、路由页“打开 NapCat”、NapCat 管理 API | `src/adapters/napcatAdapter.ts`、`src/napcat.ts`、`src/napcatForwardMessages.ts`、`src/messageEndpoints/napcatManager.ts` | `docs/napcat-unattended.md` |
| QQ route kind 判断 | 已有 | OneBot event、回复链日志 | `forwardMessage(routeKind, record)` | 收到群消息时 | 影响规则匹配 | NapCat adapter | `src/adapters/napcatAdapter.ts` | `docs/routing-and-personas.md` |
| Webhook / XiaoAi / FenneNote 旧兼容 | 实验支持 / 退役兼容 | HTTP payload、`voice-transcripts.jsonl` | forwarding、设备回调、可选 RabiLink record-first 观察 | HTTP callback 到达时 | 写转写日志；FenneNote 不再提供新增 UI，只在旧 Route 存在时兼容 | webhook 端口 / 路径、Route 变量 | `src/adapters/webhookAdapter.ts`、`src/rabilinkObservationRecorder.ts`、`src/messageEndpoints/webhookLikeScans.ts` | `docs/voice-interaction-workstation.md` |
| 眼镜端（经 RabiLink） | 实验支持，内部兼容键 `rabilink` | 眼镜 observation、`rabilink-voice-transcripts.jsonl`、`rabilink-replies.jsonl` | forwarding、眼镜下行回复 | 眼镜消息到达；或本地调试 POST `/rabilink` | 写兼容消息 / 回复日志，按 route 规则决定是否投递 Agent | route 消息端“眼镜端（经 RabiLink）”、`/rabilink`、`/rabilink/replies` | `src/adapters/rabilinkAdapter.ts`、`src/adapters/rabilinkReplies.ts`、`src/adapters/rabilinkRelayWorker.ts` | `docs/rabilink-relay-server.md` |
| 智能手表 / 手环健康消息端 | 实验支持，内部键 `wearable` | Relay `wearable.health` observation、Health Connect 或受信 ADB bridge | 角色健康时间线、Manager health API、`wearable_health_alert` | 手机/桥上报真实样本时；Agent 查询时 | 健康样本去重并分日落盘；普通样本不唤醒 Agent，规则命中才投递；秘钥字段被丢弃 | route 消息端、`/api/roles/:roleId/health/*` | `src/adapters/wearableAdapter.ts`、`src/wearableHealth.ts`、`src/manager/wearableHealthRoute.ts` | `docs/rabilink-wearable-health.md` |
| RabiLink 系统转接服务 | 实验支持（内部契约已测试） | 全局开关、Relay URL / 应用 token / device id、远程 WebGUI / 语音 / observation 队列 | Manager 常驻连接、远程 WebGUI、语音 API、眼镜端和后续系统扩展 | Manager 启动且全局开关开启后 | Manager 登记 PC 并中转各类系统请求；本身不决定 route，也不拥有 Agent | `data/Config.json` 全局 RabiLink 配置、控制台 Rabi 实例、Relay scripts | `src/manager/rabiLinkRelayRuntime.ts`、`scripts/rabilink-relay-server.mjs` | `docs/rabilink-relay-server.md` |
| RabiSpeech TTS / ASR 服务 | 实验支持，同步直接 API + RabiPC 语音消息端 + 动态模型发现 + 会议说话人分离 + 按日语音记录 + 24 小时 TTS 音频缓存 + 性能报告 | 本机 `plugin-adapters/rabi-speech/config.json`、provider registry、环境变量密钥、人格 `voice/voice-profile.json` 与 `voice/cache/tts-audio/`、共用 `output/speaker-profiles.json`、主机级 `output/playback-settings.json`、RabiSpeech 私有 fallback/模型缓存和 worker；主机拥有麦克风、ASR/VAD 与切句，Route 只拥有语音订阅、热/关键词投递与回复播放策略 | WebGUI 选人格直接 TTS、录音转写、统一设置主机麦克风/ASR/VAD 和 `0–100` 播放音量、查看持久化 ASR/TTS 双向记录与 TTS 安全相对缓存路径/预计过期时间；任意 Route 开启语音消息端后常驻监听，每段 ASR 广播给所有订阅 Route，各自决定是否唤醒 Agent；ASR 页用未知/已知折叠卡片预览每个说话人最近 10 句话并人工绑定，Agent 可通过原子接口标注同一资料库；不新增独立会议栏 | 本地 Provider 默认可用；外部 API Provider 与 RabiLink 语音中转分别显式启用 | `/api/speech/messages` 省略 `routeId` 时广播并返回每个 Route 的 `deliveries[]` 终态；显式 `routeId` 仅保留给调试/兼容调用。关闭一个订阅不停止麦克风，最后一个关闭才停止；播放统一进入 SoundFile / PortAudio FIFO | `/v1/models`、`/v1/records`、`/v1/speaker-profiles`、`/v1/speaker-identities`、`/v1/microphone/settings`、`/v1/playback/settings`、`/v1/audio/*`、`/api/speech/*`、`/#/speech` | `plugin-adapters/rabi-speech/`、`src/manager/speechControl.ts`、`src/routing/speechPushPolicy.ts`、`ribiwebgui/src/pages/SpeechServicePage.vue` | `docs/user-guide/speech-api.md`、`docs/rabispeech-plugin.md`、`docs/rabispeech-performance-report.md` |
| Rabi 局域网语音客户端 | 实验支持 | RabiSpeech 私有 `remote_audio` 配置、独立音频流密钥和当前音频流选择 | 会议室电脑只作为远程麦克风/喇叭，持续传 PCM、接收 WAV；独立 GUI 维护主机连接、设备选择、实时电平与采集/播放状态；主机继续执行 VAD、切句、ASR、TTS、FIFO 和 Route 广播 | RabiSpeech 启用 `remote_audio`，GUI 通过 UDP 自动发现或指定地址，并用 Bearer 密钥连接 TCP WebSocket；无人值守可用 `--headless` | 默认本机；远程断线不自动回退；RabiLink 独立且不是局域网连接前置配置 | 客户端 GUI；语音服务页顶部“音频流类型” | `plugin-adapters/rabi-speech/rabispeech/remote_audio.py`、`desktop/rabi-voice-client/` | `desktop/rabi-voice-client/README.md` |
| RabiLink 眼镜云日志 | 已有 | AIUI/设备诊断批次、应用 token、设备/版本/会话元数据 | Relay 管理账号日志中心 | 眼镜前台运行并产生诊断事件时异步入队；断网恢复后补传 | 客户端与服务端双重脱敏，按账号持久化并按设备/来源/级别查询；不采集 ASR、Agent 正文或无权限的系统全局日志 | `POST /api/rabilink/devices/logs`、`GET /manage/api/device-logs` | `scripts/rabilink-device-log-store.mjs`、`scripts/rabilink-relay-server.mjs`、`apps/rabilink-aiui/pages/home/index.ink` | `docs/rabilink-relay-server.md` |
| RabiLink 手机边缘通讯枢纽 | 首版契约 | 应用 token、设备身份、设备独立 cursor、目标/展示信封 | Android companion、未来 Wear OS / 耳机适配器 | 用户连接 Relay；设备按自己的生命周期显式读写 | 手机承担网络、状态和外设扇出，不拥有 Agent/账本；Relay 按设备 ID/类别过滤广播并越过不可见消息 | `/api/rabilink/devices/input`、`/api/rabilink/devices/messages`、Android `RabiRouteSdk` | `scripts/rabilink-relay-server.mjs`、`packages/android-sdk/rabiroute-sdk/`、`apps/rabilink-android/` | `docs/rabilink-phone-edge-hub.md` |
| RabiLink 统一会话账本与审阅器 | 已有 | `rabilink-conversation.jsonl`、审阅 cursor、route review variables | 固定 Codex 线程、空闲审阅、周期反思、触摸板 turn steer | 新 observation 稳定后、线程空闲时、周期到期或眼镜请求立即审阅时 | 原子推进 cursor；可把显式白名单内的常驻转写源归一为 observation；可能唤醒或 steer Codex；不在 ASR 请求内同步等待 | 角色目录运行数据；`examples/data/route/RabiLink/` 提供脱敏配置模板 | `src/rabilinkConversationLedger.ts`、`src/rabilinkObservationRecorder.ts`、`src/rabilinkConversationReviewer.ts` | `docs/rabilink-relay-server.md` |
| 企业微信消息端 | 实验支持 | WeCom SDK frame、route config、`wecom-messages.jsonl` | forwarding、Outbox WeCom 回复 | WebSocket 收到消息时 | 写消息日志，可能投递 Agent | route 消息端 | `src/adapters/wecomAdapter.ts`、`src/wecom.ts`、`src/messageEndpoints/wecomManager.ts` | `docs/wecom-integration.md` |
| Heartbeat | 已验证 | `notificationRules[].schedules`、`heartbeatSkipWhenAgentBusy`、heartbeat config | forwarding、AgentPacket、Codex active 状态 | 定时器触发时 | 写 heartbeat 日志；开关启用且 Codex 会话工作中时记为 `skipped/agent_busy`，不投递 Agent | route 启用 heartbeat；路由配置页可勾选忙碌跳过 | `src/adapters/heartbeatAdapter.ts`、`src/scheduling/heartbeatSchedules.ts`、`src/forwarding.ts`、`src/codexRuntime.ts` | `docs/configuration.md` |
| Manual trigger | 已验证，真实投递 | manager request、`manual-trigger-events.jsonl` | `triggerManualRule`、forwarding | 用户点击 / API 调用时 | 写手动触发日志、router 日志、replay ledger，可能投递 Agent | `POST /gateways/:id/manual-trigger` | `src/manualTrigger.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| Role panel message | 已验证，真实投递 | `data/roles/<RoleId>/role-panel/messages.jsonl` | role panel 子进程、forwarding | 用户在角色面板发送时 | 写 timeline，可能投递 Agent | `POST /api/role-panel/messages` | `src/rolePanelTimeline.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/routing-and-personas.md` |
| RouteDecision | 已有 | route profile、event record、extra values | forwarding、未来 preview | 每次投递时 | 本身无写入；调用方可能写日志 | 代码内部 | `src/routing/routeDecision.ts` | `docs/persona-route-workbench-plan.md` |
| Forwarding | 已有 | active routeProfiles、record、extra values | Agent adapter、history、delivery replay | 每次真实消息进入时 | 写 router log、role record、codex notification、replay ledger，可能投递 Agent | `forwardMessage` / `forwardMessageAndWait` | `src/forwarding.ts` | `docs/code-architecture.md` |
| AgentPacket | 已有 | RouteDecision、role paths、logs、role knowledge | Agent adapter | 命中规则后 | 会触发 roleKnowledgeSnapshot，可能刷新记忆 viewedAt；只有显式 memory-consolidation 触发才评估并创建待整理 run | 代码内部；preview 仍未实现 | `src/routing/agentPacket.ts`、`src/roleKnowledge.ts` | `docs/agent-context-injection.md` |
| Codex adapter | 已验证，正式主链为 Desktop owner | route agent config、Desktop 任务状态、精确任务 ID 与工作目录 | Codex Desktop IPC | 每次已匹配的普通消息/AgentPacket 投递时 | 直接尝试 steer 当前活跃 turn，无活跃 turn 则 start；不设普通消息忙碌跳过开关。Heartbeat 可由 `heartbeatSkipWhenAgentBusy` 例外跳过，语音可由热/关键词策略决定是否唤醒 | route Agent 端 | `src/codexDesktopBridge.ts`、`src/codexRuntime.ts` | `docs/code-architecture.md` |
| Rabi Codex Context 插件 | 0.3 统一触发版本 | 真实 Codex session ID、显式 RoleId 绑定、Rabi Manager 角色配置 | Codex `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` Hook，以及 RabiRoute `message_delivery` | 插件已安装、Hook 已信任且当前 session 显式绑定时；消息投递不依赖插件 | 入口注入受限人格与轻量索引，推理期只注入本 turn 新命中的必读路径；未绑定会话无输出，不复制角色知识或触发策略 | `[rabi:use <RoleId>]` 等严格控制标记；Rabi PC 也可按完整 session ID 主动绑定 | `src/context/rabiContextManager.ts`、`plugins/rabi-codex-context/`、`.agents/plugins/marketplace.json` | `docs/rabi-codex-context-plugin.md` |
| Agent Codex 任务桥 | 已有 | Desktop 任务状态、已配置的 `codexCwd`、Agent 请求 | 后台 Agent、Codex Desktop | Agent 调用 `/api/agent/threads` 时 | 查询/读取 Desktop 任务，受控创建空任务，并把实际消息交给 Desktop owner | `POST /api/agent/threads` | `src/agentThreads.ts`、`src/codexRuntime.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| Copilot CLI adapter | 实验支持 | route agent config、Copilot CLI | Copilot CLI | AgentPacket 投递时 | 启动 / 调用 CLI | route Agent 端 | `src/copilotCli.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| AstrBot adapter | 实验支持 | AstrBot dashboard / plugin API | AstrBot | AgentPacket 投递时 | 调用 AstrBot API | route Agent 端 | `src/agentAdapters/astrbotAdapter.ts`、`scripts/rabiroute_agent/` | `docs/code-architecture.md` |
| Marvis adapter | 人工接力 | Marvis 本地能力 | Marvis | AgentPacket 投递时 | 写 prompt、复制剪贴板、打开应用；不能保证后台会话注入 | route Agent 端 | `src/marvis.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| Outbox / Reply | 已有 | Agent reply request、replyContext、pipeline、`proactive` | QQ / WeCom / RabiLink / role panel 等回传 | Agent、定时器或规划器调用 `/api/agent/replies` 时 | 可能写 draft、阻止、外发、写回复日志；NapCat 群聊按 `messageId + replyToSource` 自动绑定源消息，本地群文件校验 `allowedFileRoots` 后走 `upload_group_file`；RabiLink 文本可无前置 task 主动入队 | `POST /api/agent/replies` | `src/outbox.ts`、`src/napcat.ts` | `docs/rabi-agent-interfaces.md` |
| Pipeline presets | 已有 | route `pipelinePreset` / `pipeline` | AgentPacket、Outbox | route 配置生效后 | 影响输出模式和自动回复策略 | route 配置页 | `src/pipelines.ts` | `docs/pipeline-presets.md` |
| 计划 | 已有 | `data/roles/<RoleId>/plans` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 可通过 API 创建 / 更新计划 | `/api/roles/:roleId/plans` | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/plan-and-memory-model.md` |
| 近期记忆 | 已有 | `data/roles/<RoleId>/memory/recent` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 读取命中项会刷新 viewedAt；更新会刷新 updatedAt/viewedAt | `/api/roles/:roleId/memory/recent` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 沉淀记忆 | 已有 | `data/roles/<RoleId>/memory/consolidated` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 命中必读项会刷新 viewedAt | `/api/roles/:roleId/memory/consolidated` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 记忆整理 | 已有 | `memory/consolidation-runs` | AgentPacket、Agent 回传 API | 显式 `memory-consolidation` 手动触发或 Manager API request | 创建 run；提交 result 后标记 recent memory 并写 consolidated memory | `/api/roles/:roleId/memory/consolidation-*` | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoute.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/plan-and-memory-model.md` |
| 角色技能 | 已有 | `data/roles/<RoleId>/skills/*.md` | roleKnowledgeSnapshot、AgentPacket 技能索引 | AgentPacket 构造时 | 一般只读 | `/api/roles/:roleId/skills` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| Runtime log | 已有 | runtime stdout/stderr、adapter logs | WebGUI 日志页、排障 | 运行时持续产生 | 只读展示 | WebGUI 日志诊断 | `src/manager/runtimeRegistry.ts`、`ribiwebgui/src/pages/RuntimeLogPage.vue` | `docs/troubleshooting.md` |
| Delivery replay | 已有 | `delivery-replay-ledger.jsonl` | replay API / manager child process | 投递后记录，用户触发 replay 时重放 | replay 会再次进入真实投递链路 | `/gateways/:id/delivery-replay` | `src/deliveryReplay.ts`、`src/deliveryReplayLedger.ts` | `docs/troubleshooting.md` |
| Remote Agent | 实验支持 | remote-agent devices / tasks | 远端设备、manager API | 设备连接 / 任务创建 / 事件回报时 | 创建任务、接收任务事件，完成后可投递回本地 Agent | `/api/remote-agent/*` | `src/messageEndpoints/remoteAgentManager.ts` | `docs/rabi-agent-interfaces.md` |
| Rabi 多实例 API | 已有 | `manager.json`、runtime identity | 远端 / 多实例控制面 | API 调用时 | 代理其它实例的 routes / binding / replies | `/api/rabi/*` | `src/manager/rabiApi.ts` | `docs/rabi-agent-interfaces.md` |
| Windows 托盘 | 已有 | manager HTTP API、打包资源 | Windows 桌面入口 | 用户启动托盘时 | 启动 / 退出 manager，显示任务窗口 | `Start-RabiRoute-Tray.bat`、托盘 exe | `desktop/tray-task-window/`、`scripts/build-tray-exe.ps1` | `docs/windows-launcher-and-packaging.md` |
| 示例数据 | 已有 | `examples/data/` | 初次初始化、公开示例 | 首次无 data 目录时可复制 | 只默认启用 `main`；其他接入模板保持禁用；不应包含真实账号和 token | 仓库示例 | `examples/data/roles`、`examples/data/route` | `examples/data/README.md` |
| 项目内 Skills | 已有 | `skills/` | Codex / Agent 开发指南 | Agent 读取 skill 时 | 无运行时副作用 | 仓库文件 | `skills/*/SKILL.md` | `skills/create-rabiroute-persona/SKILL.md` |
| 人格路由工作台预览 | 拟新增 | route profile + simulated record | dry-run RouteDecision / AgentPacket / roleKnowledge | 用户点击生成预览时 | 必须无副作用：不投递 Agent、不写日志、不刷新 viewedAt | 未来人格页 | `docs/persona-route-workbench-plan.md` | `docs/persona-route-workbench-plan.md` |

## 边界规则

- 没有“智能命中人格”。route 通过 `agentRoleId` 固定绑定人格；`createRouteDecision` 只在当前 route profile 的 `notificationRules` 内匹配规则。
- 真实投递会遍历 gateway 子进程里的 active routeProfiles；如果某个 UI 只选定单 route，就只能称为“单 route profile 试算”。
- 消息端和 Agent 端配置归 route：真源是 `adapterConfig.json`。
- 人格正文、模板规则、计划、记忆和技能归 role：真源是 `data/roles/<RoleId>/`。
- WebGUI 不是配置事实源。前端负责表单和展示，配置不变量应落在 `src/shared/gatewayConfigModel.ts` 或 manager 后端。
- WebGUI locale 只是浏览器 UI 偏好。route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据不翻译；使用手册按语言读取 `docs/user-guide/` 对应文件。
- 预览能力目前是拟新增设计，应走后端 dry-run，不能调用 `forwardMessageAndWait`。
- 真实外发必须经过 Outbox / Action Gate。处理端不要绕过 RabiRoute 直接写 QQ、WeCom、RabiLink 或外部系统。
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
| 人格配置 | `data/roles/<RoleId>/personaConfig.json` | manager / WebGUI | 可选 `avatar`、notification rules、`speechTriggerKeywords`、`recentMessageLimits` |
| 人格声线与 TTS 缓存 | `data/roles/<RoleId>/voice/voice-profile.json`、`voice/cache/tts-audio/` | 用户 / RabiSpeech | TTS 模型、声线、语言、表达配置与按文件时间戳保留 24 小时的可重建成品音频；界面只显示安全相对路径 |
| 当前双向会话 | `data/roles/<RoleId>/conversation/current.jsonl` | forwarding、Outbox、各消息端/Manager 旁路 | 当前人格的完整入站/出站证据；无条数上限，自动注入只读本文件 |
| 会话归档 | `data/roles/<RoleId>/conversation/archive/<n>~<m>.jsonl`、`index.json` | `messageContextStore` | 存在超过 72 小时记录时，归档连续前缀中超过 24 小时的完整记录；保留供显式查证 |
| 人格正文 | `data/roles/<RoleId>/persona.md` | 用户 / 示例数据 | Agent 人格说明 |
| 群消息 | `group-messages.jsonl` | NapCat adapter、forwarding role dir copy | 来源协议审计与 CQ 引用链兼容；自动最近上下文以统一双向账本为准 |
| 私聊消息 | `private-messages.jsonl` | NapCat adapter、forwarding role dir copy | 来源协议审计与 CQ 引用链兼容；自动最近上下文以统一双向账本为准 |
| 语音转写 | `voice-transcripts.jsonl`、`rabilink-voice-transcripts.jsonl` | webhook / RabiLink 兼容 adapter | 语音入口事件与旧链路调试记录 |
| RabiLink 统一会话 | `data/roles/<RoleId>/rabilink-conversation.jsonl` 及审阅 cursor | RabiLink Relay worker、conversation ledger / reviewer、Outbox | AIUI observation、Agent 主动下行、空闲审阅与恢复 |
| 企业微信消息 | `wecom-messages.jsonl` | WeCom adapter | 企业微信入口事件 |
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
| 改规则匹配 | `src/routing/routeDecision.ts`、`src/shared/gatewayConfigModel.ts` | 不要在 adapter 或前端复制匹配逻辑 |
| 改 Agent 收到的消息 | `src/routing/agentPacket.ts`、`docs/agent-context-injection.md` | 不要在消息端拼 prompt；具体业务闭环应由对应人格或处理端 Skill 定义，不要硬编码到所有 AgentPacket |
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

- 人格 / persona / role / `agentRoleId`：看人格绑定、人格正文、消息模板规则、计划、记忆、技能。
- 规则 / route kind / notificationRules：看消息模板规则、RouteDecision、Heartbeat。
- QQ / NapCat / OneBot：看 QQ 消息端、QQ route kind、Outbox QQ 回复。
- RabiLink / Relay / Rokid：看 RabiLink 本地兼容入口、Relay worker、RabiLink 回复。
- WeCom / 企业微信：看企业微信消息端、Outbox 回传。
- Codex / Copilot / AstrBot / Marvis：看 Agent adapter。
- 回复 / 外发 / draft / approval：看 Outbox / Reply、Pipeline presets。
- 记忆 / 计划 / 技能 / viewedAt / consolidation：看 Role Knowledge。
- replay / logs / delivery：看日志、回放、Runtime log。
