# WeChat Bot

[中文](README.md)

Open **Route → Message endpoints → WeChat Bot** and choose **Connect** to show the QR code. Confirm on your phone. The gear opens settings for this channel. To invite someone else, choose the invitation action and follow the identity or PIN prompt on the phone. Sign out from the same card.

The Tencent iLink integration receives text, quotes, images, voice and transcripts, files, and video. The Route decides which messages to deliver to an Agent. Use `agent.send` for text, images, files, and native MP4 video, or find `manager.weixin.typing` to set or clear typing status.

Tencent's official client provides direct conversations and sends images, video, and files. See the [Tencent iLink protocol](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md).

On replacement, the old instance cancels its long poll and waits for accepted messages to finish direct routing or enter the host queue. It saves the new cursor after admitting the entire batch. If replacement interrupts a batch, the old cursor and accepted conversation context are retained. The new instance reuses the stored login, resumes from that cursor, and skips messages already recorded by ID. Waiting for direct delivery uses the host's `forwardMessageWithCompletion` port.
