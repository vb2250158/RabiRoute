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
{sendApiPath} {sendApiUrl} {sendRequestJson}
```

可以用这些变量让 Agent 生成正确形态的输出：

- `promptOutputMode=voice_short`：适合朗读的短句，口语化表达，避免长列表。
- `promptOutputMode=qq_text`：适合聊天阅读的文本，可以使用换行。
- `promptOutputMode=markdown`：适合写入文件的 Markdown。
- `promptOutputMode=json`：给 webhook consumer 使用的结构化 JSON 或约定字段。

## Agent 明确发送

Agent 需要外部回传时应把回复 POST 到：

```text
POST /api/agent/send
```

使用注入的 `sendRequestJson` 作为请求模板。下面以 NapCat 群聊为例：

```json
{
  "deliveryId": "qq-group-456-message-123",
  "routeId": "main",
  "channel": "napcat",
  "params": {
    "target": "group",
    "groupId": "456",
    "instanceId": "default",
    "replyToMessageId": "123"
  },
  "payload": { "type": "text", "text": "好的，我看到了。" }
}
```

`channel` 决定唯一发送渠道，`params` 决定该渠道的具体目标；Route 的默认 pipeline 不再替请求猜测或改写渠道。发送仍经过对应 `messageAdapterPolicies`。NapCat 使用 `messageAdapterPolicies.napcat`，企业微信使用 `messageAdapterPolicies.wecom`，本机语音使用 `messageAdapterPolicies.speech`。

旧配置如果手写了 `allowedGroups` / `allowedUsers`、`outputMode`、`enabledPipelines` 或 `disabledPipelines`，这些具体过滤字段不再生效。发送关闭或消息类型不在 `supportedOutputs` 内时，会返回 `blocked`，不会调用对应消息端。

允许发送时，RabiRoute 使用对应消息端的发送封装：NapCat 调用 OneBot HTTP，企业微信调用智能机器人 SDK。`payload.type` 支持 `text|image|voice|file`；非文本内容必须在 `payload.path` 或 `payload.url` 中给出来源。NapCat 群聊的本地文件会经过 `allowedFileRoots` 校验后调用 `upload_group_file`；上传成功后再发送可选说明文本，说明文本失败不会把已经上传的文件误判为整体失败并重复上传。发送请求、成功、失败、草稿和拦截记录都会写入路由数据目录下的 `outbox-adapter.log.jsonl`。

企业微信群聊发送必须使用 `channel=wecom`，并在 `params.chatId` 中填写目标群。若需要引用当前企业微信回调，可同时传 `params.reqId`；没有 `reqId` 时按主动发送处理。缺少明确 `chatId` 时请求会被拒绝。

## RabiSpeech 语音消息端

来自 `speech` 消息端的 `voice_transcript` 会在 `AgentPacket` 中强制解析成 `voice_chat`，即使 Route 的通用 preset 仍是 QQ 或 Agent session。来源上下文包含 `characterTtsDialogue=true`，同时注入 `channel=speech` 和对应 `sessionId` 的发送模板；Agent 必须把与屏幕文本同义的语音短句 POST 到 `/api/agent/send`，不能只在 Codex 线程里显示文字。

Outbox 会重新验证来源记录与 `messageAdapterPolicies.speech`，把 Route 的人格 ID、播放策略与原始 `sessionId` 传给本机 `POST /v1/audio/speech`。RabiSpeech 从 `data/roles/<RoleId>/voice/voice-profile.json` 读取 TTS 模型、声线、语言、语速和表达指令；旧 Route TTS 字段只在缺少人格配置时作为兼容回退。`speechAutoPlay=true` 表示生成结果进入主机级 FIFO；接口成功只代表请求或队列已受理，不代表扬声器已经播放完毕。

FenneNote/OumuQ 输出字段和 `/api/fennenote/*` 仅供旧运行配置迁移，不是新语音 Route 的实现入口，也不得重新引入云端 TTS。
