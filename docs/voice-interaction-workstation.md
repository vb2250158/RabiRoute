# Voice Interaction Workstation

这份说明用于把 RabiRoute、FenneNote 转录、角色对话和 OumuQ TTS 连接成一套可复用的语音交互工作站。它只描述公开安全的接口和工作流，不包含私聊日志、真实 QQ 号、token、cookie、个人路径、webhook 密钥或私有角色设定。

## 定位

RabiRoute 在这条链路里只做消息和事件路由：

```text
Microphone / voice message
  -> FenneNote transcript webhook
  -> RabiRoute event normalize / route policy
  -> Codex or another Agent runtime
  -> role dialogue result
  -> action decision
  -> Codex visible reply, QQ/NapCat reply, or OumuQ TTS playback
```

FenneNote 负责把语音变成文本；Codex 或下游 Agent 负责理解上下文、扮演角色和生成回复；OumuQ 负责把已确认的回复文本变成语音。RabiRoute 不替代这些系统，只负责接收事件、记录可审计上下文、选择处理端、套用提示模板、维护会话投递方式，并把外部动作放进安全门。

## 推荐事件模型

FenneNote 或其他转录端应向 RabiRoute 提交结构化 webhook，而不是只提交一段散文：

```json
{
  "platform": "fenne-note",
  "eventType": "voice_transcript",
  "eventId": "<stable-event-id>",
  "createdAt": "2026-06-05T10:00:00+08:00",
  "source": {
    "channel": "codex",
    "chatType": "local",
    "chatId": "<placeholder-chat-id>",
    "senderId": "<placeholder-user-id>",
    "senderName": "<display-name>"
  },
  "transcript": {
    "text": "<recognized text>",
    "language": "zh-CN",
    "confidence": 0.92
  },
  "actionInstruction": {
    "replySurface": "codex",
    "allowExternalSend": false,
    "allowTts": true
  }
}
```

`eventId` 用于去重。`source` 只放公开安全的占位或运行期字段，不把真实账号写进示例或文档。`actionInstruction.replySurface` 是关键字段，它决定回复应该回到哪里：

- `codex`：在当前 Codex/Agent 会话中回复，不走 QQ/NapCat。
- `qq`：生成待发 QQ/NapCat 回复；默认进入 draft，只有获得授权后才发送。
- `tts`：生成可朗读文本并交给 OumuQ；是否同时显示文本由调用端决定。
- `none`：只记录或触发内部整理，不生成对外回复。

如果事件来自 Codex/FenneNote 语音输入，必须先读 `actionInstruction` 和转写文本里的显式指令。不要因为内容像聊天，就自动发到 QQ；也不要因为来源是 `voice_transcript`，就把用户明确说出的“发到群里 / 发 QQ / 你直接发”一律降级成本地回复。语音只是输入方式，不等于禁止外发。

## RabiRoute 路由规则

语音转录建议使用 `voice_transcript` route kind，并把转录文本、来源、目标回复面和安全授权显式写入模板。模板可以使用真实换行，避免字面量 `\n`：

```text
[RabiRoute voice transcript]
Event time: {time}
Route kind: {routeKind}
Reply surface: {replySurface}
External send allowed: {allowExternalSend}
TTS allowed: {allowTts}
Source channel: {sourceChannel}

[Transcript]
{message}

[Instruction]
Read the reply surface before acting.
If replySurface is codex, answer in the current Codex conversation.
If replySurface is qq, prepare a draft QQ/NapCat reply unless explicit approval is present.
If replySurface is tts, produce role-faithful visible text that can be sent to OumuQ.
If the transcript itself clearly asks to send to QQ/NapCat, treat that as an external-send request and follow the existing send or draft-and-approval flow.
Keep the role voice in visible text and in speech text.
```

下游 Agent 需要拿到的不是“请回复一句话”，而是完整的决策材料：转录文本、事件来源、目标回复面、是否允许外发、是否允许 TTS、角色包路径和最近上下文日志。

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
- QQ/NapCat 群发、私聊、写外部系统和修改角色私有数据默认都要经过安全门。语音里已经明确给出目标、内容和发送授权时，可以进入现有发送流程；缺少目标、内容或权限时才生成 draft 并等待确认。

提交到公开仓库前必须确认：

- 没有真实 QQ 号、群号、用户 ID、cookie、token、webhook secret、NapCat 管理地址或个人绝对路径。
- 没有私聊日志、音频原文、转录原文、角色私有记忆或用户画像。
- 示例使用 `<placeholder-...>`、`127.0.0.1`、`/path/to/project` 或 `C:/Path/To/Project`。
- 运行期目录如 `data/`、`logs/`、`tmp/`、`recordings/`、`transcripts/`、`voice-cache/` 保持不提交。

## 最小落地清单

1. FenneNote 配置 webhook，把每条语音转录提交为 `voice_transcript` 事件。
2. RabiRoute 记录原始事件和规范化事件，并用 `eventId` 去重。
3. 在角色 `roleMessageConfig.json` 中启用 `voice_transcript` 消息模板规则，模板包含 `replySurface`、`allowExternalSend` 和 `allowTts`。
4. RabiRoute 把事件投递给固定 Codex/Agent thread；空闲时 start，运行中 steer。
5. Agent 根据角色包生成 `visibleText` 和可选 `ttsText`，并严格遵守目标回复面。
6. OumuQ 只接收已经确认可朗读的 `ttsText`。
7. QQ/NapCat 外发必须经过 action safety gate；语音指令已经明确授权且信息完整时可以发送，信息不足时先 draft，获得确认后再 commit。

## 三个分项目的交接边界

如果把这套工作站拆给多个高推理 agent 整理，建议按仓库边界分工：

- RabiRoute agent：维护事件模型、路由策略、模板、安全门和公开工作流文档。
- FenneNote agent：维护语音采集、转录质量、webhook payload 和重试/去重语义。
- OumuQ / role dialogue agent：维护角色语气、跨语言表现、TTS 文本规范和语音播放链路。

RabiRoute 文档只能描述这些系统的接口和约束，不提交其他仓库的实现、私有配置或运行期数据。
