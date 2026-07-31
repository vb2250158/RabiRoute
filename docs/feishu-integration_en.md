# Feishu as an independent message endpoint

Feishu uses its own `feishu` adapter, `feishu_message` route kind, per-`chat_id` conversation context, and Feishu application API for outbound replies. It never reads or reuses the generic Webhook endpoint or a group-bot webhook.

The listener remains off until App ID, App Secret, Verification Token, Encrypt Key, and the explicit `feishuEventSubscriptionEnabled: true` confirmation are all present. Outbound delivery requires the application credentials and the same subscription confirmation.

Configure an internal Feishu application, enable its bot, expose the configured local callback through operator-managed HTTPS, and subscribe to `im.message.receive_v1`. Keep `feishuEventSubscriptionEnabled` false until those platform-side steps are complete.

Inbound events are verified using the raw-body Feishu signature and a five-minute timestamp window. Encrypted callbacks are verified before AES-256-CBC decryption. V2 `header.event_id` values are persisted in `feishu-messages.jsonl` for restart-safe deduplication; callback secrets and full raw payloads are not stored.

Each source `chat_id` owns a separate conversation key. Text replies are sent only to that source chat through `im/v1/messages?receive_id_type=chat_id`; there is no fallback to NapCat or generic Webhook.

See the [event subscription overview](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview?lang=en-US), [Encrypt Key and signature guide](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case?lang=en-US), and [send message API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create).
