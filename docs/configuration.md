# 配置与接入

## 路由配置

运行期配置现在按文件夹拆在 `data/route` 和 `data/roles`：

- `data/route/<配置名>/adapterConfig.json`：消息端、端口、Agent 端、工作目录、指向人格。
- `data/roles/<角色名>/persona.md`：人格正文。
- `data/roles/<角色名>/personaConfig.json`：消息模板规则。一个人格可以服务多个路由配置。

如果运行期 data 不存在，manager 会优先复制整包 `examples/data`，让默认路由和 Rabi 示例人格一起落地。`examples/data` 不是运行依赖；缺少 examples 时，manager 也能创建最小 QQ / NapCat 到 Codex 配置。

```json
{
  "enabled": true,
  "messageAdapters": ["napcat", "heartbeat"],
  "messageAdapterPolicies": {
    "napcat": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"]
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ 消息监听",
  "codexCwd": "C:/Path/To/Your/Project",
  "agentModel": "",
  "agentAdapters": ["codex"],
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

重要字段：

- `messageAdapters`：消息入口列表。支持 `napcat`、`heartbeat`、`webhook`、`fennenote`、`xiaoai`。
- `messageAdapterPolicies`：每个消息端的管道级权限。`inputEnabled` 控制是否接收，`outputEnabled` 控制是否允许出站。NapCat 默认允许 Agent 通过 RabiRoute 主动发送到明确目标。旧配置里的 `allowedGroups` / `allowedUsers` / `outputMode` / `enabledPipelines` / `disabledPipelines` 不再作为过滤条件生效。
- `supportedOutputs`：这个消息端允许发送的消息类型。NapCat/OneBot 当前支持 `text`、`image`、`voice`、`file` 结构化消息段；旧的纯文本 `text/message/content` 请求仍兼容。
- `gatewayPort`：NapCat WebSocket Client 连接的端口。
- `webhookPort`：Webhook 监听端口。未配置时回退到 `gatewayPort`。
- `webhookPath`：Webhook 入口路径，默认 `/webhook`。
- `napcatHttpUrl`：OneBot HTTP API 地址。
- `agentAdapters`：Agent 端适配器列表。当前支持 `codex`、`copilotCli`、`marvis`。
- `codexThreadName`：Codex 固定线程名。旧配置中的 `codexDesktop` / `codexApp` 会在加载时自动升级为 `codex`。
- `codexCwd`：处理端收到任务后应工作的目录。使用 Codex 时建议填目标项目的绝对路径；WebUI 会把已配置过的目录放进 `Agent 工作目录` 下拉，方便复用。
- `agentModel`：可选的 Agent 模型覆盖。默认留空，RabiRoute 不会改动原本会话使用的模型；只有明确填写时才会在投递给 Codex 时指定模型。
- `dataDir`：消息记录、投递记录和心跳记录目录。
- `rolesDir`：人格目录，只放 `persona.md`、成长记录、提示词等角色文件。
- `configName`：路由配置文件夹名。
- `agentRoleId`：当前路由配置指向的人格文件夹名。
- 消息模板规则不写在 `adapterConfig.json` 里。manager 会按 `agentRoleId` 读取对应角色的 `personaConfig.json`。

Windows 路径在 WebUI 里写 `C:\Path\To\Project` 或 `C:/Path/To/Project`；只有手写 JSON 文件时才需要把反斜杠转义成 `\\`。

## 消息适配端

当前可用：

- `napcat`：通过 OneBot WebSocket 接收 QQ 事件，通过 OneBot HTTP 预留主动调用能力。
- `heartbeat`：按固定间隔生成内部 `heartbeat` 路由事件，适合周期巡检。
旧配置仍然兼容：`messageInputsDisabled=true` 或 `messageAdapters=["disabled"]` 会临时关闭整个路由的消息进入；`messageAdaptersDisabled` 会被视为对应 adapter 的 `inputEnabled=false`。新配置建议优先使用 `messageAdapterPolicies` 表达“接收”和“发送”两个管道级开关。

NapCat 的 QQ 登录、quick login、账号密码环境变量和验证码处理不属于 RabiRoute 配置；见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

- `webhook`：接收 FenneNote、企业微信、飞书、Discord、Slack、Telegram 或内部系统的 POST 事件。

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

- `codex`：通过 Codex Desktop IPC 投递到固定线程。空闲时 `start`，运行中用 `steer` 追加引导；旧 app-server 通道只作为内部 fallback / 调试能力保留。
- `copilotCli`：通过本机 Copilot CLI 命令投递一次性 prompt，输出写入 `copilot-output.jsonl`，运行态上报给 Manager。它不会注入已有 VS Code Copilot 面板线程；如需后台调用，请确保 CLI 可执行文件在 PATH 中，或设置 `COPILOT_CLI_BIN`。
- `marvis`：通过本机 handoff 方式接入 Marvis 桌面端。RabiRoute 会把 prompt 写入 `marvis-prompts/`、复制到剪贴板，并优先启动/聚焦 Windows 桌面应用 `Tencent.Marvis`；由于 Marvis 当前未提供稳定公开后台 API，这个适配器不会自动点击发送。

默认建议使用：

```json
"agentAdapters": ["codex"],
"agentModel": ""
```

使用 Copilot CLI 时：

```json
"agentAdapters": ["copilotCli"]
```

可选环境变量：

```text
COPILOT_CLI_BIN=C:/Path/To/copilot.cmd
COPILOT_CLI_ARGS=["--silent","--allow-all-tools","--no-ask-user","--prompt","{prompt}"]
COPILOT_CLI_TIMEOUT_MS=600000
COPILOT_CWD=C:/Path/To/Your/Project
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
- `data/route/<配置名>/codex-notifications.jsonl` 是否有投递记录。
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
