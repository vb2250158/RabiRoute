# 配置与接入

## Gateway 配置

核心配置在 `data/gateways.json`：

如果文件不存在，manager 会优先复制整包 `examples/data`，让默认 QQ gateway 和 Rabi 示例人格一起落地。`examples/data` 不是运行依赖；缺少 examples 时，manager 会创建最小 QQ / NapCat 到 Codex Desktop 配置。

```json
{
  "gateways": [
    {
      "id": "default-main",
      "enabled": true,
      "messageAdapters": ["napcat", "heartbeat"],
      "gatewayPort": 8789,
      "napcatHttpUrl": "http://127.0.0.1:3000",
      "codexThreadName": "QQ 消息监听",
      "codexCwd": "C:/Path/To/Your/Project",
      "agentAdapters": ["codexDesktop"],
      "dataDir": "./data/default-main",
      "rolesDir": "./data/default-main/roles",
      "agentRoleId": "",
      "notificationRules": []
    }
  ]
}
```

重要字段：

- `messageAdapters`：消息入口列表。支持 `napcat`、`heartbeat`、`webhook`、`disabled`。
- `webhookPath`：预留 Webhook 入口路径。
- `gatewayPort`：NapCat WebSocket Client 连接的端口。
- `napcatHttpUrl`：OneBot HTTP API 地址。
- `agentAdapters`：Agent 端适配器列表。当前支持 `codexDesktop`、`codexApp`。
- `codexThreadName`：Codex Desktop 固定线程名。
- `codexCwd`：处理端收到任务后应工作的目录。使用 Codex 时建议填目标项目的绝对路径；WebUI 会把已配置过的目录放进 `Agent 工作目录` 下拉，方便复用。
- `dataDir`：消息记录、投递记录和心跳记录目录。
- `rolesDir`：路由人格目录。
- `agentRoleId`：当前 gateway 使用的角色目录名。
- `notificationRules`：路由规则列表。

Windows 路径在 WebUI 里写 `C:\Path\To\Project` 或 `C:/Path/To/Project`；只有手写 JSON 文件时才需要把反斜杠转义成 `\\`。

## 消息适配端

当前可用：

- `napcat`：通过 OneBot WebSocket 接收 QQ 事件，通过 OneBot HTTP 预留主动调用能力。
- `heartbeat`：按固定间隔生成内部 `heartbeat` 路由事件，适合周期巡检。
- `disabled`：不监听外部消息，只保留配置和角色。

预留：

- `webhook`：后续用于企业微信、飞书、Discord、Slack、Telegram 或内部系统。

新增平台时，优先在 `src/adapters/` 新增 adapter，并输出统一消息记录和路由事件，不要把新平台逻辑塞进 NapCat adapter。

## 多路由共享消息端

`messageAdapters` 属于 gateway，不属于单条路由。一个 gateway 只需要配置一套 NapCat / OneBot 连接：

```json
{
  "messageAdapters": ["napcat", "heartbeat"],
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000"
}
```

同一个 gateway 下面可以有多个 route profile。它们共享同一个 `gatewayPort` / NapCat WebSocket 和同一个 `napcatHttpUrl`，但可以使用不同的规则、人格目录和模板。

```json
{
  "routeProfiles": [
    {
      "id": "rabi",
      "name": "Rabi 路由",
      "agentRoleId": "Rabi",
      "notificationRules": []
    },
    {
      "id": "qa-reviewer",
      "name": "QA 审校路由",
      "agentRoleId": "QAReviewer",
      "notificationRules": []
    }
  ]
}
```

如果没有手写 `routeProfiles`，manager 会把 `rolesDir` 下各角色的 `routes.json` 转成 route profile。这样新增多个人格/路由时，不需要新增多个 gateway，也不需要让 NapCat 配多个 WebSocket Client。

## Agent 端适配器

当前内置 Agent 端适配器：

- `codexDesktop`：通过 Codex Desktop IPC 投递到固定线程。空闲时 `start`，运行中用 `steer` 追加引导。
- `codexApp`：旧 app-server 调试通道，主要用于旁路验证。

默认建议使用：

```json
"agentAdapters": ["codexDesktop"]
```

如果处理端没有收到消息，优先检查：

- WebUI 中 gateway 是否运行。
- `data/<gateway-id>/codex-notifications.jsonl` 是否有投递记录。
- `codexThreadName` 是否能匹配到 Codex Desktop 中的线程。
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
