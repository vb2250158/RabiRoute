[简体中文](README.md)

# Official QQ Bot

Add Official QQ Bot with **Add message endpoint** and choose **Connect** on its card. Scan with mobile QQ, choose a bot on your phone, then save the account binding in the browser. **More connection options** lets you choose a saved account or enter an AppID and AppSecret, including sandbox credentials. RabiRoute protects the credentials in local storage. Configure event transport in the automation settings opened by the gear.

1. The Route configuration controls the event transport. Use Tencent-authorized intents for WebSocket and check the Route log for `ready` or the platform's close code.
2. For Webhook, reverse proxy a public HTTPS URL to the local `/qqbot` address configured for the Route and preserve the original request body. Configure the callback and subscriptions in the [QQ Open Platform](https://q.qq.com/). Each bot's platform callback points to one receiving Route.
3. Use Tencent's sandbox to verify direct, group, channel and channel direct messages. Incoming messages retain their conversation identity, attachments and event data. Rules using the QQ Bot platform event trigger can forward membership, interaction and audit events to an Agent.

## Sending and administration

A compatible Manager advertises `qqbot.source-reply`. Supply the original `sourceMessageId` and `data.text`. The plugin verifies the original Route, bot account, and platform message ID.

Use the `qqbot` channel of `agent.send` for text replies to source messages. Message output and channel administration are independently configurable per Route and enabled by default. For proactive messages, recall, rich media, Markdown, buttons, Ark, streaming, or interaction acknowledgement, search Rabi for Official QQ Bot and use the corresponding `manager.qqbot.platform.*` operation. Read and administration operations also cover guilds, channels, members, roles, permissions, reactions, pins, announcements, forums, schedules and audio controls. The [platform catalog](src/catalog.ts) lists executable operations and Tencent paths.

Group and direct media uploads return reusable `file_info`. Upload files of up to 32 MiB through the managed chunked operation, or use Tencent's individual upload steps. Channel images accept an HTTPS image URL or Base64 image data. Availability depends on the bot's platform permissions, sandbox scope, and content quotas. [Tencent API](https://bot.q.qq.com/wiki/develop/api-v2/) · [Tencent Node SDK](https://github.com/tencent-connect/qqbot-nodejs)

Platform mutations require the current Manager identity and a stable `Idempotency-Key`. After a timeout, read the original receipt by Route and request ID. The receipt includes both the Rabi delivery state and the platform response.
