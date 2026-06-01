# NapCatCodexGateway

这是一个 NapCat 到 Codex Desktop 的 QQ 消息网关。它负责把 QQ 群聊和私聊消息转发到固定的 Codex 会话里，并提供一个 NapCat 插件页面，用来管理多个网关、选择 NapCat 网络配置、编辑发送给 Codex 的消息模板。

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
cd C:\Data\CottonProject\qq-agent-gateway
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

## 群消息路由

群消息进入 Codex 的路由分为三类：

- 直接 @：当前消息本身直接 @ 机器人。
- 直接回复：当前消息直接回复机器人。QQ 回复通常会自动带 @，这类会优先归到“直接回复”。
- 间接回复：当前消息回复了某个用户，而被回复的那条消息里曾经 @ 过机器人。

私聊消息使用独立的私聊模板。

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
