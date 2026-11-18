[English](README_en.md)

# QQ 官方机器人

在 RibiWebGUI 打开 **Route → 消息端 → QQ 官方机器人**。添加机器人并填写 AppID 和 AppSecret。可用腾讯沙箱验证。同一 AppID 可分别添加沙箱和正式环境的账号。密钥进入本机受保护存储，Route 保存账号引用与事件接收设置。

1. 选择账号、接收方式和目标 Agent，然后保存 Route。WebSocket 使用腾讯已授予的 intents。在运行日志查看 `ready` 或平台关闭码。
2. 使用 Webhook 时，将公网 HTTPS 地址反向代理到卡片显示的本机 `/qqbot` 地址，保留原请求体。在 [QQ 开放平台](https://q.qq.com/) 配置回调和事件订阅。每个机器人的回调地址对应一条接收 Route。
3. 在腾讯沙箱验证单聊、群聊、频道和频道私信。消息保留原会话身份、附件地址和平台事件。成员、互动、审核等事件可通过「QQ 机器人平台事件」规则投给 Agent。

## 发送与管理

兼容 Manager 的发送能力目录公布 `qqbot.source-reply`。使用原消息的 `sourceMessageId` 和 `data.text`，由插件核对原 Route、机器人账号与平台消息 ID。

普通原消息文本回复使用 `agent.send` 的 `qqbot` 渠道。Route 的 QQ 外发与频道管理可独立设置，默认可用。需要主动发消息、撤回、富媒体、Markdown、按钮、Ark、流式消息或互动确认时，在 Rabi 能力目录搜索「QQ 官方机器人」，调用相应的 `manager.qqbot.platform.*` 操作。查询和管理接口还覆盖频道、子频道、成员、身份组与权限、表态、精华、公告、论坛、日程和语音控制。可执行接口与腾讯路径见 [平台目录](src/catalog.ts)。

群和单聊的媒体上传返回 `file_info`，可用于发送。分片上传支持在一次操作中提交最多 32 MiB 的附件，也可按腾讯的分片接口分步提交。频道图片消息接受 HTTPS 图片地址或本地图片的 Base64 表示。接口能否调用取决于当前机器人的平台权限、沙箱范围与内容配额。[腾讯 API](https://bot.q.qq.com/wiki/develop/api-v2/) · [腾讯 Node SDK](https://github.com/tencent-connect/qqbot-nodejs)

平台写入使用当前 Manager 身份和一条稳定的 `Idempotency-Key`。超时后按原 Route 和编号查询回执，平台状态与 Rabi 回执状态均可查看。
