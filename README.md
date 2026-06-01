# NapCat Codex Gateway

NapCat Codex Gateway lets NapCat forward QQ group/private messages into a fixed Codex Desktop thread, while a NapCat WebUI plugin manages gateway instances and message templates.

## Repository Layout

- `src/`: local gateway and manager service.
- `napcat-plugin-codex-gateway/`: NapCat plugin package, following NapCat plugin mechanism with `package.json`, `index.mjs`, and `webui/`.
- `gateways.example.json`: example multi-gateway configuration.

Runtime files are intentionally ignored:

- `.env`
- `gateways.json`
- `data/`
- `dist/`
- `node_modules/`

## Gateway Setup

```powershell
cd C:\Data\CottonProject\qq-agent-gateway
npm install
npm run build
copy gateways.example.json gateways.json
npm run start:manager
```

Default ports:

- Gateway manager: `http://127.0.0.1:8790`
- NapCat reverse WebSocket target: `ws://127.0.0.1:8789`
- NapCat HTTP API: `http://127.0.0.1:3000`

## NapCat Network Setup

In NapCat WebUI, configure:

- WebSocket Client: `ws://127.0.0.1:8789`
- HTTP Server: host `127.0.0.1`, port `3000`

The WebSocket Client receives QQ events. The HTTP Server is used by the gateway to send QQ messages or call OneBot APIs.

## NapCat Plugin Install

Copy `napcat-plugin-codex-gateway` into NapCat's plugin directory, then enable it in NapCat plugin management.

Example plugin directory:

```text
NapCat.*/resources/app/napcat/plugins/napcat-plugin-codex-gateway
```

The plugin registers:

- Page: `gateways`
- API: `/plugin/napcat-plugin-codex-gateway/api/...`
- Static assets: `webui/`

## Message Routes

Group messages are routed into Codex in three cases:

- Direct at: current message directly mentions the bot.
- Direct reply: current message directly replies to the bot.
- Indirect reply: current message replies to another user, and the replied message mentioned the bot.

Private messages are routed separately through the private-message template.

Available template variables include:

```text
{routeKind} {time} {targetType} {targetId} {messageTarget}
{groupId} {userId} {selfId} {sender} {senderName}
{message} {rawMessage} {messageId}
{repliedMessageId} {repliedMessage}
{botNickname} {dataDir} {groupLogPath} {privateLogPath}
```

## Development

```powershell
npm run build
npm run start:manager
```

For local plugin iteration, copy updated files from `napcat-plugin-codex-gateway/` into the NapCat plugin directory and reload the plugin.
