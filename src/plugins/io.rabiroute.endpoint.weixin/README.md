# 微信机器人

[English](README_en.md)

在 WebGUI 的 **Route → 消息端 → 微信机器人** 启用并保存 Route。选「绑定本人微信」或「邀请他人绑定」，生成二维码后按手机提示完成扫码、实名授权或验证码。已登录的 Route 可以在同一张卡片退出登录。账号凭据保存在本机受保护的运行期存储。

微信机器人通过腾讯 iLink 接收文字、引用、图片、语音及转写、文件和视频。消息进入统一聊天记录，再按 Route 的规则投给 Agent。Agent 通过 `agent.send` 发送文字、图片、文件或原生 MP4 视频。可在 Rabi 能力目录查询 `manager.weixin.typing` 设置或取消输入状态。

当前腾讯官方客户端提供私聊接入，媒体发送流程提供图片、视频和文件。参见 [腾讯 iLink 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)。

换版时旧实例取消长轮询，等待已接纳的消息完成直接投递或交给宿主队列。整批接纳后才保存新游标。换版中断批次时保留旧游标和已接纳的会话上下文，新实例用原登录凭据从旧游标继续轮询，并按持久消息 ID 跳过已记录项。完整的投递等待依赖宿主提供 `forwardMessageWithCompletion`。
