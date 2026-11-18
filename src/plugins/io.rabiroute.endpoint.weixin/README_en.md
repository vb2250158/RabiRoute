# WeChat Bot

[中文](README.md)

Enable and save **Route → Message endpoints → WeChat Bot**. Choose your own account or an invitation. Scan the QR code and follow mobile WeChat's identity or PIN prompts if shown. Sign out from the same card. RabiRoute protects credentials in local runtime storage.

The Tencent iLink integration receives text, quotes, images, voice and transcripts, files, and video. The Route decides which messages to deliver to an Agent. Use `agent.send` for text, images, files, and native MP4 video, or find `manager.weixin.typing` to set or clear typing status.

Tencent's official client provides direct conversations and sends images, video, and files. See the [Tencent iLink protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md).

On replacement, the old instance cancels its long poll and waits for accepted messages to finish direct routing or enter the host queue. It saves the new cursor after admitting the entire batch. If replacement interrupts a batch, the old cursor and accepted conversation context are retained. The new instance reuses the stored login, resumes from that cursor, and skips messages already recorded by ID. Waiting for direct delivery uses the host's `forwardMessageWithCompletion` port.
