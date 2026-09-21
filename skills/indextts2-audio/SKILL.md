---
name: indextts2-audio
description: 通过 RabiSpeech 的本地 IndexTTS2 模型生成中文或音色复刻语音。用户指定 IndexTTS2、中文参考音频、情绪/风格指令、人格声线或本地 WAV 验证时使用。不得直接运行技能内 worker、启动 OumuQ 或调用云端 API。
---

# RabiSpeech IndexTTS2

IndexTTS2 由 RabiSpeech 管理，模型 id 为 `local-tts/indextts2`。人格参考音频位于 `RabiRoute/data/roles/<RoleId>/voice/`，生成结果不得写回参考库。

## 流程

先读 [TTS 路由](../tts-router/SKILL.md)。`speechBaseUrl` 必须从当前服务配置取得；下例中的 `$speechBaseUrl` 由该发现步骤赋值。

1. 检查 `GET <speechBaseUrl>/v1/models/local-tts/indextts2`。
2. 传入 `voice=<RoleId>`；RabiSpeech 从人格 voice index 选择并缓存参考音频。
3. 需要情绪或语气时用 `instructions` 描述，保持简短、可执行。
4. 验证用 `play=false` 并保存返回 WAV；对话用 `play=true`、`session_id`，进入全局 FIFO。

```powershell
$body = @{
  model = 'local-tts/indextts2'
  input = '你好，这是 IndexTTS2 本地语音。'
  voice = '<RoleId>'
  response_format = 'wav'
  speed = 1.0
  language = 'zh'
  instructions = '自然、温和、清楚。'
  play = $false
} | ConvertTo-Json -Compress
Invoke-WebRequest -Method Post -Uri ($speechBaseUrl.TrimEnd('/') + '/v1/audio/speech') -ContentType 'application/json' -Body $body -OutFile '.\indextts2.wav'
```

不要从技能目录运行旧 `indextts2_worker.py`；模型环境、CUDA、参考音频组合和输出缓存统一属于 RabiSpeech。
