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
- `data/roles/<角色名>/personaConfig.json`：消息模板规则。一个人格可以服务多个路由配置。

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
      "allowedFileRoots": ["C:/Path/To/Your/Project/ReleasePkg"]
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ 消息监听",
  "codexCwd": "C:/Path/To/Your/Project",
  "agentModel": "",
  "agentAdapters": ["codex"],
  "heartbeatSkipWhenAgentBusy": true,
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

重要字段：

- `messageAdapters`：消息入口列表。支持 `napcat`、`remoteAgent`、`heartbeat`、`rolePanel`、`webhook`、`fennenote`、`xiaoai`、`rabilink`、`wecom`。其中 `remoteAgent` 和 `rolePanel` 的真实入口由 Manager 提供，Gateway 子进程不另开 listener。
- `messageAdapterPolicies`：每个消息端的管道级权限。`inputEnabled` 控制是否接收，`outputEnabled` 控制是否允许出站。NapCat 默认允许 Agent 通过 RabiRoute 主动发送到明确目标。旧配置里的 `allowedGroups` / `allowedUsers` / `outputMode` / `enabledPipelines` / `disabledPipelines` 不再作为过滤条件生效。
- `supportedOutputs`：这个消息端允许发送的消息类型。NapCat/OneBot 当前支持 `text`、`image`、`voice`、`file`；旧的纯文本 `text/message/content` 请求仍兼容。QQ 群本地文件使用 `upload_group_file`，不是把大文件伪装成普通文本或普通消息段。
- `allowedFileRoots`：本地文件出站白名单目录，仅在 `payloadType=file` 且使用本地路径时生效。文件必须真实存在、是普通文件，并且解析真实路径后仍位于其中一个目录内；未配置时本地群文件上传会被阻止。公开示例只能使用占位路径，运行期按角色实际构建产物目录配置。
- `gatewayPort`：NapCat WebSocket Client 连接的端口。
- `webhookPort`：Webhook 监听端口。未配置时回退到 `gatewayPort`。
- `webhookPath`：Webhook 入口路径，默认 `/webhook`。
- `rabiLinkWebhookPort` / `rabiLinkWebhookPath`：RabiLink 本地兼容入口端口和路径，默认路径 `/rabilink`。局域网脚本或手工调试可直接 POST 到这里；正式 AIUI 链路由电脑端 RabiLink worker 直连公网 Relay，接收 observation 输入并消费独立的主动下行队列。
- `data/Config.json` 里的 `rabiGuid`：这台 Rabi PC 的稳定身份。服务器远程 WebGUI 使用 `/manage/<账号>/<RabiGUID>/webgui` 定位 PC；显示名和 `deviceId` 只用于展示、兼容和任务领取。
- `data/Config.json` 里的 `rabiLinkRelay`：这台 Rabi PC 的全局 Relay 连接配置，包含全局开关 `enabled`，以及 `url`、`token`、`deviceId`、`claimWaitMs`、`replyIdleTimeoutMs`。应用 token 在服务器 Relay WebGUI `/manage` 里创建；开启全局开关后，Manager 会常驻登记本机并代理远程 RibiWebGUI，不依赖任何单条路由启动。服务器应用自身仍可禁用，PC 开关与服务器应用必须同时启用才会接收输入和发布下行消息。
- 旧版 `adapterConfig.json` 里的 `rabiLinkRelayEnabled` / `rabiLinkRelayUrl` / `rabiLinkRelayToken` / `rabiLinkRelayDeviceId` 仍兼容读取；新配置应放在全局 `data/Config.json`，路由消息端只保存监听端口、路径和是否启用。
- `routeVariables.rabilinkAutoReview` / `rabilinkContinuousReflection`：分别控制新 observation 的空闲审阅和无新输入时的周期反思。配套的 `rabilinkReviewIntervalMs`、`rabilinkReviewSettleMs`、`rabilinkReflectionIntervalMinutes`、`rabilinkConversationSplitAfterHours` 控制检查频率、输入稳定窗口、反思间隔和会话切分。`rabilinkRecordFirstSources` 是可选的逗号分隔消息源白名单，例如 `fennenote`；把对应消息端放在承载 `RabiActive` 的同一条 Route 后，命中的 FenneNote/Webhook 转写只进入同一 RabiLink 账本和审阅器，不逐句直接投递 Agent。该列表默认留空，持续录音源必须显式启用；不要让另一条直投 Route 同时消费同一个 webhook。可直接参考 `examples/data/route/RabiLink/` 与 `examples/data/roles/RabiActive/`；示例不包含 Relay 地址或 token。
- `wecomBotId` / `wecomBotSecret` / `wecomWsUrl`：企业微信智能机器人 WebSocket 长连接配置。`wecomWsUrl` 可选；公开示例只能使用占位值，真实 secret 建议走 `WECOM_BOT_ID` / `WECOM_BOT_SECRET` / `WECOM_WS_URL` 环境变量。
- `napcatHttpUrl`：OneBot HTTP API 地址。
- `agentAdapters`：Agent 端适配器列表。当前支持 `codex`、`copilotCli`、`astrbot`、`marvis`。成熟度分别是：Codex 已验证；Copilot CLI、AstrBot 实验支持；Marvis 仅人工接力。
- `codexThreadId` / `codexThreadName`：下拉显示 Desktop 任务的名称和最后时间，内部保存完整任务 ID 与可见名称。有效且同工作目录的 ID 是稳定身份；Desktop 改名、SQLite 标题滞后或 goal 完成都不会触发新建。用户明确输入新名称时前端会清空旧 ID，后端才按名称 + 目录查找；一个或多个同名同目录候选按最后更新时间绑定唯一最新者，零匹配时幂等创建，最大时间并列时要求选择。
- `codexCwd`：目标 Desktop 任务的项目目录。它用于校验已保存 ID、同名任务消歧和新建位置；选择已有任务时自动采用任务自己的目录。
- `copilotThreadName`：Copilot CLI 独立会话名。它不再复用 `codexThreadName`；旧的 Copilot-only 配置会在读取边界迁移一次并以新字段保存。
- `copilotCwd`：Copilot CLI 独立工作目录，不与 `codexCwd` 共享真源。
- `agentModel`：旧配置兼容字段。Codex Desktop 主链不读取它；模型由目标 Desktop 任务自己选择。
- `heartbeatSkipWhenAgentBusy`：可选，默认 `false`。启用后，如果当前 Codex 固定任务仍处于 active / in-progress 状态，本次 `heartbeat` 会记录为 `skipped` 且原因是 `agent_busy`，不会继续投递；群聊、私聊和其他消息类型不受影响。忙碌状态由 Desktop IPC 广播与当前任务状态共同确认。
- `dataDir`：消息记录、投递记录和心跳记录目录。
- `rolesDir`：人格目录，只放 `persona.md`、成长记录、提示词等角色文件。
- `configName`：路由配置文件夹名。
- `agentRoleId`：当前路由配置指向的人格文件夹名。
- 消息模板规则不写在 `adapterConfig.json` 里。manager 会按 `agentRoleId` 读取对应角色的 `personaConfig.json`。

Windows 路径在 WebUI 里写 `C:\Path\To\Project` 或 `C:/Path/To/Project`；只有手写 JSON 文件时才需要把反斜杠转义成 `\\`。

## 消息适配端

当前可用：

- `napcat`：通过 OneBot WebSocket 接收 QQ 事件，通过 OneBot HTTP 预留主动调用能力。
- `heartbeat`：按固定间隔生成内部 `heartbeat` 路由事件，适合周期巡检；可用 `heartbeatSkipWhenAgentBusy` 避免固定 Codex 会话尚未完成上一轮任务时继续堆叠心跳。
- `rolePanel`：Manager/托盘提供的内置本地消息端，使用固定 `role_panel_message` 规则并写角色 timeline；它不是 Gateway 网络 listener，也不能从人格规则中删除。
- `remoteAgent`：Manager 级实验入口。RabiGUI 扫描并连接远端 bridge，支持密码挑战、任务、事件和文件；Gateway 子进程只显示状态占位。
- `wecom`：通过企业微信智能机器人 WebSocket 长连接接入企业微信群聊，写入 `wecom-messages.jsonl`，并允许 Agent 通过 RabiRoute outbox 回发到企业微信。它的群聊模板变量尽量对齐 NapCat 的 `groupId`、`userId`、`sender`、`message`、`messageId`，额外补充 `wecomReqId`、`wecomConversationId`、`wecomChatId` 等字段；详见 [企业微信接入](wecom-integration.md)。
旧配置仍然兼容：`messageInputsDisabled=true` 或 `messageAdapters=["disabled"]` 会临时关闭整个路由的消息进入；`messageAdaptersDisabled` 会被视为对应 adapter 的 `inputEnabled=false`。新配置建议优先使用 `messageAdapterPolicies` 表达“接收”和“发送”两个管道级开关。

NapCat 的 QQ 密码、设备验证和验证码不属于 RabiRoute 配置。路由页“打开 NapCat”会在用户明确点击后自动启动绑定实例、使用已有 quick login 并修复 OneBot 连接；需要腾讯安全确认时只打开正确页面交给用户。详见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

- `rabilink`：旧配置中的内部兼容键，界面名称为“眼镜端（经 RabiLink）”。眼镜才是消息端；RabiLink Relay 是 Manager 持有的系统内置转接服务。当前 AIUI 把最终 ASR 文本作为 `rabilink.observation` 上送；电脑端 worker 先写入角色目录下的 `rabilink-conversation.jsonl` 统一会话账本并完成上行，不逐句同步等待 Codex。审阅器在线程空闲、触摸板引导或周期反思时读取账本并唤醒或 steer 固定 Codex 线程；Agent、定时器和规划器的文本再通过 Outbox 与 Relay 独立下行。旧插件消息和本地 `/rabilink` POST 仍走兼容转发路径，并保留 `rabilink-voice-transcripts.jsonl` 调试记录。
- `webhook`：接收暂时没有专用消息端的外部系统 POST 事件。FenneNote、小爱、企业微信、眼镜端这类已命名来源应使用各自专用消息端，避免日志、模板变量和回传语义混在通用 webhook 里。

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

人格里的 `personaConfig.json` 用 `configName` 区分不同路由配置的消息模板规则。绑定人格但没有匹配外部消息规则时，外部消息只记录不投递；内置角色面板规则仍存在。显式无人格 route 会按已启用消息入口生成默认规则。

具体的 route kind、`regex` 和模板写法见 [路由配置](routing-configuration.md)。

## Agent 端适配器

当前内置 Agent 端适配器：

- `codex`：从 Desktop 状态读取任务列表，以完整任务 ID 和工作目录绑定；投递时让 Desktop 加载目标任务，再通过 Desktop IPC start 或 steer。实际消息只由 Desktop owner 执行。
- `copilotCli`：通过本机 Copilot CLI 命令投递一次性 prompt，输出写入 `copilot-output.jsonl`，运行态上报给 Manager。它不会注入已有 VS Code Copilot 面板线程；如需后台调用，请确保 CLI 可执行文件在 PATH 中，或设置 `COPILOT_CLI_BIN`。
- `astrbot`：通过 AstrBot Dashboard / ChatUI API 绑定项目和会话，支持登录验证、扫描和插件部署；当前仍是实验支持，真实连续发送需要环境验收。
- `marvis`：通过本机 handoff 方式接入 Marvis 桌面端。RabiRoute 会把 prompt 写入 `marvis-prompts/`、复制到剪贴板，并优先启动/聚焦 Windows 桌面应用 `Tencent.Marvis`；由于 Marvis 当前未提供稳定公开后台 API，这个适配器不会自动点击发送。

Codex adapter 的默认安全边界：

- Codex/ChatGPT Desktop 必须运行；RabiRoute 不负责启动或停止 Desktop Runtime。
- 目标任务未被 Desktop owner 加载时，RabiRoute 只打开 `codex://threads/<id>` 并短暂重试。
- 有效 ID 且工作目录一致时始终复用，不因标题索引滞后、Desktop 改名或 goal 完成而新建。ID 被明确清空或确实失效时，才按保存名称和规范化工作目录查找/创建。
- 项目与任务列表只在进入设置界面时自动扫描一次；之后只有点击“扫描/重新扫描”按钮才刷新。
- “自动初始化会话”会先保存并解析稳定绑定，再通过角色面板/AgentPacket 正式链路把人格资料交给同一个 Desktop owner；初始化投递失败不会创建第二个任务。
- 模型、工具、文件/网络权限和审批沿用目标 Desktop 任务；RabiRoute 不伪造或覆盖。
- app-server WebSocket 与 `CODEX_APP_SERVER_WS_URL` 不进入主链，也不得由普通 adapter 配置写入用户环境。

默认建议使用：

```json
"agentAdapters": ["codex"],
"codexThreadId": "<由 WebGUI 保存的任务 ID>",
"codexThreadName": "Rabi",
"codexCwd": "C:/Path/To/Your/Project"
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
