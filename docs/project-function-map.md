# RabiRoute 项目功能手册

本文是 RabiRoute 的通用项目功能手册。它面向产品设计、GUI 改造、代码维护、排障和新 Agent 交接，不只服务某一个页面或某一次需求。

配套搜索页在 RibiWebGUI 内：左侧栏底部 `GitHub` 按钮下面点击 `项目文档`，或访问 `/#/docs`。该页面随 WebGUI 一起构建和部署，RabiLink 远程 WebGUI 访问时也能使用。

## 使用方式

- 想知道某个能力归谁管：先看“功能索引”。
- 想设计新 UI：先看“边界规则”和对应功能的“真源 / 消费点 / 生效时机 / 副作用”。
- 想改代码：先看“分层地图”和“常见修改入口”。
- 想排障：先看“运行数据与日志”。
- 想确认功能是不是已有：打开 WebGUI 的 `项目文档` 页面搜索，优先查“当前状态”和“入口”。

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

## 分层地图

| 层 | 负责 | 不负责 | 关键代码 |
| --- | --- | --- | --- |
| Message Adapter | 接入 QQ、Webhook、RabiLink、WeCom、heartbeat、role panel 等入口，把外部事件转成内部 record | 拼 Agent prompt、决定处理端如何回答 | `src/adapters/*` |
| Event Store | 写 JSONL 事件、adapter 日志、投递日志、回放 ledger | 做业务判断、替代数据库事务 | `src/history.ts`、`src/deliveryReplayLedger.ts` |
| RouteDecision | 在单个 route profile 内判断规则是否命中 | 选择人格、读取记忆、投递 Agent | `src/routing/routeDecision.ts` |
| Forwarding | 遍历 active routeProfiles，写日志，构造 packet，调用 Agent adapter | 平台协议细节、UI 表单逻辑 | `src/forwarding.ts` |
| AgentPacket | 生成处理端最终收到的消息、replyContext、上下文和接口说明 | 决定 route 是否命中、替代 Agent 读取计划/任务或自动完成业务状态回写、外发消息 | `src/routing/agentPacket.ts` |
| Agent Adapter | 把 AgentPacket 投给 Codex、Copilot、AstrBot、Marvis 等处理端 | 定义路由语义、直接写外部平台 | `src/agentAdapters/*`、`src/codexDesktopIpc.ts`、`src/copilotCli.ts`、`src/marvis.ts` |
| Outbox / Reply | 接收 Agent 回传，按 pipeline 决定草稿、阻止、审批或外发 | 让处理端绕过 RabiRoute 写平台 | `src/outbox.ts` |
| Manager 控制面 | 管配置、进程、扫描、状态、WebGUI 静态资源和 HTTP API | 具体平台实时消息处理 | `src/manager/*`、`src/manager.ts` |
| WebGUI | 展示和编辑配置、状态、日志和人格规则 | 成为配置唯一真源 | `ribiwebgui/src/*` |
| Role Knowledge | 管角色计划、记忆、技能和上下文快照 | 决定消息是否路由命中 | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoutes.ts` |

## 功能索引

| 功能 | 当前状态 | 真源 / 数据 | 消费点 | 生效时机 | 副作用 | 入口 | 关键代码 | 文档 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| route 配置 | 已有 | `data/route/<configName>/adapterConfig.json` | manager 启动 gateway、`config.ts` 环境变量 | 保存配置并重启 / 同步 runtime 后 | 写配置文件，可能启停子进程 | WebGUI 路由页、`POST /gateways` | `src/manager/configRepository.ts`、`src/shared/gatewayConfigModel.ts` | `docs/routing-configuration.md` |
| 人格绑定 | 已有，route 固定绑定 | `adapterConfig.json.agentRoleId`、`agentRoleFile` | `rolePathsForRoute(route)`、AgentPacket | 下一次 gateway 配置生效后 | 影响 AgentPacket 的人格路径和角色数据目录 | WebGUI 人格页 / 路由页 | `src/config.ts`、`src/shared/routePaths.ts` | `docs/routing-and-personas.md` |
| 人格正文 | 已有 | `data/roles/<RoleId>/persona.md` | AgentPacket 注入人格路径，WebGUI 预览 | 下一次投递或页面刷新 | 无直接外发 | WebGUI 人格页、打开文件 | `src/routing/agentPacket.ts`、`ribiwebgui/src/pages/PersonaTemplatePage.vue` | `docs/routing-and-personas.md` |
| 消息模板规则 | 已有 | `data/roles/<RoleId>/personaConfig.json.notificationRules` | `createRouteDecision`、heartbeat schedules、AgentPacket template | 下一次消息 / heartbeat / manual trigger | 可能导致投递 Agent | WebGUI 人格页 | `src/manager/configRepository.ts`、`src/routing/routeDecision.ts` | `docs/persona-route-workbench-plan.md` |
| 最近消息注入数量 | 已有 | `personaConfig.json.recentMessageLimit` | AgentPacket 读取最近消息 | 下一次 AgentPacket 构造 | 影响上下文长度 | WebGUI 后续可补控件 | `src/routing/agentPacket.ts` | `docs/agent-context-injection.md` |
| 配置归一化 | 已有 | `GatewayDefinition`、`RouteProfileDefinition` | manager 读写配置、WebGUI 保存 | 读写配置时 | 可能自动补默认值、分配端口 | manager API | `src/shared/gatewayConfigModel.ts` | `docs/code-architecture.md` |
| Manager 控制面 | 已有 | `data/manager.json`、runtime registry | WebGUI、远端 API、子进程管理 | manager 启动和 API 调用时 | 启停子进程、写配置 | `npm run manager`、`src/manager.ts` | `src/manager/controlPlaneRoutes.ts`、`src/manager/runtimeRegistry.ts` | `docs/windows-launcher-and-packaging.md` |
| WebGUI | 已有 | manager HTTP API | 用户配置和排障 | 页面加载 / 用户操作时 | 调用 manager API，可能写配置或触发动作 | `ribiwebgui` | `ribiwebgui/src/router.ts`、`ribiwebgui/src/stores/gatewayStore.ts` | `docs/code-architecture.md` |
| QQ / NapCat 消息端 | 已有 | NapCat WS / HTTP、route config、`group-messages.jsonl`、`private-messages.jsonl` | forwarding、Outbox QQ 发送 | 收到 QQ 事件时 | 写消息日志，可能投递 Agent；合并转发通过 `get_forward_msg` 展开；Outbox 在 `replyToSource=true` 时生成真实 QQ 引用回复；`/ping` 可能直接回复 | route 消息端、NapCat 管理 API | `src/adapters/napcatAdapter.ts`、`src/napcat.ts`、`src/napcatForwardMessages.ts`、`src/messageEndpoints/napcatManager.ts` | `docs/napcat-unattended.md` |
| QQ route kind 判断 | 已有 | OneBot event、回复链日志 | `forwardMessage(routeKind, record)` | 收到群消息时 | 影响规则匹配 | NapCat adapter | `src/adapters/napcatAdapter.ts` | `docs/routing-and-personas.md` |
| Webhook / FenneNote / XiaoAi | 已有 | HTTP payload、`voice-transcripts.jsonl` | forwarding、语音工作站 | HTTP callback 到达时 | 写转写日志，可能投递 Agent | webhook 端口 / 路径 | `src/adapters/webhookAdapter.ts`、`src/messageEndpoints/webhookLikeScans.ts` | `docs/voice-interaction-workstation.md` |
| RabiLink 本地兼容入口 | 已有 | HTTP payload、`rabilink-voice-transcripts.jsonl`、`rabilink-replies.jsonl` | forwarding、RabiLink 下行回复查询 | 本地调试 POST `/rabilink` 或 relay worker 转交任务时 | 写消息 / 回复日志，可能投递 Agent | `/rabilink`、`/rabilink/replies`；公网主链路走 Relay worker | `src/adapters/rabilinkAdapter.ts`、`src/adapters/rabilinkReplies.ts` | `docs/rabilink-relay-server.md` |
| RabiLink Relay worker | 已有 | Relay URL / 应用 token / device id、relay tasks | RabiLink PC worker、WebGUI 远程代理 | gateway 启动且 relay 启用后 | 轮询云端、转发本地 WebGUI 请求、回传回复 | 全局 RabiLink 配置、relay scripts | `src/adapters/rabilinkRelayWorker.ts`、`scripts/rabilink-relay-server.mjs` | `docs/rabilink-relay-server.md` |
| 企业微信消息端 | 已有 | WeCom SDK frame、route config、`wecom-messages.jsonl` | forwarding、Outbox WeCom 回复 | WebSocket 收到消息时 | 写消息日志，可能投递 Agent | route 消息端 | `src/adapters/wecomAdapter.ts`、`src/wecom.ts`、`src/messageEndpoints/wecomManager.ts` | `docs/wecom-integration.md` |
| Heartbeat | 已有 | `notificationRules[].schedules`、`heartbeatSkipWhenAgentBusy`、heartbeat config | forwarding、AgentPacket、Codex active 状态 | 定时器触发时 | 写 heartbeat 日志；开关启用且 Codex 会话工作中时记为 `skipped/agent_busy`，不投递 Agent | route 启用 heartbeat；路由配置页可勾选忙碌跳过 | `src/adapters/heartbeatAdapter.ts`、`src/scheduling/heartbeatSchedules.ts`、`src/forwarding.ts`、`src/codexDesktopIpc.ts` | `docs/configuration.md` |
| Manual trigger | 已有，真实投递 | manager request、`manual-trigger-events.jsonl` | `triggerManualRule`、forwarding | 用户点击 / API 调用时 | 写手动触发日志、router 日志、replay ledger，可能投递 Agent | `POST /gateways/:id/manual-trigger` | `src/manualTrigger.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| Role panel message | 已有，真实投递 | `data/roles/<RoleId>/role-panel/messages.jsonl` | role panel 子进程、forwarding | 用户在角色面板发送时 | 写 timeline，可能投递 Agent | `POST /api/role-panel/messages` | `src/rolePanelTimeline.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/routing-and-personas.md` |
| RouteDecision | 已有 | route profile、event record、extra values | forwarding、未来 preview | 每次投递时 | 本身无写入；调用方可能写日志 | 代码内部 | `src/routing/routeDecision.ts` | `docs/persona-route-workbench-plan.md` |
| Forwarding | 已有 | active routeProfiles、record、extra values | Agent adapter、history、delivery replay | 每次真实消息进入时 | 写 router log、role record、codex notification、replay ledger，可能投递 Agent | `forwardMessage` / `forwardMessageAndWait` | `src/forwarding.ts` | `docs/code-architecture.md` |
| AgentPacket | 已有 | RouteDecision、role paths、logs、role knowledge | Agent adapter | 命中规则后 | 会触发 roleKnowledgeSnapshot，可能刷新记忆 viewedAt 或创建待整理记忆 | 代码内部；拟新增 preview | `src/routing/agentPacket.ts`、`src/roleKnowledge.ts` | `docs/agent-context-injection.md` |
| Codex adapter | 已有 | route agent config、Codex IPC / app server | Codex Desktop | AgentPacket 投递时 | 向 Codex 线程 start / steer | route Agent 端 | `src/codexDesktopIpc.ts`、`src/codexApp.ts` | `docs/code-architecture.md` |
| Agent Codex 线程桥 | 已有 | Codex session index、已配置的 `codexCwd`、Agent 请求 | 后台 Agent、Codex app-server | Agent 调用 `/api/agent/threads` 时 | 查询/读取正式线程，或在受控工作区创建线程、启动后续 turn；默认 workspace-write，Windows 1312 可显式 danger-full-access 恢复 | `POST /api/agent/threads` | `src/agentThreads.ts`、`src/codexApp.ts`、`src/manager/controlPlaneRoutes.ts` | `docs/rabi-agent-interfaces.md` |
| Copilot CLI adapter | 已有 | route agent config、Copilot CLI | Copilot CLI | AgentPacket 投递时 | 启动 / 调用 CLI | route Agent 端 | `src/copilotCli.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| AstrBot adapter | 已有 | AstrBot dashboard / plugin API | AstrBot | AgentPacket 投递时 | 调用 AstrBot API | route Agent 端 | `src/agentAdapters/astrbotAdapter.ts`、`scripts/rabiroute_agent/` | `docs/code-architecture.md` |
| Marvis adapter | 已有 | Marvis 本地能力 | Marvis | AgentPacket 投递时 | 打开 / 投递到 Marvis | route Agent 端 | `src/marvis.ts`、`src/agentAdapters/managerApi.ts` | `docs/code-architecture.md` |
| Outbox / Reply | 已有 | Agent reply request、replyContext、pipeline | QQ / WeCom / RabiLink / role panel 等回传 | Agent 调用 `/api/agent/replies` 时 | 可能写 draft、阻止、外发、写回复日志；NapCat 群聊按 `messageId + replyToSource` 自动绑定源消息且避免重复 reply 段 | `POST /api/agent/replies` | `src/outbox.ts` | `docs/rabi-agent-interfaces.md` |
| Pipeline presets | 已有 | route `pipelinePreset` / `pipeline` | AgentPacket、Outbox | route 配置生效后 | 影响输出模式和自动回复策略 | route 配置页 | `src/pipelines.ts` | `docs/pipeline-presets.md` |
| 计划 | 已有 | `data/roles/<RoleId>/plans` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 可通过 API 创建 / 更新计划 | `/api/roles/:roleId/plans` | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoutes.ts` | `docs/plan-and-memory-model.md` |
| 近期记忆 | 已有 | `data/roles/<RoleId>/memory/recent` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 读取命中项会刷新 viewedAt；更新会刷新 updatedAt/viewedAt | `/api/roles/:roleId/memory/recent` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 沉淀记忆 | 已有 | `data/roles/<RoleId>/memory/consolidated` | roleKnowledgeSnapshot、Agent 接口 | AgentPacket 构造或 API 调用时 | 命中必读项会刷新 viewedAt | `/api/roles/:roleId/memory/consolidated` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| 记忆整理 | 已有 | `memory/consolidation-runs` | AgentPacket、Agent 回传 API | manual memory consolidation 或 snapshot 需要时 | 创建 run、归档 recent memory、写 consolidated memory | `/api/roles/:roleId/memory/consolidation-*` | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoutes.ts` | `docs/plan-and-memory-model.md` |
| 角色技能 | 已有 | `data/roles/<RoleId>/skills/*.md` | roleKnowledgeSnapshot、AgentPacket 技能索引 | AgentPacket 构造时 | 一般只读 | `/api/roles/:roleId/skills` | `src/roleKnowledge.ts` | `docs/plan-and-memory-model.md` |
| Runtime log | 已有 | runtime stdout/stderr、adapter logs | WebGUI 日志页、排障 | 运行时持续产生 | 只读展示 | WebGUI 日志诊断 | `src/manager/runtimeRegistry.ts`、`ribiwebgui/src/pages/RuntimeLogPage.vue` | `docs/troubleshooting.md` |
| Delivery replay | 已有 | `delivery-replay-ledger.jsonl` | replay API / manager child process | 投递后记录，用户触发 replay 时重放 | replay 会再次进入真实投递链路 | `/gateways/:id/delivery-replay` | `src/deliveryReplay.ts`、`src/deliveryReplayLedger.ts` | `docs/troubleshooting.md` |
| Remote Agent | 已有 | remote-agent devices / tasks | 远端设备、manager API | 设备连接 / 任务创建 / 事件回报时 | 创建任务、接收任务事件，完成后可投递回本地 Agent | `/api/remote-agent/*` | `src/messageEndpoints/remoteAgentManager.ts` | `docs/rabi-agent-interfaces.md` |
| Rabi 多实例 API | 已有 | `manager.json`、runtime identity | 远端 / 多实例控制面 | API 调用时 | 代理其它实例的 routes / binding / replies | `/api/rabi/*` | `src/manager/rabiApi.ts` | `docs/rabi-agent-interfaces.md` |
| Windows 托盘 | 已有 | manager HTTP API、打包资源 | Windows 桌面入口 | 用户启动托盘时 | 启动 / 退出 manager，显示任务窗口 | `Start-RabiRoute-Tray.bat`、托盘 exe | `desktop/tray-task-window/`、`scripts/build-tray-exe.ps1` | `docs/windows-launcher-and-packaging.md` |
| 示例数据 | 已有 | `examples/data/` | 初次初始化、公开示例 | 首次无 data 目录时可复制 | 不应包含真实账号和 token | 仓库示例 | `examples/data/roles`、`examples/data/route` | `examples/data/README.md` |
| 项目内 Skills | 已有 | `skills/` | Codex / Agent 开发指南 | Agent 读取 skill 时 | 无运行时副作用 | 仓库文件 | `skills/*/SKILL.md` | `skills/create-rabiroute-persona/SKILL.md` |
| 人格路由工作台预览 | 拟新增 | route profile + simulated record | dry-run RouteDecision / AgentPacket / roleKnowledge | 用户点击生成预览时 | 必须无副作用：不投递 Agent、不写日志、不刷新 viewedAt | 未来人格页 | `docs/persona-route-workbench-plan.md` | `docs/persona-route-workbench-plan.md` |

## 边界规则

- 没有“智能命中人格”。route 通过 `agentRoleId` 固定绑定人格；`createRouteDecision` 只在当前 route profile 的 `notificationRules` 内匹配规则。
- 真实投递会遍历 gateway 子进程里的 active routeProfiles；如果某个 UI 只选定单 route，就只能称为“单 route profile 试算”。
- 消息端和 Agent 端配置归 route：真源是 `adapterConfig.json`。
- 人格正文、模板规则、计划、记忆和技能归 role：真源是 `data/roles/<RoleId>/`。
- WebGUI 不是配置事实源。前端负责表单和展示，配置不变量应落在 `src/shared/gatewayConfigModel.ts` 或 manager 后端。
- 预览能力目前是拟新增设计，应走后端 dry-run，不能调用 `forwardMessageAndWait`。
- 真实外发必须经过 Outbox / Action Gate。处理端不要绕过 RabiRoute 直接写 QQ、WeCom、RabiLink 或外部系统。
- 运行期 `data/`、日志、token、真实账号、真实 QQ 群号和 Cookie 不进仓库。

## 运行数据与日志

| 数据 | 路径 | 写入者 | 用途 |
| --- | --- | --- | --- |
| route 配置 | `data/route/<configName>/adapterConfig.json` | manager 配置保存 | Gateway 启动和运行配置 |
| 人格配置 | `data/roles/<RoleId>/personaConfig.json` | manager / WebGUI | notification rules、recent message limit |
| 人格正文 | `data/roles/<RoleId>/persona.md` | 用户 / 示例数据 | Agent 人格说明 |
| 群消息 | `group-messages.jsonl` | NapCat adapter、forwarding role dir copy | 最近消息、审计、AgentPacket |
| 私聊消息 | `private-messages.jsonl` | NapCat adapter、forwarding role dir copy | 最近消息、审计、AgentPacket |
| 语音转写 | `voice-transcripts.jsonl`、`rabilink-voice-transcripts.jsonl` | webhook / RabiLink adapter | 语音入口事件 |
| 企业微信消息 | `wecom-messages.jsonl` | WeCom adapter | 企业微信入口事件 |
| 心跳事件 | `heartbeat-events.jsonl` | heartbeat adapter、forwarding role dir copy | 定时触发记录 |
| 手动触发事件 | `manual-trigger-events.jsonl` | manual trigger | 手动测试 / 触发记录 |
| 投递通知 | `codex-notifications.jsonl` | forwarding | AgentPacket 投递审计 |
| replay ledger | `delivery-replay-ledger.jsonl` | forwarding | 失败回放、投递复盘 |
| adapter 日志 | `*-adapter.log.jsonl` | adapters / forwarding | 排障 |
| RabiLink 回复 | `rabilink-replies.jsonl` | Outbox / RabiLink reply path | RabiLink 下行查询和 relay worker |
| role panel timeline | `data/roles/<RoleId>/role-panel/messages.jsonl` | role panel API / outbox | WebGUI 角色面板会话 |

## 常见修改入口

| 需求 | 优先看 | 注意 |
| --- | --- | --- |
| 新增消息入口 | `src/adapters/<name>Adapter.ts`、`src/adapters/messageAdapter.ts`、`src/index.ts`、`src/shared/gatewayConfigModel.ts` | 不要塞进 NapCat adapter；route kind 和配置 normalize 要补齐 |
| 新增处理端 | `src/agentAdapters/types.ts`、`src/agentAdapters/agentAdapter.ts`、`src/agentAdapters/managerApi.ts` | Agent adapter 只投递 AgentPacket，不定义路由语义 |
| 改规则匹配 | `src/routing/routeDecision.ts`、`src/shared/gatewayConfigModel.ts` | 不要在 adapter 或前端复制匹配逻辑 |
| 改 Agent 收到的消息 | `src/routing/agentPacket.ts`、`docs/agent-context-injection.md` | 不要在消息端拼 prompt；具体业务闭环应由对应人格或处理端 Skill 定义，不要硬编码到所有 AgentPacket |
| 改人格规则 GUI | `ribiwebgui/src/pages/PersonaTemplatePage.vue`、`ribiwebgui/src/stores/gatewayStore.ts`、`src/manager/configRepository.ts` | 人格规则写回 `personaConfig.json`，route 字段仍归 `adapterConfig.json` |
| 改 route GUI | `ribiwebgui/src/pages/RouteConfigPage.vue`、`src/shared/gatewayConfigModel.ts` | 不变量放 shared model |
| 改 Outbox / 回传 | `src/outbox.ts`、`src/pipelines.ts`、`docs/rabi-agent-interfaces.md` | 外部写入必须保留 action gate |
| 改计划 / 记忆 / 技能 | `src/roleKnowledge.ts`、`src/manager/roleKnowledgeRoutes.ts` | 注意 viewedAt / consolidation run 的副作用 |
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
