<!-- docs-language-switch -->
<div align="center">
<a href="./voice-interaction-workstation_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 语音交互工作站

语音采集、转写、角色声线与播放统一使用 RabiSpeech。FenneNote 与 OumuQ 已停止维护，旧版的转写 webhook、独立播放服务和接线教程不再作为配置入口。

1. 在“语音服务”选择服务器、ASR/TTS 模型并确认模型可用；麦克风、切句与阈值由该服务维护。
2. 在消息路线启用“语音消息端”，按需要选择热投递或角色关键词唤醒。普通手动 ASR API 只返回结果，不自动通知 Agent。
3. 在“角色配置 → 自动化 → 消息规则”中使用“语音服务”分组维护 `voice_transcript` 规则。
4. 角色声线由角色目录的 `voice/voice-profile.json` 维护。回复和任务完成播报使用统一 TTS 与主机播放队列。

配置与验收以以下文档为准：

- [语音服务与模型](rabispeech-plugin.md)：配置模型、声线、录音和播放，核对服务及实际音频。
- [语音消息端](speech-message-endpoint-design.md)：路线订阅、热投递、关键词与消息记录边界。
- [语音 API](user-guide/speech-api.md)：从已鉴权客户端调用语音服务。

历史转写记录保留原来源标识，便于查询和追溯；来源名称不表示旧服务仍在运行。已有语音规则应保留，不能通过删除 `voice_transcript` 规则来清理旧界面标签。
