<!-- docs-language-switch -->
<div align="center">
<a href="./configuration_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 配置与接入

> 状态：现行指南。字段和成熟度以当前配置模型、Manager API 和扫描结果为准。

## OpenAI / Codex 术语边界

RabiRoute 配置把 provider、agent、transport、host 和 model 分开表达，避免桌面产品名称变化再次污染运行时配置：

| 概念 | 当前含义 | 是否写进 adapter id |
| --- | --- | --- |
| provider | OpenAI 提供的账号、服务和模型能力 | 否 |
| agent / runtime | Desktop 管理的 Codex 负责任务、turn、工具调用和执行 | 是，稳定 id 为 `codex` |
| transport | Codex Desktop IPC | 否，由 `codex` adapter 管理 |
| host / owner | Codex/ChatGPT Desktop，拥有用户可见任务和实际轮次 | 否，但它是 Codex 投递的必需依赖 |
| model | 目标 Desktop 任务实际选择的模型 | 否 |

Codex 已并入新的 ChatGPT desktop，但 Codex 仍是 Agent 和 runtime 的名称。不要把 adapter 改名为 `chatgpt`。RabiRoute 的正式投递协议是 Desktop IPC；app-server 只保留短生命周期元数据用途，不进入真实消息主链。

## 路由配置

运行期配置现在按文件夹拆在 `data/route` 和 `data/roles`：

- `data/route/<配置名>/adapterConfig.json`：消息端、端口、Agent 端、工作目录、指向人格。
- `data/roles/<角色名>/persona.md`：人格正文。
- `data/roles/<角色名>/personaConfig.json`：人格自动化规则、语音唤醒关键词和各消息端最近上下文额度。一个人格可以服务多个路由配置。

如果运行期 data 不存在，manager 会优先复制整包 `examples/data`，让默认 Rabi 路由与 RabiLink 主动智能模板一起落地。只有 `main` 默认启用；其他接入均以禁用模板出现，填写凭据、工作目录并检查端口后再逐条启用。`examples/data` 不是运行依赖；缺少 examples 时，manager 也能创建最小 QQ / NapCat 到 Codex 配置。RabiLink 模板不包含 Relay 地址或 token，仍需在本机全局设置中显式配置并开启连接。

```json
{
  "enabled": true,
  "messageAdapters": ["napcat", "heartbeat"],
  "messageAdapterPolicies": {
    "napcat": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"],
      "allowedFileRoots": ["C:/Path/To/Your/Project/ReleasePkg"],
      "messageGrouping": {
        "settleSeconds": 6,
        "incompleteSettleSeconds": 12,
        "maxWaitSeconds": 20
      }
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ 消息监听",
  "codexCwd": "C:/Path/To/Your/Project",
  "codexPlanAssistantEnabled": false,
  "codexPlanAssistantModel": "gpt-5.6-terra",
  "codexPlanAssistantSessions": [],
  "codexMemoryConsolidationAgentEnabled": false,
  "codexMemoryConsolidationAgentModel": "gpt-5.6-terra",
  "codexHooks": {
    "sessionContextEnabled": true,
    "reasoningContextEnabled": true,
    "planTaskCompletionEnabled": true
  },
  "agentModel": "gpt-5.6-terra",
  "agentReasoningEffort": "high",
  "agentAdapters": ["codex"],
  "primaryAgentAdapter": "codex",
  "messageProcessingAgents": {
    "codex": {
      "enabled": true,
      "model": "gpt-5.6-luna",
      "reasoningEffort": "medium",
      "maxAgents": 4
    }
  },
  "heartbeatSkipWhenAgentBusy": true,
  "personaAutomationScriptsEnabled": false,
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

重要字段：

- `messageAdapters`：可配置消息入口列表。支持 `napcat`、`remoteAgent`、`heartbeat`、`speech`、`webhook`、`fennenote`、`xiaoai`、`rabilink`、`wearable`、`wecom`、`weixin`、`feishu`；旧配置中的 `rolePanel` 仍兼容，但 WebGUI 不再把它显示为可配置消息端，因为角色面板消息由 Manager 默认提供，Gateway 子进程不另开 listener。
- `personaAutomationScriptsEnabled`：当前 Route 是否允许人格自动化运行本机脚本，默认关闭。它是本机权限，不写入人格目录，也不会随人格同步到其它电脑；收到消息和定时触发的脚本动作都受同一个开关约束。
- `messageAdapterPolicies`：每个消息端的管道级权限。`inputEnabled` 控制是否接收，`outputEnabled` 控制是否允许出站。QQ、微信、飞书、企业微信、角色面板和 RabiLink 文字聊天默认使用消息组，不提供关闭开关；可用 `messageGrouping` 的三个秒数调整普通停顿、疑似半句话停顿和最长等待，默认 `6 / 12 / 20` 秒。ASR / 语音转写、heartbeat、命令、审批、健康告警和结构化事件照常直接投递，不进入这段等待。只有 Codex Agent 同时开启消息处理模式时，聊天消息才交给消息处理 Agent；否则保持原有逐条路由。
- `supportedOutputs`：这个消息端允许发送的消息类型。NapCat/OneBot 当前支持 `text`、`image`、`voice`、`file`；旧的纯文本 `text/message/content` 请求仍兼容。QQ 群本地文件使用 `upload_group_file`，不是把大文件伪装成普通文本或普通消息段。
- `allowedFileRoots`：本地文件出站白名单目录，仅在 `payloadType=file` 且使用本地路径时生效。文件必须真实存在、是普通文件，并且解析真实路径后仍位于其中一个目录内；未配置时本地群文件上传会被阻止。公开示例只能使用占位路径，运行期按角色实际构建产物目录配置。
- `gatewayPort`：NapCat WebSocket Client 连接的端口。
- `napcatHttpUrl`：RabiRoute 调用的 OneBot HTTP 服务地址。多个 Route 可以明确共用同一个 NapCat 实例和同一个 HTTP 地址；自动端口分配只处理 RabiRoute 自己监听的端口，不会把已经配置的 NapCat 地址改到一个未启动的端口。
- `webhookPort`：Webhook 监听端口。未配置时回退到 `gatewayPort`。
- `webhookPath`：Webhook 入口路径，默认 `/webhook`。
- `rabiLinkWebhookPort` / `rabiLinkWebhookPath`：RabiLink 本地兼容入口端口和路径，默认路径 `/rabilink`。局域网脚本或手工调试可直接 POST 到这里；正式 AIUI 链路由电脑端 RabiLink worker 直连公网 Relay，接收 observation 输入并消费独立的主动下行队列。
- `data/Config.json` 里的 `rabiGuid`：这台 Rabi PC 的稳定身份。服务器远程 WebGUI 使用 `/manage/<账号>/<RabiGUID>/` 定位 PC；旧 `/webgui` 子路径只作兼容。显示名和 `deviceId` 只用于展示、兼容和任务领取。
- `data/Config.json` 里的 `rabiLinkRelay`：这台 Rabi PC 的全局 Relay 连接配置，包含全局开关 `enabled`，以及 `url`、`token`、`deviceId`、`replyIdleTimeoutMs`。应用 token 在服务器 Relay WebGUI `/manage` 里创建；开启全局开关后，Manager 会常驻订阅 `/api/rabilink/events`，收到事件后即时领取远程 WebGUI、语音或任务，不依赖任何单条路由启动；同时订阅本机 Manager `/api/events`，把非 `ready` 事件转发到 Relay 的远程 WebGUI SSE。远程附件、下载和媒体 Range 仍走同一个受限 WebGUI 请求通道。旧配置中的 `claimWaitMs` 只为 Schema 兼容保留，不再控制轮询。服务器应用自身仍可禁用，PC 开关与服务器应用必须同时启用才会接收输入和发布下行消息。
- `data/Config.json` 里的 `webguiLan`：本机 Manager 的局域网 WebGUI 开关与访问密钥。默认 `enabled=false`，Manager 只监听 `127.0.0.1`；在本机控制台启用后会自动生成 32 字节随机访问密钥，重启 Manager 后监听 `0.0.0.0`。局域网 URL 使用 `http://<本机局域网IP>:8790/#/overview?webgui_token=<密钥>`；浏览器读取后只在当前会话保存密钥并从地址栏移除。开关、生成和轮换密钥只允许来自运行 Manager 的本机请求，包括回环地址和本机自己的局域网地址；其他设备仍被拒绝，轮换后旧链接立即失效。
- 旧版 `adapterConfig.json` 里的 `rabiLinkRelayEnabled` / `rabiLinkRelayUrl` / `rabiLinkRelayToken` / `rabiLinkRelayDeviceId` 仍兼容读取；新配置应放在全局 `data/Config.json`，路由消息端只保存监听端口、路径和是否启用。
- `routeVariables.rabilinkAutoReview` / `rabilinkContinuousReflection`：分别控制新 observation 的空闲审阅和无新输入时的周期反思。配套的 `rabilinkReviewIntervalMs`、`rabilinkReviewSettleMs`、`rabilinkReflectionIntervalMinutes`、`rabilinkConversationSplitAfterHours` 控制检查频率、输入稳定窗口、反思间隔和会话切分。`rabilinkRecordFirstSources` 是可选的逗号分隔消息源白名单，例如 `fennenote`；把对应消息端放在承载 `RabiActive` 的同一条 Route 后，命中的 FenneNote/Webhook 转写只进入同一 RabiLink 账本和审阅器，不逐句直接投递 Agent。该列表默认留空，持续录音源必须显式启用；不要让另一条直投 Route 同时消费同一个 webhook。可直接参考 `examples/data/route/RabiLink/` 与 `examples/data/roles/RabiActive/`；示例不包含 Relay 地址或 token。
- `wecomBotId` / `wecomBotSecret` / `wecomWsUrl`：企业微信智能机器人 WebSocket 长连接配置。`wecomWsUrl` 可选；公开示例只能使用占位值，真实 secret 建议走 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` / `WECOM_WS_URL` 环境变量。
- `weixinBaseUrl` / `weixinBotType`：个人微信 OpenClaw/iLink 实验原型配置；默认分别为 `https://ilinkai.weixin.qq.com` 和 `3`，也可用 `WEIXIN_BASE_URL` / `WEIXIN_BOT_TYPE` 覆盖。扫码得到的 token、同步游标、账号标识和会话 context token 只以受保护密文保存在运行期 `data/`，不得写入公开配置、示例或日志。
- `feishuAppId` / `feishuAppSecret` / `feishuVerificationToken` / `feishuEncryptKey`：飞书企业自建应用的独立凭据。`feishuWebhookPort` / `feishuWebhookPath` 配置本机回调；只有平台侧 HTTPS 回调和 `im.message.receive_v1` 已完成配置后，才设置 `feishuEventSubscriptionEnabled: true`。群机器人 Webhook 不能替代这些字段；详见 [飞书独立消息端接入](feishu-integration.md)。
- `napcatHttpUrl`：OneBot HTTP API 地址。
- `agentAdapters`：Agent 端适配器列表。当前支持 `codex`、`copilotCli`、`astrbot`、`marvis`、`dsh`。成熟度分别是：Codex 已验证；Copilot CLI、AstrBot、DSH 实验支持；Marvis 仅人工接力。
- `dshSessionId` / `dshSessionName` / `dshCwd` / `dshBaseUrl`：DSH（DeepSeek Harness）投递绑定。DSH 会话必须先在 DSH WebGUI 中创建，再把完整 `session-<uuid>` 填入；RabiRoute 通过 `POST /api/session.prompt` 的 queue 模式投递到该会话。未填写显示名时默认使用 `DSH CottonGame Luna Max`。RabiRoute 不创建、重命名或归档 DSH 会话；该适配器当前只承担消息投递，消息处理 Agent、计划协助、记忆整理和 Hook 仍由 Codex 管理。
- `primaryAgentAdapter`：当前 Route 的主控 Agent，必须是 `agentAdapters` 中的一项。消息命中规则后只投递给主控，不会广播给列表里的其他 Agent。旧配置没有该字段时使用列表第一项；删除主控后自动改用仍存在的第一项。
- Agent 端先使用基础能力层描述安装、认证、项目、会话和投递，再按真实支持情况声明托管任务扩展。当前只有 Codex 声明“消息处理 Agent 模式”“独立记忆整理 Agent”“计划协助会话”和“Hook 管理”；WebGUI 只在 Codex 卡片显示，读取非 Codex Route 时也会丢弃这些误配。以后能力等同的处理端可以逐项声明并复用相应界面；自带 Agent 编排的平台不需要声明。
- `messageProcessingAgents.codex`：Codex 消息处理 Agent 的调度资格、独立模型和任务数量上限。它只在当前主控 Agent 为 Codex 时生效；主控切到 DSH 或其他 Agent 后，普通消息直接投递给所选主控，不会创建、复用或续投 Codex 消息处理任务。Codex 仍可作为非主控 Agent 接收显式 Agent-to-Agent 投递。默认关闭；开启后，聊天消息默认形成消息组并按不同话题复用或动态创建消息处理任务，ASR 和结构化事件照常直接投递。Agent 列表、上限截取和实际投递共用同一套权重顺序：依次考虑引用的 Agent 外发消息、原消息组、消息端、会话、说话人和最近使用时间，同分时才使用固定序号。`maxAgents` 可选，范围 `1–32`；留空时保持按忙碌情况动态扩容，达到上限后继续复用排序范围内的任务，不再新建。设为 `1` 时固定保留并复用“`<人格名> 协助处理消息1`”，即使该任务仍在运行也把新消息补充给它。降低上限只解除超额任务与当前 Route 的消息处理池关联，不删除 Desktop 任务；已完成记录仍保留原处理者用于审计，未完成的计划进展通知、计划/记忆回调、Agent 间待回复请求和提醒会迁移到当前排序选中的任务，不会重新唤醒已解绑或已归档的旧任务。`heartbeat` 是持续进行的同一项巡检职责：第一次选择或创建一个消息处理任务，此后的定时触发始终补充到最近处理 heartbeat 的同一任务。未设置上限且只有 1 个任务时命名为“`<人格名> 协助处理消息`”，扩展到多个时依次改为“`<人格名> 协助处理消息1`”“…消息2”；改名保留原 Desktop 任务 ID 和 workspace。普通调度只把 Codex 当前明确为 `idle` 的任务当作空闲候选；`notLoaded` 表示已有任务尚未加载，会复用并由正常 Desktop 链路打开。Desktop 离线或状态不可读取时，消息组留在可恢复队列中重试，不创建替代任务。`agents.json` 只保存任务 ID、名称、workspace 和初始化信息；消息端/会话/说话人的熟悉度保存在独立的 `routing-affinity.json`，两者都不保存 active/idle 状态。默认模型与推理强度为 `gpt-5.6-luna` / `medium`，只影响消息处理轮次，不改主人格、秘书或计划 Agent。
- 关闭 `messageProcessingAgents.codex.enabled` 后，普通聊天恢复逐条投递给主人格；已关联消息组产生的计划进展通知、知识回调提醒和 Agent 间待回复也迁移到当前 Route 的主人格任务。旧消息处理任务和审计记录保留，但不会再因这些后续工作自动打开。
- 开启 `messageProcessingAgents.codex.enabled` 后，同一设置区域会显示消息处理看板。看板不是另一套统计：它读取 Manager 保存的消息发送需求，明确区分必须回复、由 Agent 判断、已转交、等待发送、等待审批、已发送、不需要回复和发送失败。直接 @、直接回复和私聊默认必须处理；普通群消息允许 Agent 主动参与讨论，也允许提交有原因的“不回复”。计划与来源消息完成结构化关联后，统一计划写入函数会在进展变化时生成通知需求，并复用原消息处理任务把结果发回来源群或私聊。看板通过 Manager 事件刷新，不定时扫描聊天或计划目录。
- `codexThreadId` / `codexThreadName`：下拉显示 Desktop 任务的名称和最后时间，内部保存完整任务 ID 与可见名称。有效且同工作目录的未归档 ID 是稳定身份；保存 ID 指向已归档任务时先复用同目录唯一最新的未归档同名任务，没有候选才要求恢复/重选，且绝不自动创建替代任务。用户明确输入新名称时前端会清空旧 ID，后端才按名称 + 目录完整查找。只有 RabiRoute 自己按稳定名称动态建立的消息处理任务使用 app-server 状态库的名称过滤，避免首次投递扫描完整任务目录；普通会话绑定仍保留完整查找。一个或多个同名同目录候选按最后更新时间绑定唯一最新者，零匹配时幂等创建，最大时间并列时要求选择。
- `codexCwd`：目标 Desktop 任务的项目目录。它用于校验已保存 ID、同名任务消歧和新建位置；选择已有任务时自动采用任务自己的目录。
- `codexMemoryConsolidationAgentEnabled`：是否把自动到点或手动发起的记忆沉淀交给独立 Codex Desktop 任务。默认关闭。关闭时仍按 72 小时自动触发，但由主人格处理；开启后任务名固定由主人格任务名派生为“`<主人格任务名> 记忆整理`”，主人格不再收到同一请求。独立任务投递失败时明确失败，不回退给主人格或备用 Runtime。
- `codexMemoryConsolidationAgentModel`：独立记忆整理 Agent 的模型，默认 `gpt-5.6-terra`。只影响该独立任务的新轮次，不改变主人格、消息处理 Agent、计划秘书或计划执行 Agent。
- `codexPlanAssistantEnabled`：是否启用当前 Route 的持久计划秘书。默认关闭；旧配置已经保存 `codexPlanAssistantSessions` 时按开启兼容读取。关闭后不再向人格提供秘书槽，也不再为这些任务自动套用秘书模型；已绑定任务仍保留，重新开启后继续复用。
- `codexPlanAssistantModel`：Manager 为当前 Route 的全部计划秘书统一选择的模型，默认 `gpt-5.6-terra`。WebGUI 只编辑这一处；秘书任务数组不再分别保存模型。旧配置若只在秘书条目里保存模型，读取时迁移为统一值，之后按统一配置运行和保存。调用方明确指定某一轮模型时仍尊重该选择。
- `codexPlanAssistantSessions`：当前 Route 精确绑定的持久计划管理秘书列表，只保存完整任务 ID、可见名称、workspace、槽位序号和初始化时间。该列表与启用开关、统一模型分开保存，关闭秘书或修改模型都不会删除绑定。1 个时命名为“`<主会话名> 协助处理计划`”；多个时命名为“`<主会话名> 协助处理计划1`”“…计划2”。从 1 个扩容时会把原任务改名为“…计划1”；缩容只从 Route 解绑多余任务，不删除 Desktop 任务。Manager 在计划的独立 `secretaryBinding` 中保存当前负责秘书；业务 `taskBinding` 始终只指向执行任务。秘书负责计划/记忆、业务任务查重与续投，禁止执行调查、实现、测试或修改业务文件。该多任务能力尚未完成真实 Desktop 纵向验收，当前按实验能力展示。
- `codexHooks.sessionContextEnabled`：默认 `true`。控制 `SessionStart` / `UserPromptSubmit`；打开、恢复、清空或压缩 Codex 任务，以及用户提交新消息时触发。
- `codexHooks.reasoningContextEnabled`：默认 `true`。控制 `PreToolUse` / `PostToolUse`；Codex 调用工具前后触发，只返回本轮新命中的计划、记忆或技能上下文。
- `codexHooks.planTaskCompletionEnabled`：默认 `true`。控制 `Stop` 完成提醒；绑定计划的执行任务输出本轮最终回答后触发。启用计划秘书且存在有效秘书任务时，Manager 直接投递给计划 `secretaryBinding` 指向的负责秘书，不写入主人格角色面板，也不默认唤醒主人格；未启用或没有可用秘书时才回退到原主人格链路。关闭只让 Manager 忽略或拒绝对应 Hook，不卸载或改写 Codex 插件 Hook。
- `codexHooks.agentCommunicationEnforcementEnabled`：WebGUI 显示为“强制使用 RabiAgent 消息投递接口”，默认 `true`，按 Route 保存。开启后，该 Route 的主人格、计划 Agent、计划秘书和消息处理 Agent 不能用 Codex 持久任务工具绕过 `/api/agent/threads`；`PreToolUse` 会在执行前拒绝并提示必须填写 `sourceThreadId`、`sourceAgentType` 和 `responsePolicy`。使用 `required` 时还要填写 `responseInstruction`；目标任务每轮结束仍未通过 Rabi 正式回复时，Manager 从该轮结束起五分钟后提醒。关闭只停止绕过检查，已经建立的待回复请求仍继续跟进。
- `copilotThreadName`：Copilot CLI 独立会话名。它不再复用 `codexThreadName`；旧的 Copilot-only 配置会在读取边界迁移一次并以新字段保存。
- `copilotCwd`：Copilot CLI 独立工作目录，不与 `codexCwd` 共享真源。
- `agentModel` / `agentReasoningEffort`：Manager 统一应用到当前 Route 主人格的 Codex Desktop 新轮次。模型留空时沿用目标 Desktop 任务当前设置；推理强度留空时也不覆盖 Desktop 设置。支持的推理强度为 `low`、`medium`、`high`、`xhigh`、`max`。这两个字段只控制主人格，不覆盖消息处理 Agent、计划秘书或独立计划执行 Agent 的设置。
- `heartbeatSkipWhenAgentBusy`：可选，默认 `false`。只在未启用 Codex 消息处理 Agent 模式时生效；启用消息处理 Agent 后，`heartbeat` 会立即交给独立消息处理任务，不因主人格任务忙碌而跳过。未启用消息处理 Agent 时，如果当前 Codex 固定任务仍处于 active / in-progress 状态，本次 `heartbeat` 会记录为 `skipped` 且原因是 `agent_busy`。群聊、私聊和其他消息类型不受影响。
- `speechPushMode`：Route 拥有的语音投递模式。`hot` 表示每段 ASR 完成后立即投递；`keyword` 表示转写仍全部记录，只在命中人格关键词时唤醒 Agent。WebGUI 中“热投递”开关的开对应 `hot`，关对应 `keyword`。
- `speechTriggerKeywords`：归人格 `personaConfig.json`，用于人格名、常用称呼和唤醒词。列表为空且 Route 关闭热投递时，ASR 只记录、永不暗中回退 `hot`。
- `automationRules`：归人格 `personaConfig.json`。每条规则先选择 `message` 或 `schedule` 触发，再选择 `deliver_agent` 或 `run_script` 动作。旧 `notificationRules` 和 heartbeat 内嵌 `schedules` 会在读取时转换，后续保存只写新结构。
- `recentMessageLimits`：归人格 `personaConfig.json`，分别配置 `napcat`、`remoteAgent`、`heartbeat`、`rolePanel`、`speech`、`fennenote`、`xiaoai`、`rabilink`、`wearable`、`webhook`、`wecom`、`weixin` 的自动注入条数。每项 `0–200`，未设置时默认 `12`；`0` 不删记录，只关自动注入。旧 `recentMessageLimit` 和显式分端值继续生效。
- `contextInjection`：归人格 `personaConfig.json`。默认 `{"mode":"focused","relevantKnowledgeLimit":3,"personaMaxChars":1600}`，只放高相关知识摘要和精简人格工作集；`mode=legacy` 可回滚到旧的全量活动索引。数值范围分别为 `1–12` 和 `800–6000`。
- `dataDir`：路由级协议记录、投递记录和心跳记录目录。人格级双向会话真源另位于 `data/roles/<RoleId>/conversation/`。
- `rolesDir`：人格目录，只放 `persona.md`、成长记录、提示词等角色文件。
- `configName`：路由配置文件夹名。
- `agentRoleId`：当前路由配置指向的人格文件夹名。
- 人格自动化规则不写在 `adapterConfig.json` 里。Manager 会按 `agentRoleId` 读取对应人格的 `personaConfig.json`。

最小示例：

```json
{
  "automationRules": [
    {
      "id": "private-agent",
      "name": "私聊交给 Agent",
      "trigger": { "type": "message", "routeKinds": ["private"] },
      "action": { "type": "deliver_agent", "template": "" }
    },
    {
      "id": "daily-check",
      "name": "每天检查",
      "trigger": {
        "type": "schedule",
        "schedule": { "id": "daily-check-time", "type": "daily_time", "timeOfDay": "09:00" }
      },
      "action": { "type": "run_script", "scriptPath": "daily-check.py", "timeoutSeconds": 300 }
    }
  ]
}
```

脚本路径只能指向当前人格的 `scripts/` 目录，支持 `.cmd`、`.bat` 和 `.py`。运行时不会继承 Manager 的 token、密码和消息正文；只保留启动脚本所需的系统环境变量，并增加 Route、规则、人格目录和脚本路径标识。脚本参数按字符串数组传入，超时范围为 5–3600 秒。同一 Route 的同一规则不会重叠运行，执行记录追加到本机 `automation-executions.jsonl`。

Windows 路径在 WebUI 里写 `C:\Path\To\Project` 或 `C:/Path/To/Project`；只有手写 JSON 文件时才需要把反斜杠转义成 `\\`。

## 消息适配端

当前可用：

- `napcat`：通过 OneBot WebSocket 接收 QQ 事件，通过 OneBot HTTP 预留主动调用能力。
- `heartbeat`：定时任务的兼容运行入口。人格自动化中的定时规则在本机时间到达时由它唤醒；动作可以通知 Agent，也可以在本机权限允许时运行人格脚本。通知 Agent 时仍遵守消息处理 Agent 和 `heartbeatSkipWhenAgentBusy` 的现有行为；脚本执行结果单独记录，不会被当成 Agent 投递成功。
- `rolePanel`：Manager/托盘默认提供的内置消息能力，本地面板和经过身份校验的跨人格投递共用固定 `role_panel_message` 规则与统一投递服务；它不显示在 WebGUI 的可配置消息端列表中，不是 Gateway 网络 listener，也不能从人格规则中删除。服务只在处理端接收后记录成功，失败记录只表示尝试。
- 计划审批不是另一个消息 adapter。Manager 在 feedback 审计记录后直接生成 `plan_feedback` 系统事件；启用计划秘书时，引导/审批正文直达业务 `taskBinding`，负责秘书同时收到控制面通知，主人格不再收到每次自动投递通知。业务绑定不完整时完整反馈优先交给负责秘书；只有未启用或没有可用秘书时才回退给主人格。该事件没有可配置最近消息额度，也不进入角色 timeline 或统一会话账本。
- `remoteAgent`：Manager 级实验入口。RabiGUI 扫描并连接远端 bridge，支持密码挑战、任务、事件和文件；Gateway 子进程只显示状态占位。
- `speech`：RabiPC / RabiSpeech 语音消息端。总开关同时控制当前 Route 的常驻录音；热投递开时每段 ASR 直接投递，关时仅命中人格关键词投递。无论是否唤醒，ASR 都保留；成功 TTS 回传与同 `sessionId` ASR 共用双向上下文。
- `wecom`：通过企业微信智能机器人 WebSocket 长连接接入企业微信群聊，写入 `wecom-messages.jsonl`，并允许 Agent 通过 RabiRoute outbox 回发到企业微信。它的群聊模板变量尽量对齐 NapCat 的 `groupId`、`userId`、`sender`、`message`、`messageId`，额外补充 `wecomReqId`、`wecomConversationId`、`wecomChatId` 等字段；详见 [企业微信接入](wecom-integration.md)。
- `weixin`：开发者级实验原型。Route 启动时先从安全存储恢复会话；WebGUI 分别显示“正在恢复、已恢复、暂时不可达但凭据保留、确实失效、从未登录”。只有确实失效或从未登录时，用户明确点击“生成登录二维码”才会访问二维码 API。网络超时、HTTP 5xx 和扫描超时不会清登录态；服务端 `-14` 或 HTTP 401/403 明确拒绝才进入需扫码状态。消息写入 `weixin-messages.jsonl`，但历史消息数量不代表当前登录。Outbox 仍只向已有 context token 的来源会话回复文本或受控文件；不能主动选择任意联系人，真实账号长期风险仍未验收。
- `feishu`：飞书独立消息端。签名/加密事件回调写入 `feishu-messages.jsonl`，按 v2 `event_id` 持久去重，并按来源 `chat_id` 隔离会话和回发文本。缺少应用凭据、Verification Token、Encrypt Key 或事件订阅确认时，监听和出站都保持关闭。
旧配置仍然兼容：`messageInputsDisabled=true` 或 `messageAdapters=["disabled"]` 会临时关闭整个路由的消息进入；`messageAdaptersDisabled` 会被视为对应 adapter 的 `inputEnabled=false`。新配置建议优先使用 `messageAdapterPolicies` 表达“接收”和“发送”两个管道级开关。

NapCat 的 QQ 密码、设备验证和验证码不属于 RabiRoute 配置。每个 QQ 实例的“启动 Rabi 时自动登录”默认开启；Manager 监听成功后异步启动绑定实例、使用已有 quick login 并修复 OneBot 连接，不等待该流程完成。路由页“打开 NapCat”可随时手动执行同一流程。详见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

- `rabilink`：旧配置中的内部兼容键，界面名称为“眼镜端（经 RabiLink）”。眼镜才是消息端；RabiLink Relay 是 Manager 持有的系统内置转接服务。当前 AIUI 把最终 ASR 文本作为 `rabilink.observation` 上送；电脑端 worker 先写入角色目录下的 `rabilink-conversation.jsonl` 统一会话账本并完成上行，不逐句同步等待 Codex。审阅器在线程空闲、触摸板引导或周期反思时读取账本并唤醒或 steer 固定 Codex 线程；Agent、定时器和规划器的文本再通过 Outbox 与 Relay 独立下行。旧插件消息和本地 `/rabilink` POST 仍走兼容转发路径，并保留 `rabilink-voice-transcripts.jsonl` 调试记录。
- `wearable`：智能手表 / 手环健康消息端。它复用全局 RabiLink Relay worker 接收结构化 `wearable.health` observation，按角色写入 `wearable-health/` 时间线；普通样本不进入聊天账本，只有命中心率/睡眠规则时才以 `wearable_health_alert` 投递 Agent。手机配置、Agent 查询 API 和实验数据源见 `docs/rabilink-wearable-health.md`。
- `webhook`：接收暂时没有专用消息端的外部系统 POST 事件。FenneNote、小爱、企业微信、飞书、眼镜端这类已命名来源应使用各自专用消息端，避免日志、模板变量和回传语义混在通用 webhook 里。

如果要让 Rokid/灵珠在公网访问 RabiRoute，不应暴露本机 manager，而是部署公网 Relay，在服务器 `/manage` 创建 RabiLink 应用，并在控制台“Rabi 实例”中填写全局 Relay 地址、应用 token 和本机 PC 标识，再打开“连接服务器”开关。Manager 会立即让这台 PC 在服务器上线；需要处理眼镜消息时，再给目标路由添加“眼镜端（经 RabiLink）”（内部键 `rabilink`）。当前主链路不经过手机桥：Relay 的输入队列由电脑端 worker 领取，AIUI observation 采用 record-first；主动回复走独立的全局下行队列，不与某个输入任务的生命周期绑定。需要在服务器上配置这台 PC 时，登录后访问 `/manage/<账号>/<RabiGUID>/#/routes`，它会经 Relay 转到 PC 本机 `http://127.0.0.1:8790/#/routes`。

新增平台时，优先在 `src/adapters/` 新增 adapter，并输出统一消息记录和路由事件，不要把新平台逻辑塞进 NapCat adapter。

## 多路由与人格复用

每个 `data/route/<配置名>/adapterConfig.json` 是一条可启动路由。它可以有自己的消息端、端口和 Agent 工作目录：

```json
{
  "messageAdapters": ["napcat", "heartbeat"],
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000"
}
```

多个路由配置也可以指向同一个人格：

```text
data/route/main/adapterConfig.json          -> agentRoleId: Rabi
data/route/fennenote-voice/adapterConfig.json -> agentRoleId: Rabi
data/roles/Rabi/personaConfig.json
```

多条 Route 绑定同一人格时，共用该人格根级 `personaConfig.json` 的自动化规则、语音关键词和上下文额度；Route 自己仍保留消息端、pipeline、热投递模式、处理端和本机脚本权限等运行配置。绑定人格但没有匹配外部消息规则时，外部消息只记录不投递；内置角色面板规则仍存在。显式无人格 route 会按已启用消息入口生成默认规则。

人格可在 `personaConfig.json` 绑定外发语言风格：

```json
"languageStyle": {
  "styleSkillUrl": "file:///C:/Users/Example/.codex/skills/direct-evidence-language-style"
}
```

URL 可指向 Skill 目录、`SKILL.md` 或 `references/style-data.json`。`/api/agent/send` 默认使用 `styleValidation=1`；校验失败时消息停在 Outbox 前，并返回原因。Agent 确认本次原文后，可用同一 `deliveryId` 和 `styleValidation=0` 重发。

默认投递规则只保留当前任务必须知道的动作、边界和接口字段。完整流程说明放在文档或 Skill 中；人格模板只补充该人格、消息端或定时任务的差异。

一旦普通消息命中规则，会直接进入 Route 选定的主控 Agent。主控是 Codex 时，当前 turn 活跃则 `steer`，空闲则 `start`。不需要给每个普通消息端另配“热推送”开关。Heartbeat 的忙碌跳过和语音的热/关键词模式是两个明确例外。

具体的 route kind、`regex` 和模板写法见 [路由配置](routing-configuration.md)。

## Agent 端适配器

当前内置 Agent 端适配器：

- `codex`：用短生命周期 app-server `thread/list` 读取 Desktop 用户可见的任务名称，并按完整 ID 合并本地 cwd、归档、时间和 owner/rollout 状态；以完整任务 ID 和工作目录绑定。投递时让 Desktop 加载目标任务，再通过 Desktop IPC start 或 steer，实际消息只由 Desktop owner 执行。
- `copilotCli`：通过本机 Copilot CLI 命令投递一次性 prompt，输出写入 `copilot-output.jsonl`，运行态上报给 Manager。它不会注入已有 VS Code Copilot 面板线程；如需后台调用，请确保 CLI 可执行文件在 PATH 中，或设置 `COPILOT_CLI_BIN`。
- `astrbot`：通过 AstrBot Dashboard / ChatUI API 绑定项目和会话，支持登录验证、扫描和插件部署；当前仍是实验支持，真实连续发送需要环境验收。
- `marvis`：通过本机 handoff 方式接入 Marvis 桌面端。RabiRoute 会把 prompt 写入 `marvis-prompts/`、复制到剪贴板，并优先启动/聚焦 Windows 桌面应用 `Tencent.Marvis`；由于 Marvis 当前未提供稳定公开后台 API，这个适配器不会自动点击发送。

Codex adapter 的默认安全边界：

- Codex/ChatGPT Desktop 必须运行；RabiRoute 不负责启动或停止 Desktop Runtime。
- 目标任务未被 Desktop owner 加载时，RabiRoute 只打开 `codex://threads/<id>` 并短暂重试。
- 有效 ID 且工作目录一致时始终复用，不因标题索引滞后、Desktop 改名或 goal 完成而新建。ID 被明确清空或确实失效时，才按保存名称和规范化工作目录查找/创建。
- 无 ID 查找和下拉名称以 app-server `thread.name` 为准；SQLite `threads.title` 可能是首条 prompt，只能作为可变内部元数据，不能用于同名查找。
- 项目与任务列表只在进入设置界面时自动扫描一次；之后只有点击“扫描/重新扫描”按钮才刷新。
- “自动初始化会话”会先保存并解析稳定绑定，再通过角色面板/AgentPacket 正式链路把人格资料交给同一个 Desktop owner；初始化投递失败不会创建第二个任务。
- 模型、工具、文件/网络权限和审批沿用目标 Desktop 任务；RabiRoute 不伪造或覆盖。
- app-server WebSocket 与 `CODEX_APP_SERVER_WS_URL` 不进入主链，也不得由普通 adapter 配置写入用户环境。

默认建议使用：

```json
"agentAdapters": ["codex"],
"primaryAgentAdapter": "codex",
"codexThreadId": "<由 WebGUI 保存的任务 ID>",
"codexThreadName": "Rabi",
"codexCwd": "C:/Path/To/Your/Project",
"codexHooks": {
  "sessionContextEnabled": true,
  "reasoningContextEnabled": true,
  "planTaskCompletionEnabled": true
}
```

使用 Copilot CLI 时：

```json
"agentAdapters": ["copilotCli"],
"copilotThreadName": "Rabi",
"copilotCwd": "C:/Path/To/Your/Project"
```

可选环境变量：

```text
COPILOT_CLI_BIN=C:/Path/To/copilot.cmd
COPILOT_CLI_ARGS=["--silent","--allow-all-tools","--no-ask-user","--prompt","{prompt}"]
COPILOT_CLI_TIMEOUT_MS=600000
COPILOT_CWD=C:/Path/To/Your/Project
COPILOT_THREAD_NAME=Rabi
```

使用 Marvis 时：

```json
"agentAdapters": ["marvis"]
```

可选环境变量：

```text
MARVIS_APP_ID=Tencent.Marvis
MARVIS_OPEN_DESKTOP_APP=1
MARVIS_URL=https://marvis.qq.com/
MARVIS_OPEN_ON_NOTIFY=1
MARVIS_COPY_TO_CLIPBOARD=1
```

如果处理端没有收到消息，优先检查：

- WebUI 中 gateway 是否运行。
- `data/route/<配置名>/agent-packets.jsonl` 是否有投递记录。
- `codexThreadName` 是否能匹配到 Codex 中的线程。
- `codexCwd` 是否是处理端应工作的项目目录。

## RibiWebGUI 与 NapCat 插件

RibiWebGUI 是独立控制台，由 manager 在本机提供：

```text
http://127.0.0.1:8790/
```

仓库也包含一个可选 NapCat 插件入口，位于插件侧适配目录：

```text
plugin-adapters/napcat-rabiroute/
```

这个插件不是主 WebGUI，也不是 Codex 网关。它只让 NapCat 插件页能打开 RibiWebGUI，并可请求启动本地 manager。NapCat 本身只是 `messageAdapters` 里的一个消息端适配器。

如需从 NapCat 内打开入口，把该目录复制到 NapCat 插件目录后启用。示例路径：

```text
NapCat.*/resources/app/napcat/plugins/napcat-plugin-rabiroute
```

插件会注册：

- 页面：`gateways`
- API：`/plugin/napcat-plugin-rabiroute/api/...`
- 静态资源目录：`webui/`，只包含 NapCat 入口页

插件页会提供入口跳转到 RibiWebGUI：

```text
http://127.0.0.1:8790/
```

本地调试 NapCat 插件时，把 `plugin-adapters/napcat-rabiroute/` 复制到 NapCat 插件目录并命名为 `napcat-plugin-rabiroute`，然后重新加载插件。直接使用 RibiWebGUI 时不需要安装 NapCat 插件。
