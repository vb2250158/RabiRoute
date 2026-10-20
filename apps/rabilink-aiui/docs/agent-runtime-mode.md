[English](agent-runtime-mode_en.md) | 简体中文

# AIUI 模型执行归属

对话始终由眼镜页面的乐奇原生 `LanguageModel` 执行；设备凭据、角色和 PC 连接不改变执行者。角色提供 Skill 与提示词，不限制 API 权限。PC 保存消息队列和回执，手机仅转发唤醒请求。

`mode=transcription` 与 `mode=configuration` 只选择同一页面的操作状态。旧远端观察模式、语音上传队列和回复播报队列已退役；现有本地旧记录不再读取，也不删除用户数据。新投递统一走 [deviceAgent](device-agent.md)，不启动第二模型或静默换执行者。
