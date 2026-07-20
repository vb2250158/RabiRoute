<!-- docs-language-switch -->
<div align="center">
<a href="./current-capabilities_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 当前能力与成熟度

本文描述 RabiRoute `0.1.10` 代码中实际存在的能力，不把需求稿、设计稿或外部设备设想当成已完成功能。结论来自配置 Schema、运行入口、Manager API、WebGUI、适配器实现和测试；2026-07-17 在本仓库运行 `npm test`，197 个测试全部通过。

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

| 入口 | 状态 | 实际边界 |
| --- | --- | --- |
| NapCat / OneBot | 已验证 | Gateway 子进程通过 WebSocket 接收 QQ 群聊和私聊；Manager 可扫描、添加、启动、重启、移除和修复多个 NapCat 实例；OneBot HTTP 用于状态查询和外发；合并转发消息会展开为文本/媒体证据。 |
| Heartbeat | 已验证 | Gateway 子进程产生内部定时事件；规则支持间隔、时间窗口、每天指定时间和单次指定时间；可选在固定 Codex 线程忙碌时跳过。 |
| 角色面板 | 已验证 | Manager/托盘提供的内置本地入口，不是独立网络 listener；使用固定 `role_panel_message` 规则，记录写入角色目录的 timeline。 |
| Manual trigger | 已验证 | Manager API 和日志诊断页可真实触发 `manual_trigger` 或 heartbeat 规则；它不是消息适配器。 |
| Remote Agent | 实验支持 | Manager 作为 v3 出站控制端扫描并连接远端 bridge，使用密码挑战握手，支持任务、事件和双向文件；Gateway 子进程只显示占位状态，不另开 listener。 |
| RabiSpeech 语音消息端 | 实验支持 | RabiSpeech 服务常驻麦克风、本地 ASR、可选 Route 投递、人格 TTS 与主机 FIFO；RabiPC 顶部 TTS/ASR 标签管理。 |
| FenneNote | 已退役兼容 | 不再出现在新增消息端或新规则 UI；只读取旧 Route，并保留历史 webhook/Outbox 兼容以便迁移。 |
| 小米音箱 / 小爱 | 实验支持 | RabiRoute 提供命名回调入口和 PC 侧桥接目录，但必须依赖 open-xiaoai、xiaogpt 或自定义桥把音箱事件送到 PC；不是音箱直连核心。 |
| RabiLink | 实验支持 | 同时存在本地兼容入口、全局 Relay Runtime 和 Route worker；AIUI observation 可 record-first 写入统一账本，审阅器在 Codex 空闲/周期/触摸板唤醒时处理；主动消息走独立 Relay 下行流。外部 AIUI、手机和穿戴设备仍需真机验收。 |
| 智能手表 / 手环健康消息端 | 实验支持 | `wearable.health` 结构化观测进入按角色分日的健康时间线；Manager 可查询当前状态、历史和摘要，阈值/冷却命中后以 `wearable_health_alert` 投递 Agent。Android 可选 Health Connect 或 PC ADB Companion；后者已按手机配置在小米真机闭环心率、睡眠会话、阶段和睡/醒状态，并安装登录后常驻任务。无需 ADB 的 MiWear SPP 直连仍未作为默认采集器。 |
| 通用 Webhook | 实验支持 | 接收没有专用适配器的外部 POST；已有命名平台应使用自己的适配器，以保留日志和回传语义。 |
| 企业微信 / WeCom | 实验支持 | 使用 `@wecom/aibot-node-sdk` 的智能机器人 WebSocket 长连接，支持群消息进入和 Outbox 回发；需要真实 Bot ID/Secret 验证。 |

`disabled` 只是兼容配置值，不是一个消息入口。

## 路由与上下文

- 一条 route 可以配置多个消息适配器、每适配器输入/输出 policy、多个 Agent adapter、pipeline、工作目录和人格绑定。
- 路由规则保存在人格的 `personaConfig.json` 中，并按 `configName` 绑定到 route。无人格 route 会生成默认规则；角色面板规则始终存在。
- 当前 route kind：`private`、`group_message`、`direct_at`、`direct_reply`、`indirect_reply`、`heartbeat`、`manual_trigger`、`role_panel_message`、`voice_transcript`、`rabilink`、`wearable_health_alert`、`wecom_message`。
- `RouteDecision` 只负责规则匹配；`forwarding.ts` 遍历 active route profile、写审计并投递每一条命中规则。
- `AgentPacket` 会注入事件、最近消息、角色与相对路径、计划/记忆/技能索引、必要读取项、日志路径、回复 API 和 `replyContext`。技能正文不会被无条件塞入每次消息。
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

当前没有通用、持久化、可在 WebGUI 审批的 Action Queue。`draft` 是 Outbox 的结果和审计状态，不应写成已经完成的统一审批中心。

## Manager 与 WebGUI

- Manager 默认在 `http://127.0.0.1:8790/` 提供 RibiWebGUI 和 HTTP API，管理 route 配置、子进程生命周期、扫描、日志和全局设置。
- WebGUI 当前有：控制台、消息适配器、Rabi 人格、日志诊断、使用手册五类页面；快速配置向导可以选择消息入口、处理端和人格。
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
- 命中记忆会按统一策略刷新 `viewedAt`；同一 turn 的相同条目修订不会重复刷新。只有显式 `memory-consolidation` 手动触发或 Manager API request 才会创建整理 run，提交结果后才标记输入并写入沉淀记忆；当前没有仅凭时间流逝自动启动的后台整理调度器。
- Codex 插件只转发 lifecycle 事件和注入 Manager 返回值，不拥有绑定、触发策略或知识副本。内部 `preview` 策略无副作用，但当前仍没有 WebGUI 预览界面。
- 运行记录以 JSONL 为主，包括消息、适配器日志、AgentPacket、Outbox、heartbeat、manual trigger、role panel、RabiLink conversation、按角色的 wearable health 时间线和 delivery replay。
- 运行期 `data/`、日志、token、真实账号、真实群号和 Cookie 不应进入仓库。

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
