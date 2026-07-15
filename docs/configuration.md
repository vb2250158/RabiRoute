# 配置与接入

## OpenAI / Codex 术语边界

RabiRoute 配置把 provider、agent、transport、host 和 model 分开表达，避免桌面产品名称变化再次污染运行时配置：

| 概念 | 当前含义 | 是否写进 adapter id |
| --- | --- | --- |
| provider | OpenAI 提供的账号、服务和模型能力 | 否 |
| agent / runtime | Codex 负责线程、turn、工具调用和执行 | 是，稳定 id 为 `codex` |
| transport | `codex app-server` 通过 stdio 交换 JSONL 请求、响应与通知 | 否，由 `codex` adapter 管理 |
| host | ChatGPT desktop，可选的桌面查看和交互宿主 | 否，不是 RabiRoute 的传输依赖 |
| model | Codex runtime 实际选择的模型，或 `agentModel` 的显式覆盖 | 否 |

Codex 已并入新的 ChatGPT desktop，但 Codex 仍是 Agent 和 runtime 的名称。不要把 adapter 改名为 `chatgpt`，也不要把 ChatGPT desktop 进程、Desktop IPC 或实验性 WebSocket 当成正式投递协议。

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

- `messageAdapters`：消息入口列表。支持 `napcat`、`heartbeat`、`webhook`、`fennenote`、`xiaoai`、`rabilink`、`wecom`。
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
- `agentAdapters`：Agent 端适配器列表。当前支持 `codex`、`copilotCli`、`marvis`。
- `codexThreadName`：Codex 固定线程名。桌面宿主名称不参与线程绑定；历史 adapter 名称只在后端配置读写边界执行一次性归一化，运行时、API 和前端只接受规范值 `codex`。
- `codexCwd`：处理端收到任务后应工作的目录。使用 Codex 时建议填目标项目的绝对路径；WebUI 会把已配置过的目录放进 `Agent 工作目录` 下拉，方便复用。
- `copilotThreadName`：Copilot CLI 独立会话名。它不再复用 `codexThreadName`；旧的 Copilot-only 配置会在读取边界迁移一次并以新字段保存。
- `copilotCwd`：Copilot CLI 独立工作目录，不与 `codexCwd` 共享真源。
- `agentModel`：可选的模型覆盖。默认留空时，RabiRoute 从 `model/list` 读取 runtime 当前默认值，并把它用于线程恢复和 `turn/start`；明确填写时才固定为指定模型。可用模型应从 runtime 动态能力中获取，不在 RabiRoute 文档或代码里固化历史模型名。
- `heartbeatSkipWhenAgentBusy`：可选，默认 `false`。启用后，如果当前 Codex 固定会话仍处于 active / in-progress 状态，本次 `heartbeat` 会记录为 `skipped` 且原因是 `agent_busy`，不会继续投递；群聊、私聊和其他消息类型不受影响。WebUI 在“路由配置 → 消息适配器 → 定时触发”提供“会话工作中时跳过心跳”开关。忙碌状态由共享 Codex Runtime 的 `thread/read` 与实时通知共同确认，不再依赖旧 Desktop IPC 或本地 transcript 日期推断。
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
- `wecom`：通过企业微信智能机器人 WebSocket 长连接接入企业微信群聊，写入 `wecom-messages.jsonl`，并允许 Agent 通过 RabiRoute outbox 回发到企业微信。它的群聊模板变量尽量对齐 NapCat 的 `groupId`、`userId`、`sender`、`message`、`messageId`，额外补充 `wecomReqId`、`wecomConversationId`、`wecomChatId` 等字段；详见 [企业微信接入](wecom-integration.md)。
旧配置仍然兼容：`messageInputsDisabled=true` 或 `messageAdapters=["disabled"]` 会临时关闭整个路由的消息进入；`messageAdaptersDisabled` 会被视为对应 adapter 的 `inputEnabled=false`。新配置建议优先使用 `messageAdapterPolicies` 表达“接收”和“发送”两个管道级开关。

NapCat 的 QQ 密码、设备验证和验证码不属于 RabiRoute 配置。路由页“打开 NapCat”会在用户明确点击后自动启动绑定实例、使用已有 quick login 并修复 OneBot 连接；需要腾讯安全确认时只打开正确页面交给用户。详见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

- `rabilink`：RabiLink 消息端。当前 AIUI 把最终 ASR 文本作为 `rabilink.observation` 上送；电脑端 worker 先写入角色目录下的 `rabilink-conversation.jsonl` 统一会话账本并完成上行，不逐句同步等待 Codex。审阅器在线程空闲、触摸板引导或周期反思时读取账本并唤醒或 steer 固定 Codex 线程；Agent、定时器和规划器的文本再通过 Outbox 与 Relay 独立下行。旧插件消息和本地 `/rabilink` POST 仍走兼容转发路径，并保留 `rabilink-voice-transcripts.jsonl` 调试记录。
- `webhook`：接收暂时没有专用消息端的外部系统 POST 事件。FenneNote、小爱、企业微信、RabiLink 这类已命名平台应使用各自专用消息端，避免日志、模板变量和回传语义混在通用 webhook 里。

如果要让 Rokid/灵珠在公网访问 RabiRoute，不应暴露本机 manager，而是部署公网 Relay，在服务器 `/manage` 创建 RabiLink 应用，并在控制台“Rabi 实例”中填写全局 Relay 地址、应用 token 和本机 PC 标识，再打开“连接服务器”开关。Manager 会立即让这台 PC 在服务器上线；需要处理眼镜消息时，再给目标路由添加 `rabilink` 消息端。当前主链路不经过手机桥：Relay 的输入队列由电脑端 RabiLink worker 领取，AIUI observation 采用 record-first；主动回复走独立的全局下行队列，不与某个输入任务的生命周期绑定。需要在服务器上配置这台 PC 时，登录后访问 `/manage/<账号>/<RabiGUID>/#/routes`，它会经 Relay 转到 PC 本机 `http://127.0.0.1:8790/#/routes`。

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

人格里的 `personaConfig.json` 用 `configName` 区分不同路由配置的消息模板规则。没有有效 `personaConfig.json` 规则时，消息只会记录，不会投递给处理端。

具体的 route kind、`regex` 和模板写法见 [路由配置](routing-configuration.md)。

## Agent 端适配器

当前内置 Agent 端适配器：

- `codex`：启动官方 `codex app-server`，通过 stdio JSONL 完成 `initialize` / `initialized`、线程发现或创建、`turn/start` 和运行中 `turn/steer`。它不要求 ChatGPT desktop 打开目标线程，也不通过 Desktop IPC 或实验性 WebSocket 投递。
- `copilotCli`：通过本机 Copilot CLI 命令投递一次性 prompt，输出写入 `copilot-output.jsonl`，运行态上报给 Manager。它不会注入已有 VS Code Copilot 面板线程；如需后台调用，请确保 CLI 可执行文件在 PATH 中，或设置 `COPILOT_CLI_BIN`。
- `marvis`：通过本机 handoff 方式接入 Marvis 桌面端。RabiRoute 会把 prompt 写入 `marvis-prompts/`、复制到剪贴板，并优先启动/聚焦 Windows 桌面应用 `Tencent.Marvis`；由于 Marvis 当前未提供稳定公开后台 API，这个适配器不会自动点击发送。

Codex adapter 的默认安全边界：

- `agentModel` 留空时动态读取 runtime 默认模型，显式值才覆盖。
- 默认沙箱为 `workspaceWrite`，只把配置的工作目录视为可写工作区；需要更高权限必须走明确审批。
- command、file、network、permission 或 MCP 等 app-server 审批只有得到明确允许才继续。未知请求、超时、连接中断或策略无法判断时一律 fail closed，不自动使用“本会话持续允许”。
- ChatGPT desktop 只是可选 host；关闭桌面窗口不应让 stdio 主链路失效。
- app-server WebSocket 仍是实验能力，RabiRoute 正式集成不启用。

如需让 RabiRoute 在 Windows 上主动聚焦或启动 ChatGPT desktop，必须显式启用；这只改变查看体验，不改变投递：

```text
CHATGPT_DESKTOP_VISIBILITY_NOTIFY=1
CHATGPT_DESKTOP_EXE_PATH=C:/Program Files/WindowsApps/.../app/ChatGPT.exe
```

默认不主动操作桌面窗口。`CHATGPT_DESKTOP_EXE_PATH` 通常无需填写，宿主发现会读取已安装 OpenAI Appx 的 manifest。

默认建议使用：

```json
"agentAdapters": ["codex"],
"agentModel": ""
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
