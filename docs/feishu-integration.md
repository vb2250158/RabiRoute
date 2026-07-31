# 飞书独立消息端接入

飞书使用独立的 `feishu` adapter、`feishu_message` 路由类型、按 `chat_id` 隔离的会话上下文，以及飞书应用 API 出站。它不会读取或复用通用 Webhook、群机器人 Webhook 或其密钥。

## Fail-closed 前提

只有以下条件全部满足，Gateway 才会在 `127.0.0.1:<feishuWebhookPort>` 启动飞书回调监听：

- `feishuAppId` 与 `feishuAppSecret`
- `feishuVerificationToken`
- `feishuEncryptKey`
- `feishuEventSubscriptionEnabled: true`
- Route 启用 `feishu`，且该 adapter 的 `inputEnabled` 没有关闭

Outbox 同样要求 App ID、App Secret 与 `feishuEventSubscriptionEnabled: true`；否则只返回 `blocked` 草稿，不调用飞书 API。

## 最小配置

```json
{
  "messageAdapters": ["feishu"],
  "feishuAppId": "<FEISHU_APP_ID>",
  "feishuAppSecret": "<FEISHU_APP_SECRET>",
  "feishuVerificationToken": "<FEISHU_VERIFICATION_TOKEN>",
  "feishuEncryptKey": "<FEISHU_ENCRYPT_KEY>",
  "feishuWebhookPort": 8791,
  "feishuWebhookPath": "/feishu",
  "feishuEventSubscriptionEnabled": false,
  "messageAdapterPolicies": {
    "feishu": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text"]
    }
  }
}
```

先在飞书开放平台创建企业自建应用，启用机器人能力，配置事件订阅的公网 HTTPS 回调，并订阅 `im.message.receive_v1`。平台侧配置完成后，才把 `feishuEventSubscriptionEnabled` 改为 `true` 并保存/重启 Route。

## 入站安全和幂等

- URL challenge 使用配置的 Verification Token 验证。
- 普通回调要求 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature`，签名覆盖原始请求体，并拒绝超过五分钟的时间戳。
- 启用 Encrypt Key 的回调会先验签，再用 AES-256-CBC 解密。
- 飞书 v2 `header.event_id` 是持久去重键。已接收记录写入 `feishu-messages.jsonl`；进程重启后仍会拒绝重复投递。
- 持久记录不会保存 Verification Token、Encrypt Key、密文或完整原始回调。

## 会话与回复

每个来源 `chat_id` 使用独立会话键 `feishu:...:chat:<chat_id>`。Outbox 只把文本回复发回该来源 chat，使用飞书 `im/v1/messages?receive_id_type=chat_id` API；不会回退到 NapCat 或通用 Webhook。

运行状态位于 `gateway-status.json` 的 `messageAdapters.feishu`，可观察 `listenerReady`、`subscriptionVerified`、`lastMessageAt` 与 `lastEventId`。

协议参考：[飞书事件订阅概览](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=zh-CN)、[Encrypt Key 与签名](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case?lang=zh-CN)、[发送消息 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)。
