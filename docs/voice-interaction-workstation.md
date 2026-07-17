<!-- docs-language-switch -->
<div align="center">
<a href="./voice-interaction-workstation_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 语音交互工作站

> 成熟度：实验。通用 Webhook/FenneNote 入口和 Outbox 接线存在，但端到端语音设备、TTS 与角色体验仍需按环境验收。

这份说明用于把 RabiRoute、FenneNote 转录、角色对话和 OumuQ TTS 连接成一套可复用的语音交互工作站。它只描述公开安全的接口和工作流，不包含私聊日志、真实 QQ 号、token、cookie、个人路径、webhook 密钥或私有角色设定。

## 定位

RabiRoute 在这条链路里只做消息和事件路由：

```text
麦克风 / 语音消息
  -> FenneNote 转写 webhook
  -> RabiRoute 事件规范化 / 路由策略
  -> Codex 或其他 Agent runtime
  -> 角色对话结果
  -> 动作决策
  -> Codex 可见回复、QQ/NapCat 回复或 OumuQ TTS 播放
```

FenneNote 负责把语音变成文本；Codex 或下游 Agent 负责理解上下文、扮演角色和生成回复；OumuQ 负责把已确认的回复文本变成语音。RabiRoute 不替代这些系统，只负责接收事件、记录可审计上下文、选择处理端、套用提示模板、维护会话投递方式，并把外部动作放进安全门。

## 推荐事件模型

FenneNote 或其他转录端应向 RabiRoute 提交结构化 JSON。当前 adapter 实际读取 `type`、`id/messageId`、`source/sender`、`text/message/content/query/prompt/input/question`，以及可选 speaker、device、session 和时间字段：

```json
{
  "type": "voice_transcript",
  "id": "<stable-event-id>",
  "source": "fennenote",
  "text": "<recognized text>",
  "speakerName": "<display-name>",
  "speakerConfidence": 0.92,
  "sourceDeviceId": "<device-id>",
  "sessionId": "<session-id>",
  "startedAt": "2026-06-05T10:00:00+08:00",
  "endedAt": "2026-06-05T10:00:05+08:00"
}
```

`id` / `messageId` 会作为消息 ID 写入记录，但通用 FenneNote/Webhook adapter 当前没有持久化的全局 `eventId` 去重表；发送端仍应保证幂等或避免重复提交。`source` 只放公开安全的占位或运行期字段，不把真实账号写进示例或文档。

当前 adapter 不解析嵌套 `actionInstruction.replySurface`、`allowExternalSend` 或 `allowTts`。回复去向由 route 的 `pipelinePreset` / `pipeline`、`messageAdapterPolicies` 和 Agent 回传的 `replyContext`/明确目标决定：

- `outputAdapter=agent`：结果保留在 Agent 会话。
- `outputAdapter=fennenote`：Outbox 转发 reply 或 playback 请求。
- 明确 QQ/WeCom/RabiLink 来源或目标：进入对应 Outbox policy。
- 缺少明确 route/目标或 policy 禁止时：返回 `blocked`，并保留 draft 数据。

不要因为内容像聊天就自动发到 QQ；也不要因为来源是 `voice_transcript`，就忽略用户明确说出的“发到群里 / 发 QQ / 你直接发”。语音只是输入方式，真正外发仍需要明确目标并通过对应 route policy。

## RabiRoute 路由规则

语音转录使用 `voice_transcript` route kind。模板可读取转录文本、来源和 pipeline 输出意图；模板使用真实换行，避免字面量 `\n`：

```text
[RabiRoute 语音转写]
事件时间：{time}
路由类型：{routeKind}
输入端：{inputAdapter}
输出端：{outputAdapter}
输出模式：{promptOutputMode}
允许播放：{ttsPlay}
回复来源：{replyToSource}
语音来源：{voiceSource}

[转写内容]
{message}

[行动说明]
先读取 pipeline 输出端和当前回复上下文。
如果 outputAdapter 是 agent，请把结果保留在当前 Agent 会话。
如果 outputAdapter 是 fennenote，请生成符合角色语气、可交给 FenneNote/OumuQ 的可见文本和播放参数。
如果转写内容明确要求发送到 QQ/WeCom/RabiLink，请只在目标明确且对应消息端 policy 允许时调用回复 API；否则说明缺少的信息。
可见文本和朗读文本都要保持角色语气。
```

下游 Agent 需要拿到的不是“请回复一句话”，而是完整的决策材料：转录文本、事件来源、pipeline、`replyContext`、角色包路径和最近上下文日志。

## 角色对话和 TTS

角色模式的输出分两层：

- 可见文本：用户或聊天平台能看到的文字，必须完整保留角色语气。
- TTS 文本：交给 OumuQ 的朗读文本，通常从可见文本派生，只做发音、停顿或多语言轻微整理。

不要把可见文本写成普通 Agent 腔，再只让 TTS “演”角色。跨语言时也要保留角色身份、口吻和关系感，而不是把内容翻成中性的助手回复。若角色需要用另一种语言回应，先保持角色设定，再处理翻译。

建议下游 Agent 输出结构化草稿：

```json
{
  "visibleText": "<role-faithful reply>",
  "ttsText": "<role-faithful speech text>",
  "replySurface": "codex",
  "ttsProvider": "oumuq",
  "requiresApproval": false,
  "notes": "<internal routing notes, not for external chat>"
}
```

`notes` 只用于内部审计和调试，不能直接发给群聊或私聊。

## 外部动作安全

默认安全规则：

- 可以自动记录 webhook 原始事件、规范化事件和路由决策。
- 可以自动投递或引导 Codex/Agent 内部会话。
- 可以自动生成 Codex 可见回复草稿。
- 可以自动生成 OumuQ TTS 草稿或本地播放请求，前提是事件允许 TTS。
- QQ/NapCat、WeCom、RabiLink 和 FenneNote 外发都经过 Outbox 和消息端 policy。目标与内容明确且 policy 允许时可以发送；缺少目标或被 policy 禁止时返回 `blocked` 并附带 draft 数据。当前没有通用 WebGUI 审批队列。

提交到公开仓库前必须确认：

- 没有真实 QQ 号、群号、用户 ID、cookie、token、webhook secret、NapCat 管理地址或个人绝对路径。
- 没有私聊日志、音频原文、转录原文、角色私有记忆或用户画像。
- 示例使用 `<placeholder-...>`、`127.0.0.1`、`/path/to/project` 或 `C:/Path/To/Project`。
- 运行期目录如 `data/`、`logs/`、`tmp/`、`recordings/`、`transcripts/`、`voice-cache/` 保持不提交。

## 最小落地清单

1. FenneNote 配置 webhook，把每条语音转录提交为 `voice_transcript` 事件。
2. RabiRoute 记录 adapter 请求和规范化语音事件；发送端负责避免重复提交，RabiRoute 通用 webhook 当前不承诺 `eventId` 全局去重。
3. 在角色 `personaConfig.json` 中启用 `voice_transcript` 消息模板规则，模板使用实际存在的 pipeline 和 voice 变量。
4. RabiRoute 把事件投递给固定 Codex/Agent thread；空闲时 start，运行中 steer。
5. Agent 根据角色包生成 `visibleText` 和可选 `ttsText`，并严格遵守目标回复面。
6. OumuQ 只接收已经确认可朗读的 `ttsText`。
7. 外发必须经过 `/api/agent/replies` 和对应消息端 policy；信息不足时返回 `blocked`/draft 数据，由用户或上层流程补齐后重新提交。

上面是“每段转写直接成为 Agent 输入”的普通语音工作站。如果 FenneNote 只作为 RabiLink 主动智能的常驻观察源，应把它与 `rabilink` 放在承载 `RabiActive` 的同一条 Route，并将 `routeVariables.rabilinkRecordFirstSources` 设为 `fennenote`。此时转写仍会留普通日志，但只追加到统一会话账本，等待空闲/周期/触摸板审阅，不执行第 4 步的逐段直接投递。两种模式不要同时配置在不同 Route 上消费同一个 webhook。

## 三个分项目的交接边界

如果把这套工作站拆给多个高推理 agent 整理，建议按仓库边界分工：

- RabiRoute agent：维护事件模型、路由策略、模板、安全门和公开工作流文档。
- FenneNote agent：维护语音采集、转录质量、webhook payload 和重试/去重语义。
- OumuQ / role dialogue agent：维护角色语气、跨语言表现、TTS 文本规范和语音播放链路。

RabiRoute 文档只能描述这些系统的接口和约束，不提交其他仓库的实现、私有配置或运行期数据。
