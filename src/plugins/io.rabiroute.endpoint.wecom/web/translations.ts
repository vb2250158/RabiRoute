export const pluginTranslations = {
  "en": {
    "可留空使用 WECOM_BOT_ID": "Leave empty to use WECOM_BOT_ID",
    "可留空使用 WECOM_BOT_SECRET": "Leave empty to use WECOM_BOT_SECRET",
    "留空使用 SDK 默认地址；私有部署时填写": "Leave empty for the SDK default; set this for a private deployment",
    "企业微信消息端使用智能机器人 WebSocket 长连接，主场景是企业微信群聊；模板变量会尽量对齐 NapCat 的 groupId、userId、sender、message 和 messageId。": "The WeCom input uses the intelligent bot's persistent WebSocket connection, primarily for group chat. Template variables align with NapCat's groupId, userId, sender, message, and messageId where possible.",
    "企业微信适配器日志": "WeCom adapter log",
    "连接、认证、消息接收和错误日志。": "Connection, authentication, message-receive, and error logs.",
    "暂无企业微信适配器日志": "No WeCom adapter log"
  },
  "ja": {
    "可留空使用 WECOM_BOT_ID": "WECOM_BOT_ID を使用するには空のままにしてください",
    "可留空使用 WECOM_BOT_SECRET": "WECOM_BOT_SECRET を使用するには空のままにしてください",
    "留空使用 SDK 默认地址；私有部署时填写": "SDK のデフォルトの場合は空のままにします。これをプライベート展開用に設定します",
    "企业微信消息端使用智能机器人 WebSocket 长连接，主场景是企业微信群聊；模板变量会尽量对齐 NapCat 的 groupId、userId、sender、message 和 messageId。": "WeCom入力は、主にグループチャットのために、インテリジェントボットの永続的なWebSocket接続を使用する。テンプレート変数は、可能な場合、NapCat の groupId、userId、sender、message、および messageId と一致します。",
    "企业微信适配器日志": "WeComアダプターログ",
    "连接、认证、消息接收和错误日志。": "接続、認証、メッセージ受信、およびエラーのログ。",
    "暂无企业微信适配器日志": "WeComアダプターログがありません"
  }
} as const;
