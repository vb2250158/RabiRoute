<!-- docs-language-switch -->
<div align="center">
<a href="./pipeline-presets_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Pipeline 预设说明

> 状态：Agent/Outbox 章节为现行指南。FenneNote/OumuQ 已于 2026-07-17 停止维护；新的语音链路使用 RabiSpeech 与 `speech` 消息端，旧字段只保留读取兼容。

Pipeline preset 是一层很薄的配置，用来把默认输入端和预期输出面配成一组。它不替代路由规则，也不替代 Agent adapter。路由仍然通过 `messageAdapters` 接收消息，把消息规范化为 RabiRoute 记录，渲染通知模板，再投递给配置好的 Agent adapter。

preset 只补充“这条路由希望如何输出”的意图，供模板和后续 output adapter 读取：

```json
{
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "inputAdapter": "speech",
    "outputAdapter": "tts",
    "outputPipeline": "rabispeech",
    "promptOutputMode": "voice_short",
    "ttsProvider": "local-tts",
    "ttsVoice": "Rabi",
    "ttsWorkerUrl": "http://127.0.0.1:8781/v1/audio/speech",
    "ttsPlay": true,
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

## 内置 preset

- `qq_chat`：NapCat 输入，QQ 输出意图，`qq_text` prompt 模式，允许回复当前来源通道，启用反馈环保护。
- `wecom_chat`：企业微信输入，企业微信输出意图，`markdown` prompt 模式，允许回复当前来源通道，启用反馈环保护。它主要面向企业微信群聊，模板变量保持和 NapCat 群聊尽量一致。
- `voice_chat`：RabiSpeech `speech` 输入，本地 TTS 输出，`voice_short` prompt 模式，启用播放和反馈环保护，不把回复回灌到麦克风输入。
- `webhook_task`：Webhook 输入，文件输出意图，Markdown prompt 模式。

每条路由都可以覆盖 `pipeline` 里的任意字段。没有配置 `pipelinePreset` 时使用 `legacy` fallback：`outputAdapter=agent`、`outputPipeline=agent`、`promptOutputMode=plain_text`。也就是说，没有明确外部目标时，回复保留在本地 Agent 会话，不会默认生成 QQ 草稿或自动外发。

## 模板变量

pipeline 字段会作为通知模板变量提供：

```text
{pipelinePreset} {channelPreset}
{inputAdapter} {outputAdapter} {outputPipeline} {promptOutputMode}
{ttsProvider} {ttsVoice} {ttsWorkerUrl} {ttsPlay}
{preventFeedbackLoop} {replyToSource}
{replyApiPath} {replyApiUrl} {replyContextJson}
```

可以用这些变量让 Agent 生成正确形态的输出：

- `promptOutputMode=voice_short`：适合朗读的短句，口语化表达，避免长列表。
- `promptOutputMode=qq_text`：适合聊天阅读的文本，可以使用换行。
- `promptOutputMode=markdown`：适合写入文件的 Markdown。
- `promptOutputMode=json`：给 webhook consumer 使用的结构化 JSON 或约定字段。

## Agent 回复回传

Agent 需要外部回传时应把回复 POST 到：

```text
POST /api/agent/replies
```

使用注入的 `replyContextJson` 作为 `replyContext`：

```json
{
  "text": "好的，我看到了。",
  "replyContext": {
    "routeProfileId": "main",
    "targetType": "group",
    "messageId": 123,
    "groupId": 456,
    "userId": 789,
    "instanceId": "default"
  }
}
```

如果 pipeline 使用 `qq`、`wecom`、`tts`，或者请求带有明确来源/目标，Outbox 会进入相应消息端；否则 legacy `agent` 输出只记录“结果保留在 Agent 会话”。自动发送仍经过对应 `messageAdapterPolicies`。NapCat 使用 `messageAdapterPolicies.napcat`，企业微信使用 `messageAdapterPolicies.wecom`，本机语音使用 `messageAdapterPolicies.speech`。

旧配置如果手写了 `allowedGroups` / `allowedUsers`、`outputMode`、`enabledPipelines` 或 `disabledPipelines`，这些具体过滤字段不再生效。发送关闭或消息类型不在 `supportedOutputs` 内时，会返回 `blocked`，不会调用对应消息端。

允许发送时，RabiRoute 使用对应消息端的发送封装：NapCat 调用 OneBot HTTP，企业微信调用智能机器人 SDK。请求可以是旧的纯文本 `text/message/content`，也可以传 `payloadType=image|voice|file` 搭配 `imageUrl/imagePath`、`voiceUrl/voicePath`、`fileUrl/filePath` 等字段。NapCat 群聊的本地 `filePath` 会经过 `allowedFileRoots` 校验后调用 `upload_group_file`；上传成功后再发送可选的引用说明文本，说明文本失败不会把已经上传的文件误判为整体失败并重复上传。回复请求、成功、失败、草稿和拦截记录都会写入路由数据目录下的 `outbox-adapter.log.jsonl`。

企业微信群聊回传推荐带上 `replyContextJson` 中的 `adapterType=wecom`、`groupId`、`wecomReqId`、`wecomConversationId` 和 `wecomChatId`。没有 `reqId` 但有明确 `groupId` / `chatId` 时，RabiRoute 可按主动发送处理；缺少明确目标时返回 `blocked` 并附带 draft 数据。

## RabiSpeech 语音消息端

来自 `speech` 消息端的 `voice_transcript` 会在 `AgentPacket` 中强制解析成 `voice_chat`，即使 Route 的通用 preset 仍是 QQ 或 Agent session。回复上下文包含 `characterTtsDialogue=true`；Agent 必须把与屏幕文本同义的语音短句 POST 到 `/api/agent/replies`，不能只在 Codex 线程里显示文字。

Outbox 会重新验证来源记录与 `messageAdapterPolicies.speech`，把 Route 的人格 ID、播放策略与原始 `sessionId` 传给本机 `POST /v1/audio/speech`。RabiSpeech 从 `data/roles/<RoleId>/voice/voice-profile.json` 读取 TTS 模型、声线、语言、语速和表达指令；旧 Route TTS 字段只在缺少人格配置时作为兼容回退。`speechAutoPlay=true` 表示生成结果进入主机级 FIFO；接口成功只代表请求或队列已受理，不代表扬声器已经播放完毕。

FenneNote/OumuQ 输出字段和 `/api/fennenote/*` 仅供旧运行配置迁移，不是新语音 Route 的实现入口，也不得重新引入云端 TTS。
