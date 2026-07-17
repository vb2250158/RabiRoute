<!-- docs-language-switch -->
<div align="center">
<a href="./pipeline-presets_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Pipeline 预设说明

> 状态：现行指南。默认 `agent_session` 会把无明确外部目标的结果保留在 Agent 会话；通用审批队列尚未实现。

Pipeline preset 是一层很薄的配置，用来把默认输入端和预期输出面配成一组。它不替代路由规则，也不替代 Agent adapter。路由仍然通过 `messageAdapters` 接收消息，把消息规范化为 RabiRoute 记录，渲染通知模板，再投递给配置好的 Agent adapter。

preset 只补充“这条路由希望如何输出”的意图，供模板和后续 output adapter 读取：

```json
{
  "pipelinePreset": "voice_chat",
  "pipeline": {
    "inputAdapter": "webhook",
    "outputAdapter": "fennenote",
    "outputPipeline": "fennenote",
    "promptOutputMode": "voice_short",
    "ttsProvider": "oumuq",
    "ttsVoice": "cloud_zh_voice",
    "ttsWorkerUrl": "http://127.0.0.1:8793/api/fennenote/playback",
    "ttsPlay": true,
    "preventFeedbackLoop": true,
    "replyToSource": false
  }
}
```

## 内置 preset

- `qq_chat`：NapCat 输入，QQ 输出意图，`qq_text` prompt 模式，允许回复当前来源通道，启用反馈环保护。
- `wecom_chat`：企业微信输入，企业微信输出意图，`markdown` prompt 模式，允许回复当前来源通道，启用反馈环保护。它主要面向企业微信群聊，模板变量保持和 NapCat 群聊尽量一致。
- `voice_chat`：Webhook/FenneNote 输入，FenneNote 输出端点，`voice_short` prompt 模式，启用播放和反馈环保护，不自动回复输入来源通道。
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

如果 pipeline 使用 `qq`、`wecom`、`fennenote`，或者请求带有明确来源/目标，Outbox 会进入相应消息端；否则 legacy `agent` 输出只记录“结果保留在 Agent 会话”。自动发送仍经过对应 `messageAdapterPolicies`。NapCat 使用 `messageAdapterPolicies.napcat`，企业微信使用 `messageAdapterPolicies.wecom`。默认策略建议是 `inputEnabled=true`、`outputEnabled=true`，允许 Agent 通过 RabiRoute 主动发送到明确的群聊或私聊目标。

旧配置如果手写了 `allowedGroups` / `allowedUsers`、`outputMode`、`enabledPipelines` 或 `disabledPipelines`，这些具体过滤字段不再生效。发送关闭或消息类型不在 `supportedOutputs` 内时，会返回 `blocked`，不会调用对应消息端。

允许发送时，RabiRoute 使用对应消息端的发送封装：NapCat 调用 OneBot HTTP，企业微信调用智能机器人 SDK。请求可以是旧的纯文本 `text/message/content`，也可以传 `payloadType=image|voice|file` 搭配 `imageUrl/imagePath`、`voiceUrl/voicePath`、`fileUrl/filePath` 等字段。NapCat 群聊的本地 `filePath` 会经过 `allowedFileRoots` 校验后调用 `upload_group_file`；上传成功后再发送可选的引用说明文本，说明文本失败不会把已经上传的文件误判为整体失败并重复上传。回复请求、成功、失败、草稿和拦截记录都会写入路由数据目录下的 `outbox-adapter.log.jsonl`。

企业微信群聊回传推荐带上 `replyContextJson` 中的 `adapterType=wecom`、`groupId`、`wecomReqId`、`wecomConversationId` 和 `wecomChatId`。没有 `reqId` 但有明确 `groupId` / `chatId` 时，RabiRoute 可按主动发送处理；缺少明确目标时返回 `blocked` 并附带 draft 数据。

## FenneNote 端点

RabiRoute 不合成音频。对于 `voice_chat`，Codex 或其他 Agent 生成播放请求对象。RabiRoute 不解释 text、language、emotion vector、model、character id 等语音字段，只把对象转发给 FenneNote。FenneNote 负责 guard 处理、speaker 状态记录，以及最终 OumuQ/worker 调用。

RabiRoute manager 暴露两个 FenneNote 输出端点：

```text
POST /api/fennenote/playback
POST /api/fennenote/reply
```

`/api/fennenote/playback` 接收 Codex 希望 FenneNote 处理的原始请求对象，例如：

```json
{
  "text": "<speech text>",
  "play": true,
  "character_id": "tamamo_no_mae",
  "language": "auto",
  "emotion_vector": [0.2, 0.1, 0.0]
}
```

RabiRoute 会把这个包转发到 FenneNote 本地端点，通常是 `http://127.0.0.1:8793/api/fennenote/playback`。`/api/fennenote/reply` 会把文本回复包转发到 `http://127.0.0.1:8793/api/fennenote/reply`。公开路由示例里不要放真实 voice ID、API key、私有参考音频或非本地 URL。

为了降低延迟，Codex 应在同一个包里继续发送期望的 `model`、`character_id`、`language`、emotion 字段和可选 `worker_url`。RabiRoute 不切换模型。FenneNote 会比较请求的播放目标和当前 active target，完成本地 guard 记录，在存在 `worker_url` 时探测目标 worker，然后把原始包转发给 OumuQ。后续如果 OumuQ worker-management API 成熟，可以把这套流程扩展为真正的预启动/预加载。
