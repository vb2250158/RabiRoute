# RabiRoute

![RabiRoute 拉比路由](assets/rabiroute-hero.png)

RabiRoute 是一个轻量 **Message Gateway / Policy Router**。它站在聊天平台、定时器、Webhook 和处理端之间，负责把一条消息规范化、分诊、补上下文、套模板，再投递给合适的 Agent、脚本、工作流或人工队列。

它更像分诊台、调度台或转运中心：

```text
QQ / Webhook / Scheduler / CLI
        ↓
    RabiRoute
        ↓
消息记录 → 路由规则 → 上下文模板 → 处理端选择
        ↓
Agent / Workflow / Script / Human Queue / External API
```

一句话：

```text
处理端解决 “具体怎么做”。
RabiRoute 解决 “这件事该送到哪里、带什么材料、按什么规则流转”。
```

RabiRoute 不是一个完整个人 Agent OS，不是聊天机器人框架替代品，也不是某个 AI 工具的外壳。Codex Desktop 只是当前第一条已验证处理端；项目边界是消息级分诊和策略调度。

GitHub: https://github.com/vb2250158/RabiRoute

更深入的分层和演进说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 当前能力

- NapCat / OneBot WebSocket 接入 QQ 群聊和私聊。
- 独立 WebUI 管理多个 Gateway：`http://127.0.0.1:8790/`。
- NapCat 插件入口，可从 NapCat 插件页跳转到 RabiRoute 控制台。
- 同一 Gateway 可启用多个消息适配端：NapCat / OneBot、定时触发、预留 Webhook、禁用消息端。
- 群消息路由：直接 @、直接回复、间接回复、普通群消息关键词规则。
- 私聊消息路由。
- 定时触发 `heartbeat` 路由，用于周期巡检和提醒。
- JSONL 消息记录、心跳记录、投递记录。
- 可编辑 Prompt 模板和路由规则。
- 路由人格包：每个角色用 `persona.md` 定义说话和判断方式，用 `routes.json` 定义它自己的触发规则和模板。
- 处理端：当前支持 Codex Desktop IPC 和旧调试通道 `codexApp`。

规划中：

- 统一 `InboundMessage` 和 `RouteDecision`。
- Route DSL。
- Target / Handler Registry。
- Webhook target。
- 路由审计、回放和 Action Queue。
- 高风险动作先生成待审草稿，再由人确认执行。

## 快速上手

### 1. 准备环境

需要：

- Node.js 20+ 或更新版本。
- 一个可用的 NapCat / OneBot 环境。如果只想先体验 WebUI 和定时触发，可以暂时不接 QQ。
- 可选：Codex Desktop，用作默认处理端。

### 2. 安装和构建

Windows PowerShell：

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
copy gateways.example.json gateways.json
npm run start:manager
```

macOS / Linux：

```bash
cd /path/to/RabiRoute
npm install
npm run build
cp gateways.example.json gateways.json
npm run start:manager
```

打开：

```text
http://127.0.0.1:8790/
```

默认端口：

- RabiRoute 管理器：`http://127.0.0.1:8790`
- NapCat 反向 WebSocket：`ws://127.0.0.1:8789`
- NapCat HTTP API：`http://127.0.0.1:3000`

### 3. 配置第一个 Gateway

首次启动时，如果没有 `gateways.json`，manager 会从 `gateways.example.json` 复制一份。

在 WebUI 里重点检查：

- `消息适配端`：默认启用 `NapCat / OneBot` 和 `定时触发`。
- `Agent 端`：填写处理端线程名和工作目录，例如 Codex Desktop 的监听线程。
- `通用配置`：确认 Gateway 端口、NapCat HTTP 地址、数据目录。
- `路由人格`：选择或创建角色。想用示例 Rabi 时，先把 `examples/roles/Rabi/` 复制到当前 gateway 的 `rolesDir`。
- `消息规则`：确认哪些 route kind 会转发给处理端。

如果只想本地试跑定时触发，可以把消息适配端设为 `heartbeat`，不用接 NapCat。

### 4. 配置 NapCat

在 NapCat WebUI 里配置：

- WebSocket 客户端：`ws://127.0.0.1:8789`
- HTTP 服务器：主机 `127.0.0.1`，端口 `3000`

WebSocket 客户端用于接收 QQ 消息事件。HTTP 服务器用于后续主动发送 QQ 消息或调用 OneBot API。

如果 NapCat 新增插件或修改 OneBot 网络配置后没有生效，通常需要重启 QQ/NapCat，或在 NapCat WebUI 中保存并重载网络配置。

### 5. 验证链路

1. 启动 manager：`npm run start:manager`。
2. 打开 WebUI，确认 gateway 为运行中。
3. 在 NapCat 侧确认 WebSocket 已连到 `127.0.0.1:8789`。
4. 在 QQ 群里 @ 机器人，或发一条私聊。
5. 查看 `data/<gateway-id>/` 下是否出现消息记录和投递记录。
6. 如果使用 Codex Desktop，确认指定线程收到了转发提示。

## 目录结构

```text
src/                                RabiRoute manager、gateway、adapter、forwarding 源码
napcat-plugin-codex-gateway/         NapCat 插件入口和 WebUI
examples/roles/Rabi/                 可开源示例人格
skills/create-rabiroute-persona/     项目内 skill：指导创建 RabiRoute 人格
assets/                              README 和 WebUI 视觉资源
gateways.example.json                多 gateway 示例配置
ARCHITECTURE.md                      架构边界和演进说明
```

运行期文件默认不提交：

```text
.env
gateways.json
data/
dist/
node_modules/
```

## Gateway 配置

核心配置在 `gateways.json`：

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
      "codexCwd": "C:\\Path\\To\\Your\\Project",
      "forwardTargets": ["codexDesktop"],
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
- `gatewayPort`：NapCat WebSocket Client 连接的端口。
- `napcatHttpUrl`：OneBot HTTP API 地址。
- `forwardTargets`：处理端列表。当前支持 `codexDesktop`、`codexApp`。
- `codexThreadName`：Codex Desktop 固定线程名。
- `codexCwd`：处理端收到任务后应工作的目录。
- `dataDir`：消息记录、投递记录和心跳记录目录。
- `rolesDir`：路由人格目录。
- `agentRoleId`：当前 gateway 使用的角色目录名。
- `notificationRules`：路由规则列表。

## 消息适配端

当前可用：

- `napcat`：通过 OneBot WebSocket 接收 QQ 事件，通过 OneBot HTTP 预留主动调用能力。
- `heartbeat`：按固定间隔生成内部 `heartbeat` 路由事件，适合周期巡检。
- `disabled`：不监听外部消息，只保留配置和角色。

预留：

- `webhook`：后续用于企业微信、飞书、Discord、Slack、Telegram 或内部系统。

新增平台时，优先在 `src/adapters/` 新增 adapter，并输出统一消息记录和路由事件，不要把新平台逻辑塞进 NapCat adapter。

## 路由规则

路由规则决定一条消息是否转发给处理端，以及使用哪段模板。

```json
{
  "id": "group-direct-at",
  "name": "直接 @ 模板",
  "enabled": true,
  "targetGroupId": "",
  "regex": "",
  "template": "QQ 消息更新提醒：群聊里有人 @ 了机器人。\n时间：{time}\n目标：{messageTarget}\n发送者：{sender}\n消息：{message}\n\n请在需要时读取 {groupLogPath} 查看上下文。",
  "routeKinds": ["direct_at"]
}
```

支持的 route kind：

- `direct_at`：群聊直接 @ 机器人。
- `direct_reply`：当前消息直接回复机器人。
- `indirect_reply`：当前消息回复了某条曾经 @ 机器人的消息。
- `group_message`：普通群聊消息，通常配合 `regex` 使用。
- `private`：私聊消息。
- `heartbeat`：定时触发消息。

`regex` 会匹配规范化后的 `routeText`，也会在间接回复场景中匹配 `repliedRouteText`。它支持变量展开，例如 `{RobotQQId}`、`{SenderQQId}`、`{GroupId}`、`{ReplyMessageId}`。

模板常用变量：

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{RobotQQId} {SenderQQId} {GroupId} {ReplyMessageId}
{message} {rawMessage} {routeText} {repliedRouteText} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {agentRoleId} {agentRolePath} {agentRoleDir}
{dataDir} {groupLogPath} {privateLogPath} {heartbeatLogPath}
{heartbeatIntervalSeconds}
```

## 路由人格

RabiRoute 的“人格”不是单独一段 prompt，而是一个角色包。角色包同时决定两件事：

- `persona.md`：这个角色如何说话、如何判断消息、如何整理上下文、哪些事不能做。
- `routes.json`：这个角色关心哪些 route kind、普通群消息用什么关键词触发、命中后给处理端什么模板。

一个角色目录通常包含：

```text
<RoleId>/
├── persona.md
└── routes.json
```

公开示例：

- `examples/roles/Rabi/persona.md`
- `examples/roles/Rabi/routes.json`

Rabi 示例是一个轻量公开样例，主要演示 `persona.md` 和 `routes.json` 如何配合。真实项目可以在本地 `data/roles/<RoleId>/` 里扩展更完整的直接 @、回复、私聊、关键词和心跳规则。

本地使用时，可以复制到 gateway 的角色目录：

```powershell
mkdir data\default-main\roles
copy examples\roles\Rabi\persona.md data\default-main\roles\Rabi\persona.md
copy examples\roles\Rabi\routes.json data\default-main\roles\Rabi\routes.json
```

然后在 WebUI 的 `路由人格` 中选择 `Rabi`。选择人格后，转发给处理端的提示末尾会追加角色文件路径，消息记录也会写入该角色目录。

项目内还提供了一个开源 skill，用来指导创建新人格：

- `skills/create-rabiroute-persona/SKILL.md`

它说明了如何一起设计 `persona.md` 和 `routes.json`，让角色既有稳定气质，也有对应的路由触发策略。

## 处理端

当前内置处理端：

- `codexDesktop`：通过 Codex Desktop IPC 投递到固定线程。空闲时 `start`，运行中用 `steer` 追加引导。
- `codexApp`：旧 app-server 调试通道，主要用于旁路验证。

默认建议使用：

```json
"forwardTargets": ["codexDesktop"]
```

如果处理端没有收到消息，优先检查：

- WebUI 中 gateway 是否运行。
- `data/<gateway-id>/codex-notifications.jsonl` 是否有投递记录。
- `codexThreadName` 是否能匹配到 Codex Desktop 中的线程。
- `codexCwd` 是否是处理端应工作的项目目录。

## NapCat 插件

仓库包含一个 NapCat 插件目录：

```text
napcat-plugin-codex-gateway/
```

把该目录复制到 NapCat 插件目录后启用。示例路径：

```text
NapCat.*/resources/app/napcat/plugins/napcat-plugin-codex-gateway
```

插件会注册：

- 页面：`gateways`
- API：`/plugin/napcat-plugin-codex-gateway/api/...`
- 静态资源目录：`webui/`

插件页会提供入口跳转到 RabiRoute 独立控制台：

```text
http://127.0.0.1:8790/
```

## 开发

常用命令：

```powershell
npm run build
npm run start:manager
```

开发期也可以直接用 TypeScript：

```powershell
npm run manager
```

源码入口：

- `src/manager.ts`：读取 `gateways.json`、启动/停止 gateway、提供 WebUI API。
- `src/index.ts`：单个 gateway 入口。
- `src/adapters/`：消息适配端。
- `src/forwarding.ts`：路由规则匹配、模板渲染、投递处理端。
- `src/config.ts`：环境变量和默认配置。
- `src/history.ts`：JSONL 记录。

本地调试 NapCat 插件时，把 `napcat-plugin-codex-gateway/` 复制到 NapCat 插件目录，然后重新加载插件。

## 常见问题

### NapCat 已连接，但处理端没有收到消息

先看 `data/<gateway-id>/`：

- 有 `group-messages.jsonl` 或 `private-messages.jsonl`：说明 QQ 到 RabiRoute 已通。
- 有 `codex-notifications.jsonl`：说明路由规则已命中并尝试投递。
- 没有投递记录：检查 `notificationRules`、`routeKinds`、`regex` 和目标群过滤。

### `Missing monitorThreadId`

说明 RabiRoute 没找到对应 Codex Desktop 线程。先打开或创建用于处理 QQ 消息的 Codex 线程，再通过 WebUI 绑定；也可以检查 `data/<gateway-id>/codex-state.json`。

### macOS 上 `connect ENOENT /tmp/codex-ipc/...`

Codex Desktop 的 socket 可能不在 `/tmp`。当前版本会依次尝试 `CODEX_DESKTOP_IPC_PATH`、`os.tmpdir()/codex-ipc/ipc-<uid>.sock` 和 `/tmp/codex-ipc/ipc-<uid>.sock`。仍失败时可临时指定：

```bash
export CODEX_DESKTOP_IPC_PATH="/var/folders/.../T/codex-ipc/ipc-501.sock"
npm run start:manager
```

### 普通群消息没有转发

普通群消息默认不会无条件转发。需要添加 `group_message` 规则，并填写合适的 `regex`，例如：

```text
需求|报错|构建失败|提醒|记一下
```
