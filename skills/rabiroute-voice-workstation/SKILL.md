---
name: rabiroute-voice-workstation
description: 设计、实现或审查 RabiPC 语音消息端与 RabiSpeech 本地 TTS/ASR 工作站。覆盖麦克风 RMS 阈值、静音切段、模型与参数查询、直接人格 TTS、可选 Route/Agent 提交、RabiLink 中转、全局 FIFO 播放和公开安全边界。不得再接入 FenneNote、OumuQ 或付费云端语音 API。
---

# RabiPC 语音工作站

## 系统边界

```text
浏览器麦克风 / 音频文件 / HTTP 客户端
  -> RabiPC 语音消息端
  -> RabiSpeech 本地 TTS / ASR
  -> 可选 RabiRoute Route / Agent
  -> RabiSpeech 主机级 FIFO 播放
```

RabiSpeech 的普通 TTS/ASR API 不接入 Agent。只有用户显式选择 Route 并提交转写时，`POST /api/speech/messages` 才创建 `voice_transcript` 事件。

## 活跃接口

底层本地服务：`http://127.0.0.1:8781`

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/<provider>/<model>`
- `GET /v1/capabilities`
- `POST /v1/audio/speech`
- `POST /v1/audio/transcriptions`
- `GET /v1/playback/status`
- `POST /v1/playback/stop`

RabiRoute Manager 同源代理：`http://127.0.0.1:8790`

- `GET /api/speech/status`
- `GET /api/speech/models`
- `GET /api/speech/personas`
- `POST /api/speech/tts`
- `POST /api/speech/asr`
- `POST /api/speech/messages`

模型列表的每一项都要返回方法、endpoint、Content-Type、必填字段、可选参数和示例。调用方不得靠写死表格猜当前模型能力。

## 麦克风常驻转写

- 只在用户主动开启后获取浏览器麦克风权限。
- 计算 PCM RMS，低于声音阈值时不触发新语段。
- 保留短前置缓冲，避免吞掉句首。
- 说话后按静音时长切段，同时设置最短与最长语段保护。
- ASR 请求顺序处理，避免多个 GPU 大模型争用显存。
- RabiSpeech 播放队列活跃时暂停麦克风触发，防止 TTS 回录形成反馈环。
- 自动提交 Route 默认可关闭；手动 ASR 和直接人格 TTS 不要求 Route 或 Agent。

## 人格与播放

人格资料属于 `data/roles/<RoleId>`。`persona.md` 是人格真相源；声音参考、缓存和台词索引属于 `voice/`。只知道人格名时也能直接调用 TTS。

RabiSpeech 是唯一播放所有者。所有 Route、会话、Agent、人格和模型的完成音频进入同一个 FIFO；不得让下游 worker 或浏览器另起并发播放器。

## RabiLink 中转

Relay 只代理 allowlist 内的原始请求/响应，并使用通用应用 token。远端请求不能加载 Python 模块、修改模型 allowlist、下载模型或读取本机任意文件。只暴露规范化语音 API 和 OpenAPI，不暴露 worker 端口、模型路径或参考音频路径。

## 动作安全

- 本地 TTS/ASR、模型查询和播放属于语音服务动作，不意味着 QQ/NapCat 外发。
- Route 提交必须由用户选择目标 Route；外部消息发送仍经过 RabiRoute Action Gate。
- 不记录或公开 token、真实 Relay URL、私聊转写、录音、人格私有材料、模型权重和绝对路径。

## 验证

至少验证：

1. RabiSpeech `/health` 与模型列表。
2. 一个直接人格 TTS WAV。
3. 一个真实音频 ASR 请求。
4. Manager TTS/ASR 代理。
5. 播放状态和停止接口。
6. WebGUI 构建与语音消息端主要控件。
7. 未选择 Route 时不会接入 Agent；选择 Route 后才允许提交。
