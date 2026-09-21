---
name: qwen-tts-audio
description: 通过 RabiSpeech 使用本地 Qwen3-TTS 0.6B 或 1.7B 生成人格、多语言或音色复刻语音。用户指定 Qwen3-TTS、日语/多语言、本地参考音频、人格名或模型大小对比时使用。不得启动技能内 worker、OumuQ 或任何 Qwen/DashScope 云端 API。
---

# RabiSpeech Qwen3-TTS

可用模型：

- `local-tts/qwen3-tts-0.6b-base`：显存和冷启动较低，适合常规多语言对话。
- `local-tts/qwen3-tts-1.7b-base`：更大的本地模型，质量优先时选择。

## 流程

先读 [TTS 路由](../tts-router/SKILL.md)。`speechBaseUrl` 必须从当前服务配置取得；下例中的 `$speechBaseUrl` 由该发现步骤赋值。

1. 查询 `GET <speechBaseUrl>/v1/models`，确认模型已安装。
2. 把 Rabi 人格目录名作为 `voice`；每次请求显式发送，不能继承上一会话角色。
3. 使用 `language` 指定目标语音语言，使用 `instructions` 提供简短风格/情绪说明。
4. 对话用 `play=true` 和 `session_id`；测试用 `play=false` 保存 WAV。

```powershell
$body = @{
  model = 'local-tts/qwen3-tts-0.6b-base'
  input = 'こんばんは。これはローカル音声テストです。'
  voice = '<RoleId>'
  response_format = 'wav'
  language = 'ja'
  instructions = '自然で落ち着いた会話調。'
  play = $false
} | ConvertTo-Json -Compress
Invoke-WebRequest -Method Post -Uri ($speechBaseUrl.TrimEnd('/') + '/v1/audio/speech') -ContentType 'application/json' -Body $body -OutFile '.\qwen3-tts.wav'
```

模型加载、参考音频选择、缓存和 worker 生命周期全部由 RabiSpeech 管理。
