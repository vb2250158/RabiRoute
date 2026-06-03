# RabiRoute

![RabiRoute 拉比路由](assets/rabiroute-hero.png)

拉比路由是一个面向聊天入口和 Agent 系统的轻量 **Agent Gateway / Policy Router**。它关注的不是“怎么运行每一个 Agent”，而是“消息进来以后该交给谁、怎么包装上下文、注入什么提示词、结果如何反向路由回去”。

当前实现已经支持把 NapCat / OneBot 的 QQ 群聊和私聊消息转发到固定的 Codex Desktop 会话里，并提供独立 WebUI 与 NapCat 插件入口，用来管理多个网关、选择 NapCat 网络配置、编辑消息转发模板。代码里已经把消息路由、模板渲染和目标投递拆开，后续会继续升级为可配置的 Route DSL 和 Agent Target Registry。

GitHub: https://github.com/vb2250158/RabiRoute

架构说明：[ARCHITECTURE.md](ARCHITECTURE.md)

## 项目定位

RabiRoute 不计划做成另一个全量版 `cc-connect`。`cc-connect` 已经很好地解决了“多聊天平台接入多个 coding agent，并管理 project / provider / session / cron”的问题。RabiRoute 更适合站在它上层或旁路，做消息级策略路由：

```text
QQ / Webhook / CLI / HTTP API / Scheduler
        ↓
    RabiRoute
        ↓
统一事件 → 路由规则 → Prompt 注入 → Context 包装 → Target 选择
        ↓
Codex Desktop / cc-connect project / Copilot / AstrBot / Dify / n8n / Tool Runner
```

一句话：

```text
cc-connect 解决 “agent 怎么跑”。
RabiRoute 解决 “消息该交给谁、怎么包装、注入什么提示词”。
```

## 当前状态

已实现：

- NapCat / OneBot WebSocket 接入 QQ 群聊和私聊。
- 群消息路由：直接 @、直接回复、间接回复。
- 私聊消息路由。
- JSONL 消息记录和 Codex 投递记录。
- 模板化 Prompt / 消息包装。
- Codex Desktop IPC 投递，支持固定线程 `start` 和运行中 `steer`。
- 独立 WebUI：`http://127.0.0.1:8790/`。
- NapCat 插件入口：在 NapCat 插件页跳转到独立 WebUI。

规划中：

- 统一 `InboundMessage` 事件模型。
- Route DSL：按平台、群、用户、关键词、route kind、意图等条件选择目标。
- Agent Target Registry：`codexDesktop`、`ccConnectProject`、`webhook`、`astrbot`、`dify`、`n8n` 等。
- 双向路由：Agent 输出经过输出模板包装后回到源平台或指定出口。
- 路由审计 UI：查看消息、决策、投递、错误和回传链路。

## 路线图草案

未来配置形态会接近：

```yaml
targets:
  codex-desktop:
    type: codex_desktop_ipc
    thread_name: "QQ 消息监听"

  cc-codex:
    type: cc_connect_bridge
    url: "ws://127.0.0.1:9810/bridge/ws"
    project: "codex"

  astrbot:
    type: webhook
    url: "http://127.0.0.1:6185/webhook"

routes:
  - name: code-to-codex
    match:
      keywords: ["bug", "报错", "代码", "git", "构建失败"]
    prompt_profile: "code-helper"
    target: cc-codex

  - name: reply-to-desktop
    match:
      route_kind: ["direct_reply", "indirect_reply"]
    prompt_profile: "qq-context"
    target: codex-desktop

  - name: default-mention
    match:
      mention: true
    prompt_profile: "default"
    target: astrbot
```

当前版本仍以 QQ / NapCat + Codex Desktop 为第一条可用链路。

## 目录结构

- `src/`：本地网关和网关管理器源码。
- `napcat-plugin-codex-gateway/`：NapCat 插件目录，包含 `package.json`、`index.mjs` 和 `webui/`，符合 NapCat 插件加载机制。
- `gateways.example.json`：多网关示例配置。

以下运行期文件不会提交到仓库：

- `.env`
- `gateways.json`
- `data/`
- `dist/`
- `node_modules/`

## 启动网关

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
copy gateways.example.json gateways.json
npm run start:manager
```

默认端口：

- 网关管理器：`http://127.0.0.1:8790`
- NapCat 反向 WebSocket 地址：`ws://127.0.0.1:8789`
- NapCat HTTP API 地址：`http://127.0.0.1:3000`

## NapCat 网络配置

在 NapCat WebUI 里配置：

- WebSocket 客户端：`ws://127.0.0.1:8789`
- HTTP 服务器：主机 `127.0.0.1`，端口 `3000`

WebSocket 客户端用于接收 QQ 消息事件。HTTP 服务器用于让网关主动发送 QQ 消息或调用 OneBot API。

## 转发目标

默认使用 Codex Desktop IPC 转发消息。也可以在环境变量或 `gateways.json` 里配置：

```text
FORWARD_TARGETS=codexDesktop
```

当前内置目标：

- `codexDesktop`：发送到当前 Codex Desktop 固定线程，支持运行中追加引导。
- `codexApp`：旧的 app-server 调试通道，主要用于旁路验证。

## 安装 NapCat 插件

把 `napcat-plugin-codex-gateway` 目录复制到 NapCat 插件目录，然后在 NapCat 插件管理里启用。

示例插件目录：

```text
NapCat.*/resources/app/napcat/plugins/napcat-plugin-codex-gateway
```

插件会注册：

- 页面：`gateways`
- API：`/plugin/napcat-plugin-codex-gateway/api/...`
- 静态资源目录：`webui/`

NapCat 插件页会提供入口跳转到独立控制台：

```text
http://127.0.0.1:8790/
```

## 群消息路由

群消息进入 Codex 的路由分为三类：

- 直接 @：当前消息本身直接 @ 机器人。
- 直接回复：当前消息直接回复机器人。QQ 回复通常会自动带 @，这类会优先归到“直接回复”。
- 间接回复：当前消息回复了某个用户，而被回复的那条消息里曾经 @ 过机器人。

私聊消息使用独立的私聊模板。

公开示例配置使用脱敏的机器人昵称和工作目录。实际使用时请在 NapCat 插件页面或 `gateways.json` 里填写自己的 `botNickname`、`codexCwd`、`targetGroupId` 和模板内容。

模板里可以使用以下变量：

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{message} {rawMessage} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {dataDir} {groupLogPath} {privateLogPath}
```

## 开发

```powershell
npm run build
npm run start:manager
```

本地调试插件时，把 `napcat-plugin-codex-gateway/` 里的文件复制到 NapCat 插件目录，然后重新加载插件。
