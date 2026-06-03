# RabiRoute

![RabiRoute 拉比路由](assets/rabiroute-hero.png)

拉比路由是一个面向聊天入口和处理端的轻量 **Message Gateway / Policy Router**。

它更像分诊台、调度台或转运中心：消息从 QQ、微信、Webhook、定时任务等入口进来以后，RabiRoute 先判断“这是什么事、该送到哪里、要带哪些材料、要不要审批、结果回到哪里”。真正写代码、回答问题、跑流程、查知识库或调用外部系统的，是后面的处理端。

所以 RabiRoute 不是某个 AI 助手的外壳，也不是某个聊天机器人框架的替代品。它是消息流转之前的分诊和调度层。

当前实现已经支持把 NapCat / OneBot 的 QQ 群聊和私聊消息转发到固定的 Codex Desktop 会话里，并提供独立 WebUI 与 NapCat 插件入口，用来管理多个网关、选择 NapCat 网络配置、编辑消息转发模板。Codex Desktop 只是第一条验证链路，不是 RabiRoute 的产品边界；代码里已经把消息路由、模板渲染和目标投递拆开，后续会继续升级为可配置的 Route DSL 和 Target / Handler Registry。

GitHub: https://github.com/vb2250158/RabiRoute

架构说明：[ARCHITECTURE.md](ARCHITECTURE.md)

## 项目定位

RabiRoute 不计划做成某个 Agent、某个执行工具、某个聊天机器人或某个工作流平台的替代品。它更适合站在这些系统前面，做消息级分诊和策略调度：

```text
QQ / Webhook / CLI / HTTP API / Scheduler
        ↓
    RabiRoute
        ↓
统一事件 → 路由规则 → Context 包装 → 策略判断 → 处理端选择
        ↓
Agent / Workflow / Script / Human Queue / External API
```

一句话：

```text
处理端解决 “具体怎么做”。
RabiRoute 解决 “这件事该送到哪里、带什么材料、按什么规则流转”。
```

## 当前状态

已实现：

- NapCat / OneBot WebSocket 接入 QQ 群聊和私聊。
- 群消息路由：直接 @、直接回复、间接回复。
- 私聊消息路由。
- JSONL 消息记录和投递记录。
- 模板化 Prompt / 消息包装。
- Codex Desktop IPC 投递，支持固定线程 `start` 和运行中 `steer`。
- 独立 WebUI：`http://127.0.0.1:8790/`。
- NapCat 插件入口：在 NapCat 插件页跳转到独立 WebUI。

规划中：

- 统一 `InboundMessage` 事件模型。
- Route DSL：按平台、群、用户、关键词、route kind、意图等条件选择目标。
- Target / Handler Registry：支持 Agent、Workflow、Webhook、Script、Human Queue、External API 等处理端。
- 双向路由：处理端输出经过模板包装后回到源平台或指定出口。
- 路由审计 UI：查看消息、决策、投递、错误和回传链路。

## 路线图草案

未来配置形态会接近：

```yaml
targets:
  code-workbench:
    type: agent
    driver: codex_desktop_ipc
    thread_name: "QQ 消息监听"

  qa-flow:
    type: webhook
    url: "http://127.0.0.1:6185/knowledge-webhook"

  human-review:
    type: human_queue
    queue: "manual-review"

routes:
  - name: code-question
    match:
      keywords: ["bug", "报错", "代码", "git", "构建失败"]
    prompt_profile: "code-helper"
    target: code-workbench

  - name: group-reply
    match:
      route_kind: ["direct_reply", "indirect_reply"]
    prompt_profile: "qq-context"
    target: code-workbench

  - name: default-question
    match:
      mention: true
    prompt_profile: "knowledge-helper"
    target: qa-flow

  - name: risky-action
    match:
      intent: ["send_message", "write_external_system"]
    target: human-review
```

当前版本仍以 QQ / NapCat + Codex Desktop 为第一条可用链路；这里的 Codex Desktop 只是一个已验证的处理端。

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

macOS 上同样使用这些命令启动，只是路径示例换成实际仓库目录：

```bash
cd /Users/<user>/Documents/RabiRoute
npm install
npm run build
cp gateways.example.json gateways.json
npm run start:manager
```

## NapCat 网络配置

在 NapCat WebUI 里配置：

- WebSocket 客户端：`ws://127.0.0.1:8789`
- HTTP 服务器：主机 `127.0.0.1`，端口 `3000`

WebSocket 客户端用于接收 QQ 消息事件。HTTP 服务器用于让网关主动发送 QQ 消息或调用 OneBot API。

## 处理端

默认使用 Codex Desktop IPC 转发消息。也可以在环境变量或 `gateways.json` 里配置：

```text
FORWARD_TARGETS=codexDesktop
```

当前内置处理端：

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

## macOS 部署排障

如果 NapCat 有消息、RabiRoute 日志也出现了 `NapCat connected from 127.0.0.1`，说明 QQ 到 RabiRoute 的链路已经通了。后续常见问题通常在 Codex Desktop 投递阶段：

- `Missing monitorThreadId in .../codex-state.json`：还没有绑定 Codex 目标线程。先打开或创建用于处理 QQ 消息的 Codex 线程，再通过 RabiRoute 管理台绑定；也可以确认 `data/<gateway-id>/codex-state.json` 里已有 `monitorThreadId`。
- `connect ENOENT /tmp/codex-ipc/ipc-501.sock`：旧版本只查 `/tmp`，但 macOS 上 Codex Desktop 的 socket 常在 `/var/folders/.../T/codex-ipc/ipc-501.sock`。当前版本会自动依次尝试 `CODEX_DESKTOP_IPC_PATH`、`os.tmpdir()/codex-ipc/ipc-<uid>.sock` 和 `/tmp/codex-ipc/ipc-<uid>.sock`。如果仍失败，可以临时指定：

```bash
export CODEX_DESKTOP_IPC_PATH="/var/folders/.../T/codex-ipc/ipc-501.sock"
npm run start:manager
```

NapCat 新增插件、修改 OneBot 网络配置后通常不会完全热加载。配置写入后如果 `3000` / `3003` 这类 HTTP 端口没监听，或 WebSocket 客户端没有连到 RabiRoute，需要重启 QQ/NapCat，或者在 NapCat WebUI 里保存并重载网络配置。

## 群消息路由

群消息触发转发的路由分为三类：

- 直接 @：当前消息本身直接 @ 机器人。
- 直接回复：当前消息直接回复机器人。QQ 回复通常会自动带 @，这类会优先归到“直接回复”。
- 间接回复：当前消息回复了某个用户，而被回复的那条消息里曾经 @ 过机器人。

私聊消息使用独立的私聊模板。

公开示例配置使用脱敏的机器人昵称和工作目录。实际使用时请在 NapCat 插件页面或 `gateways.json` 里填写自己的 `botNickname`、`codexCwd`、`targetGroupId` 和模板内容。

私聊发送给 Codex 的附加信息来自 WebUI 里的“私聊消息模板”，对应 `gateways.json` 的 `privateNotificationTemplate`。模板保存后 manager 会自动重启对应 gateway，让新的环境变量生效；如果使用的是旧版本，保存后还需要手动点击该 gateway 的 Restart。

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
